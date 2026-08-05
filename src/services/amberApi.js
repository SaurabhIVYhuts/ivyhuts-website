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

function fetchJson(url) {
    if (Date.now() < rateLimitedUntil) {
        const remaining = Math.ceil((rateLimitedUntil - Date.now()) / 1000);
        return Promise.reject(new AmberRateLimitError(remaining));
    }

    if (inFlight.has(url)) return inFlight.get(url);

    const promise = (async () => {
        console.log("Amber: fetching", url);
        const res = await fetch(url);
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