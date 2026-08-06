const PARTNER_ID = "ivy-huts-707a5cdf";

const BASE_URL = `https://base.amberstudent.com/api/v0/leads/partners/${PARTNER_ID}`;

// Amber's hard limits (non-negotiable): max 10 requests/minute, a 5-minute
// halt if exceeded, max 50 inventories per call. Everything below exists to
// keep normal browsing nowhere near that ceiling — caching and request
// reduction are the primary defense; the budget guard further down is the
// last line of defense, not the strategy itself.
const DEV = process.env.NODE_ENV !== "production";
function devLog(...args) { if (DEV) console.log("[Amber]", ...args); }
function devWarn(...args) { if (DEV) console.warn("[Amber]", ...args); }

export class AmberRateLimitError extends Error {
    constructor(retryAfterSeconds) {
        super(`Amber API is rate limited. Try again in ${retryAfterSeconds}s.`);
        this.name = "AmberRateLimitError";
        this.isRateLimit = true;
        this.retryAfterSeconds = retryAfterSeconds;
    }
}

// Amber enforces its own hard rate limit and returns
// { error: "Too many requests", retry_after: <seconds> } on a 403/429.
// Once we see one, we stop hitting the network entirely until it clears —
// hammering it again immediately only extends the halt. Persisted to
// localStorage (not just an in-memory variable): a plain reload during an
// active halt must not "forget" it and immediately try again — that would
// either re-trigger the halt or extend it, which is exactly backwards.
const COOLDOWN_STORAGE_KEY = "amber_cooldown_until";

function readRateLimitedUntil() {
    try {
        return Number(window.localStorage.getItem(COOLDOWN_STORAGE_KEY)) || 0;
    } catch {
        return 0;
    }
}

function writeRateLimitedUntil(value) {
    try {
        window.localStorage.setItem(COOLDOWN_STORAGE_KEY, String(value));
    } catch {
        // localStorage unavailable — cooldown still holds for the rest of this page load.
    }
}

let rateLimitedUntil = readRateLimitedUntil();

// ── Human-readable label for a request URL, for dev logging only ──
function describeUrl(url) {
    try {
        const u = new URL(url);
        const p = u.searchParams;
        if (p.has("canonical_name")) return `detail:${p.get("canonical_name")}`;
        const city = p.get("location_place_name");
        if (city && p.get("limit") === "1") return `citystats:${city.toLowerCase()}`;
        if (city) return `listings:${city.toLowerCase()}`;
        return "listings:all";
    } catch {
        return url;
    }
}

// ══════════════════════════════════════════════════════════════════
// ROLLING RATE BUDGET — never intentionally exceed Amber's 10/min.
// We cap ourselves at 8/min (a safety margin, not the limit itself) and
// queue requests past that budget rather than firing them anyway. Queued
// requests are served in priority order: a property the user explicitly
// opened (HIGH) jumps ahead of a background homepage preload (LOW).
// ══════════════════════════════════════════════════════════════════
const RATE_BUDGET_PER_MINUTE = 8;
const RATE_WINDOW_MS = 60_000;
const requestTimestamps = []; // sliding window of actual outbound request times
let totalOutboundRequests = 0;

const PRIORITY_RANK = { HIGH: 0, MEDIUM: 1, LOW: 2 };
const budgetQueue = []; // { priority, resolve }
let drainingQueue = false;

function pruneWindow() {
    const cutoff = Date.now() - RATE_WINDOW_MS;
    while (requestTimestamps.length && requestTimestamps[0] < cutoff) requestTimestamps.shift();
}

function budgetRemaining() {
    pruneWindow();
    return RATE_BUDGET_PER_MINUTE - requestTimestamps.length;
}

function msUntilNextSlot() {
    pruneWindow();
    if (requestTimestamps.length < RATE_BUDGET_PER_MINUTE) return 0;
    return Math.max(0, requestTimestamps[0] + RATE_WINDOW_MS - Date.now());
}

function consumeBudgetSlot() {
    requestTimestamps.push(Date.now());
    totalOutboundRequests += 1;
    devLog(`RATE BUDGET ${requestTimestamps.length}/${RATE_BUDGET_PER_MINUTE}`);
}

function drainBudgetQueue() {
    if (drainingQueue) return;
    drainingQueue = true;
    (async () => {
        while (budgetQueue.length > 0) {
            const wait = msUntilNextSlot();
            if (wait > 0) {
                await new Promise((r) => setTimeout(r, Math.min(wait, 5000)));
                continue;
            }
            const next = budgetQueue.shift();
            consumeBudgetSlot();
            next.resolve();
        }
        drainingQueue = false;
    })();
}

// Reserves one slot in the rolling 8/minute budget before a real request is
// allowed to fire. Instant when budget is available; otherwise waits its
// turn, ordered by priority among everything else currently waiting.
function acquireBudgetSlot(priority) {
    if (budgetQueue.length === 0 && msUntilNextSlot() === 0) {
        consumeBudgetSlot();
        return Promise.resolve();
    }
    return new Promise((resolve) => {
        budgetQueue.push({ priority, resolve });
        budgetQueue.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);
        drainBudgetQueue();
    });
}

// Development-only visibility into what actually reached Amber.
export function getAmberRequestStats() {
    pruneWindow();
    return {
        totalSinceLoad: totalOutboundRequests,
        requestsInLastMinute: requestTimestamps.length,
        budgetPerMinute: RATE_BUDGET_PER_MINUTE,
        cooldownActive: Date.now() < rateLimitedUntil,
        cooldownRemainingSeconds: Date.now() < rateLimitedUntil ? Math.ceil((rateLimitedUntil - Date.now()) / 1000) : 0,
    };
}

// De-dupe identical concurrent requests (e.g. React StrictMode's double-invoked
// effects, or several homepage sections asking for the same city at once) so
// they share one network call instead of multiplying our request volume.
const inFlight = new Map();

// Minimum spacing between actual outgoing fetches, on top of the budget
// queue above — belt and braces against bursts within the same tick.
const MIN_FETCH_GAP_MS = 250;
let lastFetchAt = 0;
let fetchQueueTail = Promise.resolve();

function throttledFetch(url) {
    const turn = fetchQueueTail.then(async () => {
        const wait = lastFetchAt + MIN_FETCH_GAP_MS - Date.now();
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
        lastFetchAt = Date.now();
    });
    fetchQueueTail = turn;
    return turn.then(() => fetch(url));
}

// ══════════════════════════════════════════════════════════════════
// CACHE — in memory always, and in IndexedDB too so it survives an actual
// page reload, not just SPA navigation. IndexedDB (not sessionStorage) is
// deliberate: a single 20-item city listing response measured ~13.7MB —
// Amber nests full room-type -> tenancy trees into every property — which
// blows past any Web Storage quota (~5-10MB total per origin) but fits
// IndexedDB fine. Amber's own inventory data doesn't change second to
// second, so entries carry a "fresh" window (served with no extra work) and
// a longer "usable" window (served immediately, with an opportunistic,
// budget-permitting background refresh — stale-while-revalidate).
// ══════════════════════════════════════════════════════════════════
const DB_NAME = "ivyhuts-amber-cache";
const DB_STORE = "responses";

const TTL = {
    LISTINGS: { freshMs: 2 * 60_000, maxAgeMs: 10 * 60_000 },
    DETAIL: { freshMs: 5 * 60_000, maxAgeMs: 20 * 60_000 },
    CITY_STATS: { freshMs: 60 * 60_000, maxAgeMs: 6 * 60 * 60_000 },
};

const memoryCache = new Map(); // url -> { data, cachedAt }
const revalidating = new Set(); // urls currently being refreshed in the background

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

async function idbGet(url) {
    try {
        const db = await openDb();
        return await new Promise((resolve, reject) => {
            const req = db.transaction(DB_STORE, "readonly").objectStore(DB_STORE).get(url);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    } catch {
        return undefined;
    }
}

async function idbSet(url, entry) {
    try {
        const db = await openDb();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(DB_STORE, "readwrite");
            tx.objectStore(DB_STORE).put(entry, url);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    } catch (err) {
        devWarn("IndexedDB cache write failed (quota or unavailable):", err && err.message);
        // The in-memory cache still covers repeat requests within this page load.
    }
}

function setCached(url, data) {
    const entry = { data, cachedAt: Date.now() };
    memoryCache.set(url, entry);
    idbSet(url, entry); // fire-and-forget; failures are non-fatal
}

function isFresh(entry, freshMs) { return Date.now() - entry.cachedAt < freshMs; }
function isUsable(entry, maxAgeMs) { return Date.now() - entry.cachedAt < maxAgeMs; }

// Opportunistically refreshes a stale-but-usable cache entry in the
// background. Never blocks the caller (who already got the stale data), and
// never runs during a cooldown or when it would eat into the budget other
// requests might need.
function revalidateInBackground(url, priority, ttl) {
    if (Date.now() < rateLimitedUntil) return;
    if (revalidating.has(url)) return;
    if (budgetRemaining() <= 1) return; // leave at least one slot for real user actions
    revalidating.add(url);
    devLog("STALE — serving cached, revalidating in background:", describeUrl(url));
    doFetch(url, "LOW", ttl)
        .catch(() => {}) // stale data was already served; a failed refresh is fine
        .finally(() => revalidating.delete(url));
}

async function doFetch(url, priority, ttl) {
    if (Date.now() < rateLimitedUntil) {
        const remaining = Math.ceil((rateLimitedUntil - Date.now()) / 1000);
        devLog("COOLDOWN ACTIVE —", remaining, "s remaining");
        throw new AmberRateLimitError(remaining);
    }

    await acquireBudgetSlot(priority);

    devLog("REQUEST", describeUrl(url));
    const res = await throttledFetch(url);

    if (res.status === 403 || res.status === 429) {
        const body = await res.json().catch(() => null);
        const retryAfter = (body && body.retry_after) || 60;
        rateLimitedUntil = Date.now() + retryAfter * 1000;
        writeRateLimitedUntil(rateLimitedUntil);
        devWarn("Rate limited by Amber — cooldown for", retryAfter, "s");
        throw new AmberRateLimitError(retryAfter);
    }

    if (!res.ok) {
        const text = await res.text().catch(() => "");
        devWarn("Fetch failed:", res.status, text);
        throw new Error("Failed to fetch properties");
    }

    const json = await res.json();
    setCached(url, json);
    return json;
}

function fetchJson(url, { priority = "MEDIUM", ttl = TTL.LISTINGS } = {}) {
    // Fast synchronous path: fresh in memory already — return instantly, no
    // async work at all. Also the point where concurrent calls (e.g.
    // StrictMode's double-invoked effects) converge on shared in-flight dedup.
    const mem = memoryCache.get(url);
    if (mem && isFresh(mem, ttl.freshMs)) {
        devLog("CACHE HIT", describeUrl(url));
        return Promise.resolve(mem.data);
    }

    if (inFlight.has(url)) {
        devLog("DEDUPED", describeUrl(url));
        return inFlight.get(url);
    }

    const promise = (async () => {
        const entry = mem || (await idbGet(url));
        if (entry && !mem) memoryCache.set(url, entry);

        if (entry && isFresh(entry, ttl.freshMs)) {
            devLog("CACHE HIT (persisted)", describeUrl(url));
            return entry.data;
        }

        if (entry && isUsable(entry, ttl.maxAgeMs)) {
            revalidateInBackground(url, priority, ttl);
            return entry.data;
        }

        devLog("CACHE MISS", describeUrl(url));
        return await doFetch(url, priority, ttl);
    })();

    inFlight.set(url, promise);
    // NOT `promise.finally(...)` — `.finally()` returns a new promise that
    // re-rejects, and since that one isn't returned or caught anywhere, every
    // failed request (e.g. a rate limit) became an unhandled promise rejection.
    // `.then(onFulfilled, onRejected)` with matching handlers cleans up without
    // producing a second, unobserved rejected promise.
    promise.then(
        () => inFlight.delete(url),
        () => inFlight.delete(url)
    );
    return promise;
}

function findFirstArray(obj) {
    if (!obj || typeof obj !== "object") return null;
    for (const k of Object.keys(obj)) {
        if (Array.isArray(obj[k])) return obj[k];
        if (obj[k] && typeof obj[k] === "object") {
            const nested = findFirstArray(obj[k]);
            if (nested) return nested;
        }
    }
    return null;
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


    const anyArray = findFirstArray(json);
    return anyArray || [];
}

// `limit` defaults to Amber's actual maximum (50) — one bulk request covers
// any city with up to 50 properties, which is the common case. Only a city
// with more than 50 results would ever need a second (page=2) request, and
// only once the caller actually asks for it.
export async function getProperties(city, page = 1, limit = 50, priority = "MEDIUM") {
    const baseUrl = `${BASE_URL}/inventories?p=${page}&limit=${limit}`;

    if (city) {
        const filteredUrl = `${baseUrl}&location_place_name=${encodeURIComponent(city)}`;
        try {
            const json = await fetchJson(filteredUrl, { priority, ttl: TTL.LISTINGS });
            const arr = extractArray(json);

            if (Array.isArray(arr) && arr.length > 0) {
                return arr;
            }

            devLog("filtered request returned no items, falling back to unfiltered fetch");
        } catch (err) {
            // A rate limit means every request will fail right now, including the
            // fallback below — retrying immediately only makes the cooldown worse.
            if (err.isRateLimit) throw err;
            devWarn("filtered request failed, falling back to unfiltered fetch", err);
        }
    }

    const json = await fetchJson(baseUrl, { priority, ttl: TTL.LISTINGS });
    let arr = extractArray(json);

    // If a city was requested, and server-side filtering returned nothing or isn't supported,
    // perform a best-effort client-side filter by checking common location fields.
    if (city && Array.isArray(arr)) {
        const cityLower = city.toLowerCase();
        const filtered = arr.filter((item) => {
            try {
                const checks = [];
                if (item.location) {
                    if (item.location.locality && item.location.locality.long_name) checks.push(item.location.locality.long_name);
                    if (item.location.city && item.location.city.long_name) checks.push(item.location.city.long_name);
                    if (item.location.country && item.location.country.long_name) checks.push(item.location.country.long_name);
                }
                if (item.name) checks.push(item.name);
                if (item.address) {
                    if (typeof item.address === "string") checks.push(item.address);
                    if (item.address.locality) checks.push(item.address.locality);
                }
                return checks.some((s) => typeof s === "string" && s.toLowerCase().includes(cityLower));
            } catch (e) {
                return false;
            }
        });
        arr = filtered;
    }

    return Array.isArray(arr) ? arr : [];
}

// Fetches a single property by Amber's `canonical_name` slug. Verified against
// live data: `?canonical_name=<slug>` returns exactly one matching item
// (meta.count: 1) — unlike `?id=`/`?slug=`, which are silently ignored by the API.
export async function getPropertyBySlug(slug, priority = "HIGH") {
    if (!slug) return null;
    const url = `${BASE_URL}/inventories?canonical_name=${encodeURIComponent(slug)}`;
    const json = await fetchJson(url, { priority, ttl: TTL.DETAIL });
    const arr = extractArray(json);
    return Array.isArray(arr) && arr.length > 0 ? arr[0] : null;
}

// Lightweight per-city stats for homepage destination cards: real total property
// count (from meta.count) and a real sample starting price, using a single
// limit=1 request — never a full listing fetch just to show a badge number.
// Cached for hours: this is low-volatility "how many/how much" metadata, not
// live availability, so it's the one place a long TTL is clearly safe.
export async function getCityStats(city, priority = "LOW") {
    if (!city) return null;
    const url = `${BASE_URL}/inventories?location_place_name=${encodeURIComponent(city)}&p=1&limit=1`;
    try {
        const json = await fetchJson(url, { priority, ttl: TTL.CITY_STATS });
        const arr = extractArray(json);
        const count = json?.data?.meta?.count ?? null;
        const sample = Array.isArray(arr) && arr[0] ? arr[0] : null;
        const price = sample?.pricing?.min_price ?? sample?.pricing?.available_price ?? null;
        const currency = sample?.pricing?.currency ?? null;
        if (!count && !price) return null;
        return { count, price, currency };
    } catch (err) {
        if (!err.isRateLimit) devWarn("getCityStats failed for", city, err);
        return null;
    }
}