// The single logical place that talks to Amber. Every outbound Amber
// request — from every user, every tab, every deployed instance — goes
// through fetchAmber() below, which is cache-first, cooldown-aware,
// stampede-locked and budget-enforced before it ever touches the network.
const { sharedGet, sharedSet, tryReserveSlot, peekRecentRequestCount, acquireLock, releaseLock, log } = require("./sharedStore");

const PARTNER_ID = "ivy-huts-707a5cdf";
const BASE_URL = `https://base.amberstudent.com/api/v0/leads/partners/${PARTNER_ID}`;

// Amber's hard limit is 10/minute with a 5-minute halt on violation. We stay
// well under that — configurable, defaulting conservatively below the limit
// because other environments/consumers may share the same partner quota.
const RATE_BUDGET_PER_MINUTE = Number(process.env.AMBER_MAX_REQUESTS_PER_MINUTE) || 6;
const RATE_WINDOW_MS = 60_000;
const DEFAULT_COOLDOWN_MS = 5 * 60_000; // Amber's documented halt — used whenever it doesn't tell us otherwise
const LOCK_TTL_MS = 10_000; // generous enough for one Amber round-trip
const COOLDOWN_KEY = "amber:cooldownUntil";

const TTL = {
    listings: { freshSeconds: 2 * 60, maxAgeSeconds: 10 * 60 },
    detail: { freshSeconds: 5 * 60, maxAgeSeconds: 20 * 60 },
    citystats: { freshSeconds: 60 * 60, maxAgeSeconds: 6 * 60 * 60 },
};

class AmberGatewayError extends Error {
    constructor(message, status, retryAfterSeconds) {
        super(message);
        this.status = status || 502;
        this.retryAfterSeconds = retryAfterSeconds || null;
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

async function fetchFromAmberOnce(amberUrl) {
    const res = await fetch(amberUrl);
    if (res.status === 403 || res.status === 429) {
        const body = await res.json().catch(() => null);
        if (isRateLimitBody(body)) {
            const headerSeconds = Number(res.headers.get("retry-after"));
            const retryAfter = Number(body.retry_after) || (Number.isFinite(headerSeconds) && headerSeconds > 0 ? headerSeconds : undefined);
            const ms = await activateCooldown(retryAfter);
            throw new AmberGatewayError(`Amber rate limited — cooling down ${Math.round(ms / 1000)}s`, 429, Math.round(ms / 1000));
        }
        throw new AmberGatewayError(`Amber returned ${res.status} (not recognized as rate limiting)`, res.status);
    }
    if (!res.ok) throw new AmberGatewayError(`Amber returned ${res.status}`, res.status);
    return res.json();
}

// The coordinated entry point. `source`/`priority` are for logging only.
async function fetchAmber({ type, params, priority = "MEDIUM", source = "unknown" }) {
    const cacheKey = buildCacheKey(type, params);
    const ttl = TTL[type] || TTL.listings;
    const cached = await sharedGet(cacheKey);

    if (cached && isFresh(cached, ttl.freshSeconds)) {
        log(`source=${source} priority=${priority} cache=HIT key=${cacheKey}`);
        return { data: cached.data, cacheStatus: "HIT" };
    }

    const cooldownRemaining = await getCooldownRemainingMs();
    if (cooldownRemaining > 0) {
        if (cached) {
            log(`source=${source} priority=${priority} cache=STALE key=${cacheKey} action=SERVE_STALE_COOLDOWN`);
            return { data: cached.data, cacheStatus: "STALE_COOLDOWN" };
        }
        log(`source=${source} priority=${priority} cache=MISS key=${cacheKey} action=COOLDOWN_NO_DATA`);
        throw new AmberGatewayError(`Amber is cooling down for ${Math.ceil(cooldownRemaining / 1000)}s and no cached data is available`, 429, Math.ceil(cooldownRemaining / 1000));
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
    const gotLock = await acquireLock(lockKey, LOCK_TTL_MS);

    if (!gotLock) {
        // Someone else is refreshing this exact key right now. Wait briefly for
        // their result rather than also contacting Amber.
        for (const wait of [400, 900]) {
            await sleep(wait);
            const recheck = await sharedGet(cacheKey);
            if (recheck) {
                log(`source=${source} priority=${priority} cache=MISS key=${cacheKey} action=WAITED_FOR_LOCK_HOLDER`);
                return { data: recheck.data, cacheStatus: "HIT_AFTER_WAIT" };
            }
        }
        if (cached) return { data: cached.data, cacheStatus: "STALE_LOCK_BUSY" };
        throw new AmberGatewayError("Amber data temporarily unavailable — a concurrent refresh is in progress", 503);
    }

    try {
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
            throw new AmberGatewayError("Amber request budget exhausted for this minute — please retry shortly", 429);
        }

        const amberUrl = buildAmberUrl(type, params);
        const used = await peekRecentRequestCount(RATE_WINDOW_MS);
        console.log(`[AMBER UPSTREAM] REQUEST #${used} type=${type} city=${params.city || "-"} slug=${params.slug || "-"} budget=${used}/${RATE_BUDGET_PER_MINUTE}`);
        log(`source=${source} priority=${priority} cache=MISS key=${cacheKey} budget=${used}/${RATE_BUDGET_PER_MINUTE} action=AMBER_REQUEST`);

        const json = await fetchFromAmberOnce(amberUrl);
        await sharedSet(cacheKey, { data: json, cachedAt: Date.now() }, ttl.maxAgeSeconds);
        return { data: json, cacheStatus: "MISS" };
    } catch (err) {
        if (cached) {
            log(`source=${source} priority=${priority} key=${cacheKey} action=FETCH_FAILED_SERVING_STALE error=${err.message}`);
            return { data: cached.data, cacheStatus: "STALE_ERROR" };
        }
        throw err;
    } finally {
        await releaseLock(lockKey);
    }
}

function extractResultArray(json) {
    return Array.isArray(json?.data?.result) ? json.data.result : [];
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
async function fetchListings(params, priority, source) {
    const primary = await fetchAmber({ type: "listings", params, priority, source });
    if (extractResultArray(primary.data).length > 0 || !params.city) return primary;

    const fallback = await fetchAmber({
        type: "listings",
        params: { page: params.page, limit: params.limit },
        priority,
        source: `${source}-fallback`,
    });
    const cityLower = normalizeCityName(params.city);
    const filtered = extractResultArray(fallback.data).filter((item) => matchesCity(item, cityLower));
    return {
        data: { message: "success", data: { result: filtered, meta: { count: filtered.length } } },
        cacheStatus: fallback.cacheStatus,
    };
}

module.exports = { fetchAmber, fetchListings, buildCacheKey, buildAmberUrl, normalizeCityName, AmberGatewayError, RATE_BUDGET_PER_MINUTE, RATE_WINDOW_MS };