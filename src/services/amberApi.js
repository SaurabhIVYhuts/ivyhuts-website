// Frontend Amber client. As of this version, the browser NEVER contacts
// base.amberstudent.com directly — every request goes to our own
// /api/amber serverless gateway (api/amber.js + api/_lib/amberGateway.js),
// which coordinates the real Amber rate budget/cooldown/cache across every
// user, tab and deployed instance. What remains here is purely an L1 cache
// (fast, local, avoids even hitting our own backend for data we already
// have) — the *authoritative* protection now lives server-side.
const DEV = process.env.NODE_ENV !== "production";
function devLog(...args) { if (DEV) console.log("[Amber]", ...args); }

export class AmberRateLimitError extends Error {
    constructor(retryAfterSeconds) {
        super(`Amber API is rate limited. Try again in ${retryAfterSeconds}s.`);
        this.name = "AmberRateLimitError";
        this.isRateLimit = true;
        this.retryAfterSeconds = retryAfterSeconds;
    }
}

// A gateway-reported temporary condition that isn't "rate limited" in the
// classic sense — someone else is refreshing this exact key (lock_busy), or
// the shared cache backend itself is unreachable (cache_unavailable). Kept
// distinct from AmberRateLimitError so a caller that wants to branch on the
// specific reason can (via `.reason`), without changing behavior for any
// existing caller that only checks `.isRateLimit`.
export class AmberUnavailableError extends Error {
    constructor(reason, message) {
        super(message || "Amber data is temporarily unavailable");
        this.name = "AmberUnavailableError";
        this.reason = reason || "unavailable";
    }
}

// If our own gateway reports it's mid-cooldown, remember that locally too —
// not for correctness (the gateway is authoritative and re-checks this on
// every call regardless), just so the UI can fail fast without a round trip,
// and so a page reload doesn't immediately retry. Persisted so it survives
// a reload, same reasoning as before.
const COOLDOWN_STORAGE_KEY = "amber_cooldown_until";
function readRateLimitedUntil() {
    try { return Number(window.localStorage.getItem(COOLDOWN_STORAGE_KEY)) || 0; } catch { return 0; }
}
function writeRateLimitedUntil(value) {
    try { window.localStorage.setItem(COOLDOWN_STORAGE_KEY, String(value)); } catch { /* ignore */ }
}
let rateLimitedUntil = readRateLimitedUntil();

// ── L1 cache: in memory always, IndexedDB too so it survives a reload.
// IndexedDB (not sessionStorage) because a full listings response can run
// into the low tens of MB once room/tenancy data is included — measured
// ~13.7MB for one 20-item city page — which blows past any Web Storage quota.
//
// True stale-while-revalidate: "fresh" data returns instantly with no network
// at all; "stale" (past fresh, still under the usable window) ALSO returns
// instantly, and separately kicks off a non-blocking background refresh —
// the caller never waits on it. Only truly absent/expired data blocks on a
// real fetch. A browser tab is long-lived (unlike the serverless gateway,
// which can't reliably do fire-and-forget work after responding), so this is
// safe to do client-side even though the server intentionally doesn't.
//
// These numbers are mirrored server-side in api/_lib/amberGateway.js's own
// TTL table (its maxAgeSeconds is deliberately kept a little LONGER than the
// matching staleMs here, per city — the server cache must not expire before
// the client stops considering its own copy usable, or the client's "instant
// stale response" would silently start missing and fall through to a real
// blocking fetch). CRA's build (this file) and the Vercel function (that
// file) are separate bundling contexts — CRA's ModuleScopePlugin blocks
// importing anything outside src/, so a single shared constants module isn't
// practical here without ejecting/reconfiguring the build. Keep both tables
// in sync by hand if either changes.
const CLIENT_TTL = {
    listings: { freshMs: 3 * 60_000, staleMs: 45 * 60_000 },
    detail: { freshMs: 5 * 60_000, staleMs: 60 * 60_000 },
    citystats: { freshMs: 60 * 60_000, staleMs: 24 * 60 * 60_000 },
};
const DB_NAME = "ivyhuts-amber-cache";
const DB_STORE = "responses";
const CITY_STATS_CACHE_PREFIX = "amber:cached-city-stats:";
const LISTING_SUMMARY_CACHE_PREFIX = "amber:listing-summary:";

const memoryCache = new Map();
const inFlight = new Map();

let dbOpenPromise = null;
function openDb() {
    if (dbOpenPromise) return dbOpenPromise;
    dbOpenPromise = new Promise((resolve, reject) => {
        if (typeof indexedDB === "undefined") { reject(new Error("indexedDB unavailable")); return; }
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => { req.result.createObjectStore(DB_STORE); };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
    return dbOpenPromise;
}

async function idbGet(key) {
    try {
        const db = await openDb();
        return await new Promise((resolve, reject) => {
            const req = db.transaction(DB_STORE, "readonly").objectStore(DB_STORE).get(key);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    } catch {
        return undefined;
    }
}

async function idbSet(key, entry) {
    try {
        const db = await openDb();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(DB_STORE, "readwrite");
            tx.objectStore(DB_STORE).put(entry, key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    } catch {
        // Quota exceeded or unavailable — memory cache still covers this page load.
    }
}

function setCached(key, data) {
    const entry = { data, cachedAt: Date.now() };
    memoryCache.set(key, entry);
    idbSet(key, entry);
}

function isFresh(entry, ttl) { return Date.now() - entry.cachedAt < ttl.freshMs; }
function isUsable(entry, ttl) { return Date.now() - entry.cachedAt < ttl.staleMs; }

// Builds the request to OUR gateway (not Amber). `key` doubles as the L1
// cache key and is stable/normalized the same way the server normalizes its
// own cache keys (lowercase city, explicit page/limit) so client and server
// caching line up conceptually even though they're independent layers.
// Only includes params relevant to `type` — e.g. never a stray `slug=undefined`
// on a listings request just because the shared params object has that key.
function gatewayUrl(type, params) {
    const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null);
    const q = new URLSearchParams([["type", type], ...entries]);
    return `/api/amber?${q.toString()}`;
}

function keyParamsFor(type, params) {
    if (type === "detail") return { slug: params.slug };
    if (type === "citystats") return { city: params.city };
    return { city: params.city, page: params.page, limit: params.limit };
}

function cityStatsCacheKey(city) {
    return `${CITY_STATS_CACHE_PREFIX}${String(city || "").trim().toLowerCase()}`;
}

function listingSummaryCacheKey(slug) {
    return `${LISTING_SUMMARY_CACHE_PREFIX}${String(slug || "").trim().toLowerCase()}`;
}

function deriveCityStats(json) {
    const listings = extractArray(json);
    const count = json?.data?.meta?.count;
    const priced = listings.map((item) => Number(item?.pricing?.min_price ?? item?.pricing?.available_price)).filter(Number.isFinite);
    const pricedItem = listings.find((item) => Number.isFinite(Number(item?.pricing?.min_price ?? item?.pricing?.available_price)));
    if (count == null && !pricedItem) return null;
    return { count: count ?? listings.length, price: priced.length ? Math.min(...priced) : null, currency: pricedItem?.pricing?.currency ?? null };
}

function rememberInventoryData(city, json) {
    if (!json) return;
    const stats = deriveCityStats(json);
    if (city && stats) setCached(cityStatsCacheKey(city), stats);
    extractArray(json).forEach((item) => {
        if (item?.canonical_name) setCached(listingSummaryCacheKey(item.canonical_name), item);
    });
}
// Does the actual network round-trip (or reuses one already in flight for
// this exact key). Shared by both the blocking "no usable cache" path and
// the non-blocking background-refresh path below, so a stale-triggered
// refresh and a genuine cache-miss for the same key never double-fetch.
function startNetworkFetch(key, type, params, priority, source, persisted) {
    if (inFlight.has(key)) {
        devLog("L1 DEDUPED", key);
        return inFlight.get(key);
    }

    const promise = (async () => {
        if (Date.now() < rateLimitedUntil) {
            if (persisted) return persisted.data;
            const remaining = Math.ceil((rateLimitedUntil - Date.now()) / 1000);
            throw new AmberRateLimitError(remaining);
        }

        const url = gatewayUrl(type, { ...params, priority, source });
        devLog("REQUEST", url);
        let res;
        try {
            res = await fetch(url);
        } catch (err) {
            if (persisted) return persisted.data; // network hiccup — serve what we have
            throw err;
        }

        if (res.status === 429) {
            const body = await res.json().catch(() => null);
            const headerSeconds = Number(res.headers.get("Retry-After"));
            const retryAfter = Number(body?.retryAfterSeconds) || (Number.isFinite(headerSeconds) && headerSeconds > 0 ? headerSeconds : 300);
            rateLimitedUntil = Date.now() + retryAfter * 1000;
            writeRateLimitedUntil(rateLimitedUntil);
            if (persisted) return persisted.data;
            throw new AmberRateLimitError(retryAfter);
        }

        if (res.status === 503) {
            // Gateway-level temporary condition — a concurrent refresh for this
            // exact key is already in progress, or the shared cache backend
            // (Redis) is itself unreachable right now. Neither means "no data
            // exists"; both are transient. Not persisted as a client-side
            // cooldown like 429 is, since this isn't Amber's own rate limit.
            const body = await res.json().catch(() => null);
            if (persisted) return persisted.data;
            throw new AmberUnavailableError(body?.error, body?.message);
        }

        if (!res.ok) {
            if (persisted) return persisted.data;
            throw new Error("Failed to fetch properties");
        }

        let body;
        try {
            body = await res.json();
        } catch {
            // A non-JSON response (e.g. an HTML page) means /api/amber isn't
            // actually being served — this happens when running the plain CRA
            // dev server (`npm start`), which doesn't know about serverless
            // functions in api/. Use `vercel dev` instead to run both the
            // frontend and the gateway together locally. Fail the same way as
            // any other unreachable-backend case, not with a raw parse error.
            if (persisted) return persisted.data;
            throw new Error("Amber gateway unavailable (is the app running via `vercel dev`?)");
        }
        if (body.data == null) {
            // Gateway deliberately skipped a low-priority background request
            // (budget exhausted) — fall back to whatever we already have.
            if (persisted) return persisted.data;
            return null;
        }
        setCached(key, body.data);
        return body.data;
    })();

    inFlight.set(key, promise);
    promise.then(() => inFlight.delete(key), () => inFlight.delete(key));
    return promise;
}

async function callGateway(type, params, { priority = "MEDIUM", source = "unknown" } = {}) {
    const ttl = CLIENT_TTL[type] || CLIENT_TTL.listings;
    const key = gatewayUrl(type, keyParamsFor(type, params));

    const mem = memoryCache.get(key);
    if (mem && isFresh(mem, ttl)) {
        devLog("L1 CACHE HIT", key);
        return mem.data;
    }

    if (inFlight.has(key)) {
        devLog("L1 DEDUPED", key);
        return inFlight.get(key);
    }

    const persisted = mem || (await idbGet(key));
    if (persisted && !mem) memoryCache.set(key, persisted);
    if (persisted && isFresh(persisted, ttl)) return persisted.data;

    if (persisted && isUsable(persisted, ttl)) {
        // Stale-while-revalidate: real cached data, just not the newest —
        // return it immediately and refresh in the background. The caller
        // never waits on the network for this; a failed background refresh
        // is silently swallowed since stale data was already served.
        //
        // The background refresh always runs at LOW priority, regardless of
        // what priority the foreground caller asked for (e.g. HIGH for a
        // property detail page). The user already has data on screen — this
        // request exists purely to freshen it, so it must never queue ahead
        // of, or consume shared Amber budget that, a real waiting user needs.
        devLog("L1 STALE — serving immediately, revalidating in background (LOW priority)", key);
        startNetworkFetch(key, type, params, "LOW", `${source}-swr-refresh`, persisted).catch(() => {});
        return persisted.data;
    }

    // No usable cache at all — this is the only path that blocks on the network.
    return startNetworkFetch(key, type, params, priority, source, persisted);
}

function extractArray(json) {
    if (!json) return [];
    if (Array.isArray(json)) return json;
    if (json.data) {
        if (Array.isArray(json.data)) return json.data;
        if (Array.isArray(json.data.result)) return json.data.result;
        if (Array.isArray(json.data.results)) return json.data.results;
        if (Array.isArray(json.data.inventories)) return json.data.inventories;
    }
    if (Array.isArray(json.result)) return json.result;
    if (Array.isArray(json.results)) return json.results;
    if (Array.isArray(json.inventories)) return json.inventories;
    return [];
}

// `limit` defaults to Amber's actual maximum (50) so one call covers any
// city with up to 50 properties — the common case.
export async function getProperties(city, page = 1, limit = 50, priority = "MEDIUM", source = "listings") {
    const json = await callGateway("listings", { city, page, limit }, { priority, source });
    rememberInventoryData(city, json);
    return extractArray(json);
}

export async function getPropertyBySlug(slug, priority = "HIGH", source = "property-detail") {
    if (!slug) return null;
    const summaryKey = listingSummaryCacheKey(slug);
    const summary = memoryCache.get(summaryKey) || await idbGet(summaryKey);
    if (summary) { memoryCache.set(summaryKey, summary); return summary.data; }
    const json = await callGateway("detail", { slug }, { priority, source });
    const arr = extractArray(json);
    arr.forEach((item) => { if (item?.canonical_name) setCached(listingSummaryCacheKey(item.canonical_name), item); });
    return Array.isArray(arr) && arr.length > 0 ? arr[0] : null;
}

// Cache-only by design: homepage cards never contact /api/amber on a miss.
export async function getCachedCityStats(city) {
    if (!city) return null;
    const key = cityStatsCacheKey(city);
    const entry = memoryCache.get(key) || await idbGet(key);
    if (!entry) return null;
    memoryCache.set(key, entry);
    return entry.data;
}

// The one deliberate exception to "cache-only": an explicit, opt-in, always
// LOW-priority live fetch — meant to be called sparingly (e.g. a slow,
// staggered background trickle, never an unconditional per-city burst on
// mount). LOW priority means the gateway itself will skip it outright rather
// than block if the shared Amber budget is tight, so this can never compete
// with a real user action (property open, search, listings navigation).
export async function lazyFetchCityStats(city) {
    if (!city) return null;
    try {
        const json = await callGateway("citystats", { city }, { priority: "LOW", source: "homepage-lazy-city-stats" });
        if (!json) return null; // gateway deliberately skipped it — budget was tight
        rememberInventoryData(city, json);
        return deriveCityStats(json);
    } catch (err) {
        if (!err.isRateLimit) devLog("lazyFetchCityStats failed for", city, err.message);
        return null;
    }
}