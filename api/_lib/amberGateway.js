// The single logical place that talks to Amber. Every outbound Amber
// request — from every user, every tab, every deployed instance — goes
// through fetchAmber() below, which is cache-first, cooldown-aware,
// stampede-locked and budget-enforced before it ever touches the network.
const { sharedGet, sharedSet, tryReserveSlot, reserveSlot, peekRecentRequestCount, acquireLock, releaseLock, RedisUnavailableError, log } = require("./sharedStore");

const PARTNER_ID = "ivy-huts-707a5cdf";
const BASE_URL = `https://base.amberstudent.com/api/v0/leads/partners/${PARTNER_ID}`;

// Amber's hard limit is 10/minute with a 5-minute halt on violation. We stay
// well under that — configurable, defaulting conservatively below the limit
// because other environments/consumers may share the same partner quota.
const RATE_BUDGET_PER_MINUTE = Number(process.env.AMBER_MAX_REQUESTS_PER_MINUTE) || 6;
const RATE_WINDOW_MS = 60_000;
const DEFAULT_COOLDOWN_MS = 5 * 60_000; // Amber's documented halt — used whenever it doesn't tell us otherwise

// A small, separate allowance reserved exclusively for the /insight catalog
// crawl (api/_lib/insightsMarket.js), on top of the RATE_BUDGET_PER_MINUTE
// pool everyone else shares. The main budget is plain first-come-first-served
// with no real priority queue underneath — "LOW priority" only changes what
// happens after losing that race (skip quietly instead of erroring), so on a
// day with steady real traffic the crawl can lose every single race and make
// zero progress for as long as that traffic keeps up (confirmed live: stuck
// at the same page for 15+ minutes straight). This reserve guarantees the
// crawl a small amount of forward progress every minute regardless of real
// traffic, without ever taking capacity away from real users — worst-case
// combined Amber traffic becomes RATE_BUDGET_PER_MINUTE + this value
// (6 + 2 = 8/min by default), still safely under Amber's documented 10/min
// hard limit.
const CRAWL_RESERVED_BUDGET_PER_MINUTE = Number(process.env.AMBER_CRAWL_RESERVED_PER_MINUTE) || 2;
const CRAWL_RESERVED_KEY = "amber:requests:crawl-reserved";
function isCrawlSource(source) {
    return typeof source === "string" && source.startsWith("insights-market-crawl");
}

// Amber cold responses have been observed taking up to ~13.7s in production —
// but confirmed Vercel Preview runtime evidence (Milestone 3C) showed a real
// Amber upstream request that was STILL in flight at the full 20s mark,
// which our own AbortController then aborted, producing a 504 the user only
// had to reload past. 20s was therefore demonstrated to be too tight against
// Vercel's own 30s function ceiling (vercel.json's maxDuration). 25s leaves
// ~5s of headroom inside that 30s ceiling for the surrounding work a request
// still needs after Amber responds (JSON parsing, the Redis cache write(s),
// response serialization, network overhead) — enough to allow the confirmed
// real Amber duration through without being unbounded or crowding out that
// trailing work. Configurable so it can be tuned from real data without a
// code change.
const AMBER_FETCH_TIMEOUT_MS = Number(process.env.AMBER_FETCH_TIMEOUT_MS) || 25_000;

// Below this much remaining time in a request's shared upstream deadline (see
// fetchListings' deadlineAt), don't even attempt a fresh Amber call — it has
// no realistic chance of completing and would still cost a budget slot for
// nothing. Only matters for fetchListings' fallback leg; a normal single-call
// request always starts with the full AMBER_FETCH_TIMEOUT_MS available, so
// this floor is essentially never reached outside that fallback path.
// Proportional to AMBER_FETCH_TIMEOUT_MS (10%, floor 500ms) rather than a
// fixed absolute — an absolute floor could exceed a smaller configured
// timeout entirely, making every single-call request fail immediately.
const MIN_AMBER_ATTEMPT_MS = Math.max(500, Math.round(AMBER_FETCH_TIMEOUT_MS * 0.1));

// Must safely outlive one full AMBER_FETCH_TIMEOUT_MS attempt plus a margin
// for the surrounding work (reserving budget, writing the result to the
// cache) — otherwise the lock can expire while its holder is still
// legitimately mid-fetch, letting a second caller acquire it and also call
// Amber for the same key (a duplicate-upstream-request bug, not just
// wasted budget). Not unbounded: if a holder genuinely hangs past this, the
// lock frees up rather than staying stuck forever.
const LOCK_TTL_MS = AMBER_FETCH_TIMEOUT_MS + 5_000;

// How long a lock LOSER waits for the winner before giving up and falling
// back to stale data (or a clean 503). Increasing backoff, not a busy-loop.
// Total (~7.1s) is deliberately kept under typical serverless execution
// budgets (conservatively assuming as little as ~10s on some Vercel plans —
// see vercel.json's maxDuration note) so a LOSING request — which may be a
// real waiting user, not just a background refresh — always gets a chance to
// return its own clean response instead of being killed mid-poll. This is
// intentionally shorter than LOCK_TTL_MS/AMBER_FETCH_TIMEOUT_MS: a loser is
// not trying to outlast the winner's worst case, just to catch the common
// case where the winner finishes within a few seconds, and to fail gracefully
// (never call Amber itself) when it doesn't.
const LOCK_POLL_INTERVALS_MS = [300, 500, 800, 1200, 1800, 2500];

const COOLDOWN_KEY = "amber:cooldownUntil";

// ── Local in-memory shadow cache — VALUES ONLY, never lock/budget state. ──
// A safety net for when Redis is *configured* but flaky/unreachable at a
// given moment (RedisUnavailableError) — a different case from
// REDIS_AVAILABLE===false (sharedStore.js's own separate, already-safe
// fallback for "not configured at all"). Without this, one failed cache
// WRITE guaranteed the very next request for that same key would ALSO miss:
// cache miss -> Amber -> write fails -> next request -> miss again -> Amber
// again -> ... — for every request, defeating caching entirely and burning
// through the shared per-minute Amber budget on pure repeats of the same
// city. (Confirmed live: CACHE_WRITE_FAILED_REDIS_UNAVAILABLE logged
// repeatedly for the same handful of cities, each one a real upstream call.)
//
// Deliberately NOT used for acquireLock/tryReserveSlot — see fetchAmber()'s
// own comment below for why falling back to memory for THOSE in a real
// multi-instance deployment would multiply Amber traffic instead of
// preventing it. A slightly-stale cached VALUE served from one instance's
// local memory instead of Redis's shared copy carries no such risk — it's
// the same "serve stale, never fabricate" tradeoff this file already makes
// everywhere else, just also covering the "Redis itself is the failure"
// case, not only "Amber is the failure."
const SHADOW_CACHE_MAX_ENTRIES = 500;
const shadowCache = new Map(); // cacheKey -> { data, cachedAt }

function shadowCacheGet(key) {
    return shadowCache.get(key);
}

function shadowCacheSet(key, entry) {
    shadowCache.delete(key); // re-insert at the end for simple LRU-ish ordering
    shadowCache.set(key, entry);
    if (shadowCache.size > SHADOW_CACHE_MAX_ENTRIES) {
        shadowCache.delete(shadowCache.keys().next().value); // evict oldest
    }
}

// Server-side retention per data type. maxAgeSeconds is the number that
// actually matters for correctness: it must be >= the matching client-side
// staleMs in src/services/amberApi.js's CLIENT_TTL, with a buffer, or the
// server would force a real Amber refetch before the client's own SWR window
// even considers its copy stale — defeating the client cache's purpose.
// freshSeconds only changes the reported cacheStatus label (HIT vs STALE);
// both avoid a real Amber call, so it's not safety-critical the way
// maxAgeSeconds is.
const TTL = {
    listings: { freshSeconds: 2 * 60, maxAgeSeconds: 50 * 60 }, // client stale=45min + 5min buffer
    detail: { freshSeconds: 5 * 60, maxAgeSeconds: 65 * 60 }, // client stale=60min + 5min buffer
    citystats: { freshSeconds: 60 * 60, maxAgeSeconds: 25 * 60 * 60 }, // client stale=24h + 1h buffer
};

// `code` is a stable machine-readable reason (distinct from the HTTP
// `status`, since e.g. both "lock busy" and "Redis unreachable" are 503 but
// are very different conditions) — api/amber.js surfaces it to the frontend
// so callers can distinguish, where practical: Amber's own cooldown vs our
// own budget cap vs a concurrent in-progress refresh vs the cache backend
// being down vs a raw upstream error, without any UI change being required.
class AmberGatewayError extends Error {
    constructor(message, status, retryAfterSeconds, code) {
        super(message);
        this.status = status || 502;
        this.retryAfterSeconds = retryAfterSeconds || null;
        this.code = code || null;
    }
}

// ── Canonical cache keys: same logical request must produce the same key
// regardless of query-param order, casing, or whitespace. ──
function normalizeCityName(city) {
    return String(city || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function buildCacheKey(type, params) {
    if (type === "detail") return `amber:detail:${String(params.slug || "").trim().toLowerCase()}`;
    if (type === "citystats") return `amber:citystats:${normalizeCityName(params.city)}`;
    // listings
    const city = normalizeCityName(params.city);
    const page = Number(params.page) || 1;
    // Clamped to Amber's own 50/page cap, same as buildAmberUrl() below —
    // this key represents ONE raw Amber page, and two callers requesting the
    // same page of the same city always get the exact same raw Amber
    // response regardless of how many TOTAL results either caller ultimately
    // wants (Milestone 6 fix: a live user search, limit:50, and
    // accommodationIndex.js's refreshCityIndex(), limit:150 as of this
    // milestone, must share this page's cache entry rather than each paying
    // for their own redundant Amber call for byte-identical page-1 data —
    // see IVYHUTS_MILESTONE_6_INVENTORY_LOSS_REPORT.md, "cache behavior"). The
    // caller's own uncapped total-target-count still lives only in
    // fetchListings()'s own targetCount variable, never in this key.
    const limit = Math.min(50, Number(params.limit) || 50);
    const availSuffix = params.available === true ? ":avail1" : params.available === false ? ":avail0" : "";
    return `amber:listings:${city || "all"}:p${page}:l${limit}${availSuffix}`;
}

function buildAmberUrl(type, params) {
    if (type === "detail") {
        return `${BASE_URL}/inventories?canonical_name=${encodeURIComponent(String(params.slug || "").trim())}`;
    }
    if (type === "citystats") {
        return `${BASE_URL}/inventories?location_place_name=${encodeURIComponent(normalizeCityName(params.city))}&p=1&limit=1`;
    }
    const page = Number(params.page) || 1;
    const limit = Math.min(50, Number(params.limit) || 50); // never exceed Amber's own 50/request cap
    let url = `${BASE_URL}/inventories?p=${page}&limit=${limit}`;
    if (params.city) url += `&location_place_name=${encodeURIComponent(normalizeCityName(params.city))}`;
    // Amber's own `available` filter — confirmed live against the real API:
    // it changes meta.count to the true filtered total (not just the page),
    // e.g. available=true -> 3221, available=false -> 1060, unfiltered -> 4281
    // (3221 + 1060 matches exactly). That lets inventoryStats.js get exact
    // Total/Sold Out/Remaining counts from meta.count on two limit=1 calls
    // instead of paging through the entire ~4,300-item catalog.
    if (params.available === true) url += "&available=true";
    else if (params.available === false) url += "&available=false";
    return url;
}

function isFresh(entry, freshSeconds) {
    return Date.now() - entry.cachedAt < freshSeconds * 1000;
}

function isUsable(entry, maxAgeSeconds) {
    return Date.now() - entry.cachedAt < maxAgeSeconds * 1000;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Amber's rate-limit response is a 403/429 with a recognizable body shape
// ({"error":"Too many requests","retry_after":<seconds>} — confirmed against
// live responses). We only ever activate the global cooldown when the body
// actually looks like that, not for every 403 — an unrelated auth/config
// 403 must not falsely halt the whole application for 5 minutes.
function isRateLimitBody(body) {
    return !!body && (body.error === "Too many requests" || typeof body.retry_after === "number");
}

async function getCooldownRemainingMs() {
    const until = await sharedGet(COOLDOWN_KEY);
    const remaining = (until || 0) - Date.now();
    return remaining > 0 ? remaining : 0;
}

async function activateCooldown(retryAfterSeconds) {
    const ms = retryAfterSeconds ? retryAfterSeconds * 1000 : DEFAULT_COOLDOWN_MS;
    const until = Date.now() + ms;
    await sharedSet(COOLDOWN_KEY, until, Math.ceil(ms / 1000));
    log(`COOLDOWN ACTIVATED for ${Math.round(ms / 1000)}s`);
    return ms;
}

// Bounded so a hung upstream response can never hold a distributed lock (and
// the serverless invocation carrying it) open indefinitely — see
// AMBER_FETCH_TIMEOUT_MS's comment for why 25s, not something shorter.
// `timeoutMs` is passed explicitly (not read from the module constant
// directly) so fetchListings' fallback leg can be given only whatever time
// remains in the invocation's shared deadline, rather than a fresh full
// AMBER_FETCH_TIMEOUT_MS on top of what the primary call already used.
async function fetchFromAmberOnce(amberUrl, timeoutMs) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
        res = await fetch(amberUrl, { signal: controller.signal });
    } catch (err) {
        if (err.name === "AbortError") {
            throw new AmberGatewayError(`Amber did not respond within ${timeoutMs}ms`, 504, null, "amber_timeout");
        }
        throw err;
    } finally {
        clearTimeout(timeoutId);
    }
    if (res.status === 403 || res.status === 429) {
        const body = await res.json().catch(() => null);
        if (isRateLimitBody(body)) {
            const headerSeconds = Number(res.headers.get("retry-after"));
            const retryAfter = Number(body.retry_after) || (Number.isFinite(headerSeconds) && headerSeconds > 0 ? headerSeconds : undefined);
            const ms = await activateCooldown(retryAfter);
            throw new AmberGatewayError(`Amber rate limited — cooling down ${Math.round(ms / 1000)}s`, 429, Math.round(ms / 1000), "cooldown");
        }
        throw new AmberGatewayError(`Amber returned ${res.status} (not recognized as rate limiting)`, res.status, null, "upstream_error");
    }
    if (!res.ok) throw new AmberGatewayError(`Amber returned ${res.status}`, res.status, null, "upstream_error");
    return res.json();
}

// If Redis is configured but throws (transient Upstash outage — distinct
// from REDIS_AVAILABLE===false, the accepted local-dev shape), serving
// already-known stale data is one of the explicitly safe degraded behaviors:
// it needs no further Redis coordination and can't cause an uncoordinated
// Amber call. Returns the fallback response, or null if the caller should
// re-throw (no stale data available, or a non-Redis error).
function staleOnRedisFailure(err, cached, source, priority, cacheKey) {
    if (err instanceof RedisUnavailableError && cached) {
        log(`source=${source} priority=${priority} cache=STALE key=${cacheKey} action=SERVE_STALE_REDIS_UNAVAILABLE`);
        return { data: cached.data, cacheStatus: "STALE_ERROR" };
    }
    return null;
}

async function fetchAmberInner({ type, params, priority = "MEDIUM", source = "unknown", deadlineAt }) {
    const cacheKey = buildCacheKey(type, params);
    const ttl = TTL[type] || TTL.listings;
    // A single call defaults to a fresh full AMBER_FETCH_TIMEOUT_MS window
    // (unchanged behavior). fetchListings sets one explicit deadlineAt and
    // passes it to both its primary and fallback calls, so the two together
    // share ONE upstream time budget instead of each getting an independent
    // full timeout — see fetchListings' own comment for why.
    const deadline = deadlineAt || Date.now() + AMBER_FETCH_TIMEOUT_MS;
    // This read was previously unguarded — any Redis hiccup here (not just on
    // the write below) threw straight out of fetchAmberInner as a raw,
    // uncaught RedisUnavailableError, skipping every one of the graceful
    // stale/degraded paths below entirely. Falls back to the local shadow
    // cache (see its own header comment) instead of treating a flaky READ as
    // fatal.
    let cached;
    try {
        cached = await sharedGet(cacheKey);
    } catch (err) {
        if (!(err instanceof RedisUnavailableError)) throw err;
        cached = undefined;
        log(`source=${source} priority=${priority} key=${cacheKey} action=CACHE_READ_FAILED_REDIS_UNAVAILABLE`);
    }
    // Also consult the shadow when Redis GET *succeeded* but came back
    // empty — the exact shape of the bug this whole shadow cache exists for
    // is "the WRITE silently failed" (see CACHE_WRITE_FAILED_REDIS_UNAVAILABLE
    // below), which looks identical to a real cache miss from here unless we
    // check: Redis has nothing not because nothing was ever fetched, but
    // because it couldn't hold onto what THIS instance already fetched once.
    if (!cached) {
        const shadow = shadowCacheGet(cacheKey);
        if (shadow) {
            cached = shadow;
            log(`source=${source} priority=${priority} key=${cacheKey} action=CACHE_READ_SHADOW_FALLBACK`);
        }
    }

    if (cached && isFresh(cached, ttl.freshSeconds)) {
        log(`source=${source} priority=${priority} cache=HIT key=${cacheKey}`);
        return { data: cached.data, cacheStatus: "HIT" };
    }

    let cooldownRemaining;
    try {
        cooldownRemaining = await getCooldownRemainingMs();
    } catch (err) {
        const fallback = staleOnRedisFailure(err, cached, source, priority, cacheKey);
        if (fallback) return fallback;
        throw err;
    }
    if (cooldownRemaining > 0) {
        if (cached) {
            log(`source=${source} priority=${priority} cache=STALE key=${cacheKey} action=SERVE_STALE_COOLDOWN`);
            return { data: cached.data, cacheStatus: "STALE_COOLDOWN" };
        }
        log(`source=${source} priority=${priority} cache=MISS key=${cacheKey} action=COOLDOWN_NO_DATA`);
        throw new AmberGatewayError(`Amber is cooling down for ${Math.ceil(cooldownRemaining / 1000)}s and no cached data is available`, 429, Math.ceil(cooldownRemaining / 1000), "cooldown");
    }

    // Usable-but-stale: serve immediately. Serverless functions can't reliably
    // do fire-and-forget work after the response is sent, so — unlike the
    // browser's own L1 cache — we do not attempt a background refresh here.
    // The next request to arrive after the entry truly expires will do one
    // coordinated (locked) refresh instead; every request in between is free.
    if (cached && isUsable(cached, ttl.maxAgeSeconds)) {
        log(`source=${source} priority=${priority} cache=STALE key=${cacheKey} action=SERVE_STALE`);
        return { data: cached.data, cacheStatus: "STALE" };
    }

    // Cache truly missing or expired — this is the only path that may reach
    // Amber, and it's protected by a distributed lock so concurrent callers
    // for the *same* cache key never all fetch at once (cache-stampede
    // protection). Non-matching cache keys (different cities) are unaffected
    // and rely on the shared rate budget below instead.
    const lockKey = `amber:lock:${cacheKey}`;
    let lockToken;
    try {
        lockToken = await acquireLock(lockKey, LOCK_TTL_MS);
    } catch (err) {
        const fallback = staleOnRedisFailure(err, cached, source, priority, cacheKey);
        if (fallback) return fallback;
        throw err;
    }

    if (!lockToken) {
        // Someone else is refreshing this exact key right now. Wait, with
        // increasing backoff (never a busy-loop), for their result rather
        // than also contacting Amber — see LOCK_POLL_INTERVALS_MS's comment
        // for why this window and why it's bounded the way it is.
        for (const wait of LOCK_POLL_INTERVALS_MS) {
            await sleep(wait);
            let recheck;
            try {
                recheck = await sharedGet(cacheKey);
            } catch (err) {
                if (err instanceof RedisUnavailableError) break; // fall through to stale/503 below
                throw err;
            }
            if (recheck) {
                log(`source=${source} priority=${priority} cache=MISS key=${cacheKey} action=WAITED_FOR_LOCK_HOLDER`);
                return { data: recheck.data, cacheStatus: "HIT_AFTER_WAIT" };
            }
        }
        if (cached) return { data: cached.data, cacheStatus: "STALE_LOCK_BUSY" };
        // Never falls through to fetching Amber ourselves here — a loser that
        // can't get the lock and has no stale data to serve fails cleanly
        // instead, which is what keeps one-upstream-request-per-key true even
        // under this timeout.
        throw new AmberGatewayError("Amber data temporarily unavailable — a concurrent refresh is in progress", 503, null, "lock_busy");
    }

    try {
        // If most/all of the shared deadline was already spent (only reachable
        // via fetchListings' fallback leg, after a slow-but-successful primary
        // call), don't reserve a budget slot for an attempt with no realistic
        // chance of completing — fail the same clean way a real timeout would,
        // without spending Amber quota on it.
        const remainingBeforeReserve = deadline - Date.now();
        if (remainingBeforeReserve < MIN_AMBER_ATTEMPT_MS) {
            log(`source=${source} priority=${priority} cache=MISS key=${cacheKey} action=DEADLINE_EXHAUSTED remainingMs=${remainingBeforeReserve}`);
            throw new AmberGatewayError("Amber upstream time budget exhausted for this request", 504, null, "amber_timeout");
        }

        // Atomic check-and-record — see the long comment on tryReserveSlot in
        // sharedStore.js for why this must not be two separate steps.
        const granted = await tryReserveSlot(RATE_WINDOW_MS, RATE_BUDGET_PER_MINUTE);
        if (!granted) {
            const used = await peekRecentRequestCount(RATE_WINDOW_MS);
            log(`source=${source} priority=${priority} cache=MISS key=${cacheKey} budget=${used}/${RATE_BUDGET_PER_MINUTE} action=BUDGET_EXCEEDED`);

            // The shared pool is full. Before giving up, the catalog crawl
            // (and only the catalog crawl — see isCrawlSource) gets one more
            // try against its own small reserved allowance, so steady real
            // traffic can never fully starve it indefinitely (confirmed live:
            // stuck at the same page for 15+ minutes under normal traffic).
            // Every other LOW-priority caller (the cache warmer, etc.) still
            // just skips here exactly as before — this reserve is deliberately
            // narrow, not a general priority boost.
            if (priority === "LOW" && isCrawlSource(source)) {
                const grantedReserved = await reserveSlot(CRAWL_RESERVED_KEY, RATE_WINDOW_MS, CRAWL_RESERVED_BUDGET_PER_MINUTE);
                if (!grantedReserved) {
                    if (cached) return { data: cached.data, cacheStatus: "STALE_BUDGET" };
                    return { data: null, cacheStatus: "SKIPPED_LOW_PRIORITY" };
                }
                log(`source=${source} priority=${priority} cache=MISS key=${cacheKey} action=CRAWL_RESERVE_USED`);
                // Falls through to the real Amber request below, same as a
                // normal granted slot.
            } else if (priority === "LOW") {
                // Background/decorative work must never force the issue —
                // just skip it and let a future request try again.
                if (cached) return { data: cached.data, cacheStatus: "STALE_BUDGET" };
                return { data: null, cacheStatus: "SKIPPED_LOW_PRIORITY" };
            } else {
                if (cached) return { data: cached.data, cacheStatus: "STALE_BUDGET" };
                throw new AmberGatewayError("Amber request budget exhausted for this minute — please retry shortly", 429, null, "budget_exceeded");
            }
        }

        const amberUrl = buildAmberUrl(type, params);
        const used = await peekRecentRequestCount(RATE_WINDOW_MS);
        console.log(`[AMBER UPSTREAM] REQUEST #${used} type=${type} city=${params.city || "-"} slug=${params.slug || "-"} budget=${used}/${RATE_BUDGET_PER_MINUTE}`);
        log(`source=${source} priority=${priority} cache=MISS key=${cacheKey} budget=${used}/${RATE_BUDGET_PER_MINUTE} action=AMBER_REQUEST`);

        // Duration/outcome logging for the upstream call itself — unconditional
        // (not the NODE_ENV-gated log() helper) so this is always visible in
        // Vercel logs, and separate from the "request received" AMBER_REQUEST
        // line above since that's logged before we know how long Amber will
        // actually take. Never logs the full amberUrl (would include the
        // partner ID) or any response body — just type/city/duration/outcome.
        const amberStartedAt = Date.now();
        let json;
        try {
            json = await fetchFromAmberOnce(amberUrl, Math.max(0, deadline - Date.now()));
        } catch (err) {
            const durationMs = Date.now() - amberStartedAt;
            const event = err instanceof AmberGatewayError && err.code === "amber_timeout" ? "AMBER_TIMEOUT" : "AMBER_FAILED";
            console.log(`[AMBER] event=${event} type=${type} city=${params.city || "-"} durationMs=${durationMs} status=${(err instanceof AmberGatewayError && err.status) || "-"} source=${source}`);
            throw err;
        }
        console.log(`[AMBER] event=AMBER_SUCCESS type=${type} city=${params.city || "-"} durationMs=${Date.now() - amberStartedAt} source=${source}`);
        const freshEntry = { data: json, cachedAt: Date.now() };
        try {
            await sharedSet(cacheKey, freshEntry, ttl.maxAgeSeconds);
        } catch (err) {
            if (!(err instanceof RedisUnavailableError)) throw err;
            // We have a perfectly good fresh result in hand — Redis merely
            // failed to *persist* it. Still return it to this caller; the
            // shadow-cache write just below is what keeps the NEXT request
            // for this same key from also missing and re-hitting Amber.
            log(`source=${source} priority=${priority} key=${cacheKey} action=CACHE_WRITE_FAILED_REDIS_UNAVAILABLE`);
        }
        // Always populated, regardless of whether the Redis write above
        // succeeded — keeps this instance's shadow warm so a LATER Redis
        // hiccup (on some future request) still has a good local fallback,
        // not just the one that happened to coincide with an outage.
        shadowCacheSet(cacheKey, freshEntry);

        // Reuse: a full listings page already contains everything a separate
        // citystats call would need (Amber's inventories endpoint returns the
        // same shape for both — citystats is just the same query with
        // limit=1). Populate the citystats cache entry for this city from data
        // we already paid for, so a citystats request that follows shortly
        // after — from cache warming, the homepage trickle, or another user —
        // is a free HIT instead of a second Amber round-trip. Best-effort only:
        // this must never break the primary listings response if it fails.
        if (type === "listings" && params.city) {
            try {
                // Same sanity check fetchListings applies to the primary
                // response: don't derive/cache citystats from items Amber
                // returned that don't actually belong to the requested city
                // (see fetchListings' comment on the filter-gets-ignored case).
                const cityLower = normalizeCityName(params.city);
                const verifiedItems = extractResultArray(json).filter((item) => matchesCity(item, cityLower));
                const statsPayload = verifiedItems.length > 0
                    ? buildCityStatsPayloadFromListings({ message: json?.message, data: { result: verifiedItems, meta: { count: verifiedItems.length } } })
                    : null;
                if (statsPayload) {
                    const statsCacheKey = buildCacheKey("citystats", { city: params.city });
                    await sharedSet(statsCacheKey, { data: statsPayload, cachedAt: Date.now() }, TTL.citystats.maxAgeSeconds);
                    log(`source=${source} priority=${priority} key=${statsCacheKey} action=CITYSTATS_DERIVED_FROM_LISTINGS`);
                }
            } catch (err) {
                if (!(err instanceof RedisUnavailableError)) throw err;
            }
        }

        return { data: json, cacheStatus: "MISS" };
    } catch (err) {
        const fallback = staleOnRedisFailure(err, cached, source, priority, cacheKey);
        if (fallback) return fallback;
        if (cached) {
            log(`source=${source} priority=${priority} key=${cacheKey} action=FETCH_FAILED_SERVING_STALE error=${err.message}`);
            return { data: cached.data, cacheStatus: "STALE_ERROR" };
        }
        throw err;
    } finally {
        await releaseLock(lockKey, lockToken);
    }
}

// The coordinated entry point. `source`/`priority` are for logging only.
// Thin wrapper around fetchAmberInner whose only job is to catch a
// RedisUnavailableError that had no stale data to fall back on (every site
// that *does* have stale data available already returns it above, via
// staleOnRedisFailure) and turn it into one clean, distinctly-coded error
// instead of an unlabeled crash. Critically, this NEVER falls back to the
// in-memory store's behavior — that fallback exists only for
// REDIS_AVAILABLE===false (no credentials configured, i.e. local dev), a
// completely different case from "configured but temporarily unreachable."
// Doing so here would let every concurrently-running Vercel instance start
// enforcing the full budget independently, multiplying real Amber traffic.
async function fetchAmber(args) {
    try {
        return await fetchAmberInner(args);
    } catch (err) {
        if (err instanceof RedisUnavailableError) {
            log(`source=${args.source} priority=${args.priority} action=REDIS_UNAVAILABLE_FAILING_SAFE type=${args.type}`);
            throw new AmberGatewayError("Cache temporarily unavailable — please retry shortly", 503, null, "cache_unavailable");
        }
        throw err;
    }
}

function extractResultArray(json) {
    return Array.isArray(json?.data?.result) ? json.data.result : [];
}

// Builds a citystats-shaped payload out of an already-fetched listings
// response, keeping only what a citystats consumer actually reads (pricing +
// count) — not the full item objects (images, descriptions, room/tenancy
// data), which is most of what makes a full listings payload large. Mirrors
// the shape fetchFromAmberOnce would have returned for a real citystats call
// ({message, data:{result, meta:{count}}}), so both this gateway's own
// isFresh/isUsable checks and the client's deriveCityStats (amberApi.js) work
// on it unmodified.
function buildCityStatsPayloadFromListings(json) {
    const items = extractResultArray(json);
    const count = json?.data?.meta?.count;
    if (count == null && items.length === 0) return null;
    return {
        message: json?.message || "success",
        data: {
            result: items.map((item) => ({ canonical_name: item.canonical_name, pricing: item.pricing })),
            meta: { count: count ?? items.length },
        },
    };
}

function matchesCity(item, cityLower) {
    const checks = [];
    if (item.location) {
        if (item.location.locality?.long_name) checks.push(item.location.locality.long_name);
        if (item.location.city?.long_name) checks.push(item.location.city.long_name);
        if (item.location.country?.long_name) checks.push(item.location.country.long_name);
    }
    // Milestone 15/16 (IVYHUTS_MILESTONE_15_CITY_ATTRIBUTION_AUDIT_REPORT.md,
    // IVYHUTS_MILESTONE_16_CITY_MATCHING_FIX_REPORT.md): item.name deliberately
    // NOT included here. Confirmed live: a property's own brand/display name
    // can contain an unrelated city's name as a substring ("True Manchester
    // Salford, Salford" — a Salford property — matched a "manchester" search
    // solely because of its name), causing a real, reproducible misattribution.
    // Matching is restricted to Amber's own structured location fields, which
    // had zero observed false positives across all 472 audited properties.
    return checks.some((s) => typeof s === "string" && s.toLowerCase().includes(cityLower));
}

// Amber's `location_place_name` filter occasionally returns an empty result
// for a city that does have listings — and, for a city string it doesn't
// recognize at all (e.g. one not yet in its own location list), it can
// instead silently ignore the filter and return its default/unfiltered page
// rather than an empty one. Both are "the filter didn't actually apply";
// checking only for emptiness would let the second case through unfiltered
// and serve some other city's listings under this city's name, so every
// primary result is sanity-checked against the requested city via
// matchesCity() before being trusted.
//
// CONFIRMED LIVE (Derby investigation): the failure mode isn't limited to
// "empty" — Amber's own reported meta.count for `location_place_name=derby`
// has been observed as 1, 3, and 251 (mostly wrong-city noise) across
// separate calls the same day, while the independent full-catalog crawl
// (api/_lib/insightsMarket.js — reads each item's own real
// location.locality.long_name directly, no filter parameter involved at
// all, so it isn't subject to this instability) found 29 genuine Derby
// properties. A NONZERO-but-small matchedPrimary count is just as
// untrustworthy as zero, so it now gets the same fallback treatment instead
// of being returned as if it were complete.
//
// The fallback — fetch the unfiltered catalog and filter server-side by the
// same reliable per-item matchesCity() check — is itself a normal
// fetchAmber() call, so it's cached/budgeted/stampede-protected exactly like
// any other request. Once a given unfiltered page is cached once, every
// OTHER city's fallback that happens to check the same page becomes a free
// cache hit instead of a second Amber call. Bounded to
// FALLBACK_MAX_EXTRA_PAGES extra calls (not unbounded pagination through the
// full ~86-page catalog) specifically because the shared budget is only
// ~6 Amber requests/minute site-wide — a single sparse-city page load must
// never be able to consume a large fraction of that for every other
// concurrent user.
//
// All legs share ONE deadlineAt, established here once, rather than each
// defaulting to its own fresh AMBER_FETCH_TIMEOUT_MS. Without this, a slow
// (but successful, empty-result) primary Amber call followed by fallback
// pages that also need real Amber attempts could sum to well over
// AMBER_FETCH_TIMEOUT_MS — incompatible with a single Vercel invocation's
// maxDuration. With a shared deadline, each fallback page only gets whatever
// time earlier legs didn't use; fetchAmberInner's own MIN_AMBER_ATTEMPT_MS
// check skips a page's Amber attempt entirely (failing amber_timeout, or
// serving stale if available) rather than wasting a budget slot on an
// attempt that can't realistically finish in time — and this loop stops
// early on that failure rather than trying further pages.
const FALLBACK_SUSPICIOUS_MATCH_THRESHOLD = 5;
const FALLBACK_MAX_EXTRA_PAGES = 2;

// A city whose filtered query looks completely healthy on page 1 (every/
// most returned items genuinely belong to it) was still being truncated at
// whatever that ONE page happened to contain — CONFIRMED LIVE: London
// reported only 38 properties through this pipeline while Amber's own site
// lists 80+ for the same city, because a "healthy" page 1 short-circuited
// straight to `return` with no attempt to check whether page 2 existed.
// Every city with more genuine inventory than fits on a single 50-item page
// hit this same silent cap — not a one-off, which matches it being reported
// as happening "every time". This bound lets fetchListings keep asking for
// more pages of the SAME (working) filtered query as long as Amber keeps
// sending full pages back, instead of stopping after the first one. 12
// pages (~600 properties at the 50/page cap) comfortably covers even
// Amber's largest single-city markets while staying well short of a
// full-catalog crawl (~86 pages).
const FILTERED_PAGINATION_MAX_PAGES = 12;

async function fetchListings(params, priority, source) {
    const startedAt = Date.now();
    const deadlineAt = startedAt + AMBER_FETCH_TIMEOUT_MS;
    // Milestone 6 fix (IVYHUTS_MILESTONE_6_INVENTORY_LOSS_REPORT.md, Phase 4):
    // TWO different concepts were previously conflated into one clamped
    // `requestedLimit` value:
    //   pageSize   — is a given raw Amber PAGE "full"? This must stay capped
    //                at 50, because Amber itself never returns more than 50
    //                items per page (buildAmberUrl's own Math.min(50, ...)) —
    //                a page of 50 looks "full" regardless of what the caller
    //                ultimately wants in total.
    //   targetCount — how many TOTAL genuinely-matching results does the
    //                caller actually want across all merged pages? A user
    //                search (University Housing/Find Room, limit:50) and a
    //                full-inventory-refresh attempt (accommodationIndex.js's
    //                refreshCityIndex(), which now requests more — see that
    //                file's REFRESH_TARGET_COUNT) have GENUINELY DIFFERENT
    //                answers to this question, and clamping both to 50 meant
    //                a "refresh" attempt could never capture more than one
    //                page per attempt no matter what it asked for — confirmed
    //                live: refreshCityIndex()'s call, unchanged since
    //                Milestone 3, always returned exactly 50 items even when
    //                8 full pages of genuine matches were available in a
    //                deterministic reproduction. This did NOT undo Milestone
    //                3's fix (which remains fully intact for user searches,
    //                whose targetCount is still 50 by default) — it only
    //                restores the ABILITY for a caller to legitimately ask
    //                for more, which nothing previously allowed.
    const pageSize = Math.min(50, Number(params.limit) || 50);
    const targetCount = Number(params.limit) || 50; // NOT clamped to 50 — mirrors the sparse-fallback loop below, which already got this right
    const primary = await fetchAmber({ type: "listings", params, priority, source, deadlineAt });
    if (!params.city) return { ...primary, complete: true }; // no pagination loop attempted — nothing to be incomplete about

    const primaryItems = extractResultArray(primary.data);
    const cityLower = normalizeCityName(params.city);
    const matchedPrimary = primaryItems.filter((item) => matchesCity(item, cityLower));

    const primaryTrustworthy = matchedPrimary.length > 0 &&
        (matchedPrimary.length === primaryItems.length || matchedPrimary.length >= FALLBACK_SUSPICIOUS_MATCH_THRESHOLD);
    if (primaryTrustworthy) {
        // Page 1's filtered result looks genuine — keep it, but don't assume
        // it's the WHOLE city just because it's trustworthy. If Amber sent a
        // full page (== pageSize) AND we still don't have `targetCount`
        // genuinely-matching items yet, there may be more real matches
        // sitting on page 2+ that were never asked for. Keep paging the same
        // filtered query — each additional page independently re-verified
        // via matchesCity(), exactly like page 1 — until a page comes back
        // partial (the true end of this city's results), untrustworthy (stop
        // chasing noise), the caller's own target count is already satisfied
        // by genuinely-matched results (Milestone 3's fix, preserved
        // unchanged), or the page/deadline/budget bound is hit. Any failure
        // mid-loop just stops early, same "never discard what's already
        // real" contract as the sparse-fallback loop below.
        const merged = new Map(matchedPrimary.map((item) => [item.id, item]));
        let cacheStatus = primary.cacheStatus;
        let page = Number(params.page) || 1;
        let pagesFetched = 1;
        // Milestone 22/23 (deadline-fix): tracks WHY the pagination loop
        // stopped, not just that it stopped — a caller deciding whether to
        // mark a refresh "complete" needs to distinguish "we genuinely
        // reached the end of this city's real Amber results" from "we gave
        // up because the shared deadline/budget ran out mid-page." Both
        // previously looked identical from the outside (same return shape,
        // same cacheStatus) — a PAGINATE_FAILED break silently produced the
        // same success response as a clean, complete pagination run, which
        // is exactly how a deadline-truncated refresh could get marked
        // "ok"/FRESH in AccommodationIndexMeta despite only capturing a
        // fraction of the city (confirmed live: Derby's own refresh this
        // session hit PAGINATE_FAILED at page 3 with 13/29+ real properties
        // captured, and nothing downstream would have known).
        let stoppedEarly = false;
        let keepPaging = primaryItems.length >= pageSize && merged.size < targetCount;
        while (keepPaging && page < FILTERED_PAGINATION_MAX_PAGES) {
            page += 1;
            let next;
            try {
                next = await fetchAmber({ type: "listings", params: { ...params, page }, priority, source: `${source}-paginate`, deadlineAt });
            } catch (err) {
                log(`source=${source} priority=${priority} action=PAGINATE_FAILED page=${page} error=${err.message}`);
                stoppedEarly = true;
                break;
            }
            pagesFetched += 1;
            cacheStatus = next.cacheStatus;
            const items = extractResultArray(next.data);
            const matched = items.filter((item) => matchesCity(item, cityLower));
            matched.forEach((item) => merged.set(item.id, item));
            const pageTrustworthy = matched.length > 0 &&
                (matched.length === items.length || matched.length >= FALLBACK_SUSPICIOUS_MATCH_THRESHOLD);
            if (!pageTrustworthy && merged.size < targetCount) stoppedEarly = true; // ambiguous noise, not a confirmed true end
            keepPaging = pageTrustworthy && items.length >= pageSize && merged.size < targetCount;
        }
        // Hit the hard page cap while still genuinely wanting more — also not
        // a confirmed true end of this city's real results.
        if (keepPaging && page >= FILTERED_PAGINATION_MAX_PAGES) stoppedEarly = true;
        const complete = !stoppedEarly;
        log(`source=${source} priority=${priority} action=FETCH_LISTINGS_DONE city=${params.city} targetCount=${targetCount} pages=${pagesFetched} returned=${merged.size} complete=${complete} durationMs=${Date.now() - startedAt}`);
        return {
            data: { message: primary.data?.message || "success", data: { result: Array.from(merged.values()), meta: { count: merged.size } } },
            cacheStatus,
            complete,
        };
    }

    // Zero, or a suspiciously small nonzero count — page through a BOUNDED
    // number of unfiltered pages, filtering each by the reliable
    // matchesCity() check, merging with whatever the primary call already
    // found (deduped by id). Any failure mid-loop (deadline, budget, lock)
    // just stops early — never a hard error; the primary's own already-real
    // matches (if any) are always preserved, never discarded.
    const merged = new Map(matchedPrimary.map((item) => [item.id, item]));
    let cacheStatus = primary.cacheStatus;
    // `targetCount` already computed once at the top of this function —
    // reused here unchanged (this branch's own bound was already correct
    // pre-Milestone-6; only the primary/trustworthy branch above conflated
    // it with the page-size cap).
    for (let page = 1; page <= FALLBACK_MAX_EXTRA_PAGES && merged.size < targetCount; page++) {
        let fallback;
        try {
            fallback = await fetchAmber({
                type: "listings",
                params: { page, limit: params.limit },
                priority,
                source: `${source}-fallback`,
                deadlineAt,
            });
        } catch (err) {
            log(`source=${source} priority=${priority} action=FALLBACK_PAGE_FAILED page=${page} error=${err.message}`);
            break; // deadline/budget/lock exhausted — serve whatever's already merged
        }
        cacheStatus = fallback.cacheStatus;
        for (const item of extractResultArray(fallback.data)) {
            if (matchesCity(item, cityLower)) merged.set(item.id, item);
        }
    }
    const result = Array.from(merged.values());
    log(`source=${source} priority=${priority} action=FETCH_LISTINGS_DONE_FALLBACK city=${params.city} requestedLimit=${targetCount} returned=${result.length} durationMs=${Date.now() - startedAt}`);
    return {
        data: { message: primary.data?.message || "success", data: { result, meta: { count: result.length } } },
        cacheStatus,
        // Always incomplete, unconditionally — this branch only ever samples
        // a BOUNDED FALLBACK_MAX_EXTRA_PAGES (2) pages of the much larger
        // unfiltered global catalog (Milestone 12/18's own established
        // finding), never the whole city, regardless of whether this small
        // loop finished cleanly or hit a mid-loop failure.
        complete: false,
    };
}

module.exports = {
    fetchAmber,
    fetchListings,
    buildCacheKey,
    buildAmberUrl,
    normalizeCityName,
    // Exported for api/amber.js's Mongo-known-slug enrichment step — reuses
    // the SAME reliable per-item location check fetchListings' own fallback
    // already relies on, so a candidate slug pulled from AccommodationResidence
    // is verified against its real (freshly-fetched) location before ever
    // being shown, never trusted just because it was tagged with this city
    // historically (see the Derby mistagging incident this existed to guard against).
    matchesCity,
    AmberGatewayError,
    RATE_BUDGET_PER_MINUTE,
    RATE_WINDOW_MS,
    TTL,
    isUsable,
};
