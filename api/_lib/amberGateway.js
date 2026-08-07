// The single logical place that talks to Amber. Every outbound Amber
// request — from every user, every tab, every deployed instance — goes
// through fetchAmber() below, which is cache-first, cooldown-aware,
// stampede-locked and budget-enforced before it ever touches the network.
const { sharedGet, sharedSet, tryReserveSlot, peekRecentRequestCount, acquireLock, releaseLock, RedisUnavailableError, log } = require("./sharedStore");

const PARTNER_ID = "ivy-huts-707a5cdf";
const BASE_URL = `https://base.amberstudent.com/api/v0/leads/partners/${PARTNER_ID}`;

// Amber's hard limit is 10/minute with a 5-minute halt on violation. We stay
// well under that — configurable, defaulting conservatively below the limit
// because other environments/consumers may share the same partner quota.
const RATE_BUDGET_PER_MINUTE = Number(process.env.AMBER_MAX_REQUESTS_PER_MINUTE) || 6;
const RATE_WINDOW_MS = 60_000;
const DEFAULT_COOLDOWN_MS = 5 * 60_000; // Amber's documented halt — used whenever it doesn't tell us otherwise

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
    const limit = Number(params.limit) || 50;
    return `amber:listings:${city || "all"}:p${page}:l${limit}`;
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
    const base = `${BASE_URL}/inventories?p=${page}&limit=${limit}`;
    return params.city ? `${base}&location_place_name=${encodeURIComponent(normalizeCityName(params.city))}` : base;
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
    const cached = await sharedGet(cacheKey);

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
            if (priority === "LOW") {
                // Background/decorative work must never force the issue —
                // just skip it and let a future request try again.
                if (cached) return { data: cached.data, cacheStatus: "STALE_BUDGET" };
                return { data: null, cacheStatus: "SKIPPED_LOW_PRIORITY" };
            }
            if (cached) return { data: cached.data, cacheStatus: "STALE_BUDGET" };
            throw new AmberGatewayError("Amber request budget exhausted for this minute — please retry shortly", 429, null, "budget_exceeded");
        }

        const amberUrl = buildAmberUrl(type, params);
        const used = await peekRecentRequestCount(RATE_WINDOW_MS);
        console.log(`[AMBER UPSTREAM] REQUEST #${used} type=${type} city=${params.city || "-"} slug=${params.slug || "-"} budget=${used}/${RATE_BUDGET_PER_MINUTE}`);
        log(`source=${source} priority=${priority} cache=MISS key=${cacheKey} budget=${used}/${RATE_BUDGET_PER_MINUTE} action=AMBER_REQUEST`);

        const json = await fetchFromAmberOnce(amberUrl, Math.max(0, deadline - Date.now()));
        try {
            await sharedSet(cacheKey, { data: json, cachedAt: Date.now() }, ttl.maxAgeSeconds);
        } catch (err) {
            if (!(err instanceof RedisUnavailableError)) throw err;
            // We have a perfectly good fresh result in hand — Redis merely
            // failed to *persist* it. Still return it to this caller; we just
            // won't benefit other instances/requests until Redis recovers.
            log(`source=${source} priority=${priority} key=${cacheKey} action=CACHE_WRITE_FAILED_REDIS_UNAVAILABLE`);
        }

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
                const statsPayload = buildCityStatsPayloadFromListings(json);
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
    if (item.name) checks.push(item.name);
    return checks.some((s) => typeof s === "string" && s.toLowerCase().includes(cityLower));
}

// Amber's `location_place_name` filter occasionally returns an empty result
// for a city that does have listings. The fallback — fetch the unfiltered
// dataset and filter server-side — is itself a normal fetchAmber() call, so
// it's cached/budgeted/stampede-protected exactly like any other request.
// Once that unfiltered dataset is cached once, every city's fallback becomes
// a free cache hit instead of a second Amber call.
//
// Both legs share ONE deadlineAt, established here once, rather than each
// defaulting to its own fresh AMBER_FETCH_TIMEOUT_MS. Without this, a slow
// (but successful, empty-result) primary Amber call followed by a fallback
// that also needs a real Amber attempt could sum to up to 2x
// AMBER_FETCH_TIMEOUT_MS — incompatible with a single Vercel invocation's
// maxDuration. With a shared deadline, the fallback only gets whatever time
// the primary didn't use; fetchAmberInner's own MIN_AMBER_ATTEMPT_MS check
// skips the fallback's Amber attempt entirely (failing amber_timeout, or
// serving stale if available) rather than wasting a budget slot on an
// attempt that can't realistically finish in time.
async function fetchListings(params, priority, source) {
    const deadlineAt = Date.now() + AMBER_FETCH_TIMEOUT_MS;
    const primary = await fetchAmber({ type: "listings", params, priority, source, deadlineAt });
    if (extractResultArray(primary.data).length > 0 || !params.city) return primary;

    // The fallback can now legitimately fail to even attempt Amber (deadline
    // already spent by a slow primary — see MIN_AMBER_ATTEMPT_MS) as well as
    // fail the ordinary ways (lock busy, budget exceeded, genuine timeout).
    // None of that should crash this request: the primary already succeeded,
    // just with zero results, which is a perfectly valid — if not ideal —
    // thing to show the user. Losing the fallback must degrade to "primary's
    // empty result", never to a hard error the primary itself didn't have.
    let fallback;
    try {
        fallback = await fetchAmber({
            type: "listings",
            params: { page: params.page, limit: params.limit },
            priority,
            source: `${source}-fallback`,
            deadlineAt,
        });
    } catch (err) {
        log(`source=${source} priority=${priority} action=FALLBACK_FAILED_SERVING_PRIMARY error=${err.message}`);
        return primary;
    }
    const cityLower = normalizeCityName(params.city);
    const filtered = extractResultArray(fallback.data).filter((item) => matchesCity(item, cityLower));
    return {
        data: { message: "success", data: { result: filtered, meta: { count: filtered.length } } },
        cacheStatus: fallback.cacheStatus,
    };
}

module.exports = {
    fetchAmber,
    fetchListings,
    buildCacheKey,
    buildAmberUrl,
    normalizeCityName,
    AmberGatewayError,
    RATE_BUDGET_PER_MINUTE,
    RATE_WINDOW_MS,
    TTL,
    isUsable,
};