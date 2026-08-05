const PARTNER_ID = "ivy-huts-707a5cdf";

const BASE_URL = `https://base.amberstudent.com/api/v0/leads/partners/${PARTNER_ID}`;

// Amber enforces a hard rate limit and returns
// { error: "Too many requests", retry_after: <seconds> } on a 403/429.
// Once we see one, we stop hitting the network entirely until it clears —
// hammering it again immediately only extends the cooldown.
let rateLimitedUntil = 0;

export class AmberRateLimitError extends Error {
    constructor(retryAfterSeconds) {
        super(`Amber API is rate limited. Try again in ${retryAfterSeconds}s.`);
        this.name = "AmberRateLimitError";
        this.isRateLimit = true;
        this.retryAfterSeconds = retryAfterSeconds;
    }
}

// De-dupe identical concurrent requests (e.g. React StrictMode's double-invoked
// effects, or a homepage that asks for the same city twice at once) so they
// share one network call instead of doubling our request volume.
const inFlight = new Map();

// Global throttle for actual outgoing requests: even a single fresh homepage
// load fans out ~14 different requests (12 city stats + a couple of property
// fetches) from several independent components at once. Caching prevents
// *repeat* bursts, but does nothing for that first cold one — this queue
// serializes real network calls with a minimum gap between them, no matter
// how many callers ask at the same instant, so we never look like a burst to
// Amber's rate limiter in the first place.
const MIN_FETCH_GAP_MS = 400;
let lastFetchAt = 0;
let fetchQueueTail = Promise.resolve();

function throttledFetch(url) {
    const turn = fetchQueueTail.then(async () => {
        // Only actually wait if another request went out too recently — an
        // isolated request (the common case) fires immediately; only a real
        // burst gets spaced out.
        const wait = lastFetchAt + MIN_FETCH_GAP_MS - Date.now();
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
        lastFetchAt = Date.now();
    });
    fetchQueueTail = turn;
    return turn.then(() => fetch(url));
}

// Amber's inventory data doesn't change second-to-second, and the biggest real
// source of repeat requests is simply re-rendering/reloading the app during
// normal use (every page reload used to refetch everything from scratch).
// Cache successful responses for a while — in memory always, and in
// IndexedDB too, so the cache survives an actual page reload, not just SPA
// navigation. IndexedDB (not sessionStorage/localStorage) is deliberate: a
// single 20-item city listing response measured ~13.7MB — Amber nests full
// room-type -> tenancy trees into every property — which blows past any
// Web Storage quota (~5-10MB total per origin) but fits IndexedDB fine.
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const DB_NAME = "ivyhuts-amber-cache";
const DB_STORE = "responses";

const memoryCache = new Map(); // url -> { data, expiresAt }

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
        console.warn("Amber: IndexedDB cache write failed (quota or unavailable):", err && err.message);
        // The in-memory cache still covers repeat requests within this page load.
    }
}

function setCached(url, data) {
    const expiresAt = Date.now() + CACHE_TTL_MS;
    memoryCache.set(url, { data, expiresAt });
    idbSet(url, { data, expiresAt }); // fire-and-forget; failures are non-fatal
}

function fetchJson(url) {
    // Fast synchronous checks first (memory cache + in-flight de-dupe) so
    // concurrent calls — e.g. React StrictMode's double-invoked effects —
    // still share one promise. The IndexedDB lookup below is async and would
    // otherwise let two near-simultaneous calls both slip past a cold cache.
    const mem = memoryCache.get(url);
    if (mem && Date.now() < mem.expiresAt) return Promise.resolve(mem.data);
    if (mem) memoryCache.delete(url);

    if (inFlight.has(url)) return inFlight.get(url);

    const promise = (async () => {
        const persisted = await idbGet(url);
        if (persisted && Date.now() < persisted.expiresAt) {
            console.log("Amber: cache hit (persisted)", url);
            memoryCache.set(url, persisted);
            return persisted.data;
        }

        if (Date.now() < rateLimitedUntil) {
            const remaining = Math.ceil((rateLimitedUntil - Date.now()) / 1000);
            throw new AmberRateLimitError(remaining);
        }

        console.log("Amber: fetching", url);
        const res = await throttledFetch(url);
        console.log("Amber: response status", res.status);

        if (res.status === 403 || res.status === 429) {
            const body = await res.json().catch(() => null);
            const retryAfter = (body && body.retry_after) || 60;
            rateLimitedUntil = Date.now() + retryAfter * 1000;
            console.error("Amber: rate limited, backing off for", retryAfter, "s");
            throw new AmberRateLimitError(retryAfter);
        }

        if (!res.ok) {
            const text = await res.text().catch(() => "");
            console.error("Amber fetch failed:", res.status, text);
            throw new Error("Failed to fetch properties");
        }

        try {
            const json = await res.json();
            console.log("Amber: raw json", json);
            setCached(url, json);
            return json;
        } catch (err) {
            console.error("Amber: invalid json", err);
            throw err;
        }
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

export async function getProperties(city, page = 1, limit = 20) {
    const baseUrl = `${BASE_URL}/inventories?p=${page}&limit=${limit}`;


    if (city) {
        const filteredUrl = `${baseUrl}&location_place_name=${encodeURIComponent(city)}`;
        try {
            const json = await fetchJson(filteredUrl);
            const arr = extractArray(json);

            if (Array.isArray(arr) && arr.length > 0) {
                console.log(`Amber: returning ${arr.length} filtered items`);
                return arr;
            }

            console.log("Amber: filtered request returned no items, will fetch unfiltered and filter on client");
        } catch (err) {
            // A rate limit means every request will fail right now, including the
            // fallback below — retrying immediately only makes the cooldown worse.
            if (err.isRateLimit) throw err;
            console.error("Amber: filtered request failed, will fallback to unfiltered fetch", err);
        }
    }


    const json = await fetchJson(baseUrl);
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
        console.log(`Amber: client-side filtered ${arr.length} -> ${filtered.length} items for city="${city}"`);
        arr = filtered;
    }

    return Array.isArray(arr) ? arr : [];
}

// Fetches a single property by Amber's `canonical_name` slug. Verified against
// live data: `?canonical_name=<slug>` returns exactly one matching item
// (meta.count: 1) — unlike `?id=`/`?slug=`, which are silently ignored by the API.
export async function getPropertyBySlug(slug) {
    if (!slug) return null;
    const url = `${BASE_URL}/inventories?canonical_name=${encodeURIComponent(slug)}`;
    const json = await fetchJson(url);
    const arr = extractArray(json);
    return Array.isArray(arr) && arr.length > 0 ? arr[0] : null;
}

// Lightweight per-city stats for homepage destination cards: real total property
// count (from meta.count) and a real sample starting price, using a single
// limit=1 request — never a full listing fetch just to show a badge number.
export async function getCityStats(city) {
    if (!city) return null;
    const url = `${BASE_URL}/inventories?location_place_name=${encodeURIComponent(city)}&p=1&limit=1`;
    try {
        const json = await fetchJson(url);
        const arr = extractArray(json);
        const count = json?.data?.meta?.count ?? null;
        const sample = Array.isArray(arr) && arr[0] ? arr[0] : null;
        const price = sample?.pricing?.min_price ?? sample?.pricing?.available_price ?? null;
        const currency = sample?.pricing?.currency ?? null;
        if (!count && !price) return null;
        return { count, price, currency };
    } catch (err) {
        if (!err.isRateLimit) console.error("Amber: getCityStats failed for", city, err);
        return null;
    }
}