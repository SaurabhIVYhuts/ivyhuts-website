// Geographic boundary resolution for University Housing's CITY / COUNTRY
// search map — the real administrative outline of the searched area, drawn
// as a visual overlay only. It never decides inventory membership: the
// inventory endpoint neither calls nor reads this module, and a missing or
// failed boundary only means the map has no outline.
//
// Source: OpenStreetMap Nominatim (polygon_geojson), the SAME provider the
// university pipeline already uses (universityDiscovery.js) — no new
// provider, no API key. Requests share that module's Redis-backed 1 req/s
// Nominatim budget (waitForRateSlot) and its identifying User-Agent, as the
// Nominatim usage policy requires.
//
// Only locations the site's own search catalog already knows are ever
// looked up (locationResolver.js) — an arbitrary query string can never be
// turned into an outbound Nominatim request.
//
// Selection is never "first result": candidates must be a polygon (a Point
// is not a boundary), of the right kind (country-level for a country;
// city/town/municipality/village for a city), named like the query, and are
// then ranked by name match, settlement kind, importance and size. Two
// equally good, non-overlapping matches are treated as ambiguous and drawn
// as nothing rather than guessed.
//
// Caching: found boundaries for 30 days, not-found for 1 hour (Redis via
// sharedStore + a small per-instance memo); a transient failure (rate limit,
// network, upstream error) is memoised for 60s in-instance only, never
// written to Redis. Concurrent requests for the same location share one
// in-flight lookup.
"use strict";

const { sharedGet, sharedSet, log } = require("./sharedStore");
const { withTimeout } = require("./withTimeout");
const { waitForRateSlot, USER_AGENT } = require("./universityDiscovery");
const { resolveLocationQuery, canonicalizeCountry, locationKey } = require("./locationResolver");

const NOMINATIM_SEARCH_URL = "https://nominatim.openstreetmap.org/search";
const NOMINATIM_TIMEOUT_MS = 8000;
const CACHE_PREFIX = "boundary:v1:";
const CACHE_READ_TIMEOUT_MS = 700;
const FOUND_TTL_S = 30 * 24 * 60 * 60;
const NOT_FOUND_TTL_S = 60 * 60;
const UNAVAILABLE_MEMO_MS = 60 * 1000;
const MEM_CACHE_MAX = 200;
const MAX_INPUT_LENGTH = 120;
// Total vertices after simplification/rounding. Real values seen live:
// United States ~9k, Greater Sydney ~1.4k — this only stops a pathological
// geometry from becoming a multi-megabyte response.
const MAX_POINTS = 60000;
const ATTRIBUTION = "© OpenStreetMap contributors (ODbL)";

// Nominatim server-side simplification (degrees) and output rounding
// (decimal places): ~50m / ~1m for a city, ~1km / ~10m for a country —
// detailed enough at the zoom each is viewed at, small enough to ship.
const PROFILE = {
    city: { threshold: "0.0005", precision: 5 },
    country: { threshold: "0.01", precision: 4 },
};

// Settlement kinds a CITY search may resolve to, best first. Anything else
// (suburb, county, state, country, hamlet…) is not "the city".
const SETTLEMENT_TIER = { city: 0, town: 1, municipality: 2, village: 3 };
const COUNTRY_FALLBACK_MAX_RANK = 8; // e.g. Hong Kong: an admin region (rank 6), not a "country" in OSM
const AMBIGUITY_IMPORTANCE_GAP = 0.02;

// ── geometry ──

function normalizeRing(ring, precision) {
    if (!Array.isArray(ring)) return null;
    const f = 10 ** precision;
    const out = [];
    for (const pos of ring) {
        if (!Array.isArray(pos) || pos.length < 2) return null;
        const lng = Number(pos[0]);
        const lat = Number(pos[1]);
        if (!Number.isFinite(lng) || !Number.isFinite(lat) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
        const p = [Math.round(lng * f) / f, Math.round(lat * f) / f];
        const prev = out[out.length - 1];
        if (!prev || prev[0] !== p[0] || prev[1] !== p[1]) out.push(p);
    }
    if (out.length && (out[0][0] !== out[out.length - 1][0] || out[0][1] !== out[out.length - 1][1])) out.push([out[0][0], out[0][1]]);
    return out.length >= 4 ? out : null; // a closed ring needs 3 distinct vertices + closure
}

function normalizePolygon(rings, precision) {
    if (!Array.isArray(rings) || !rings.length) return null;
    const outer = normalizeRing(rings[0], precision);
    if (!outer) return null; // no valid outer ring: drop the whole part
    const holes = rings.slice(1).map((r) => normalizeRing(r, precision)).filter(Boolean);
    return [outer, ...holes];
}

// Validated, rounded GeoJSON Polygon/MultiPolygon, or null. Invalid parts are
// dropped individually; a geometry with no valid part left is rejected.
function normalizeGeometry(geojson, precision) {
    if (!geojson || !Array.isArray(geojson.coordinates)) return null;
    let parts;
    if (geojson.type === "Polygon") parts = [geojson.coordinates];
    else if (geojson.type === "MultiPolygon") parts = geojson.coordinates;
    else return null;
    const valid = parts.map((p) => normalizePolygon(p, precision)).filter(Boolean);
    if (!valid.length) return null;
    const points = valid.reduce((n, poly) => n + poly.reduce((m, ring) => m + ring.length, 0), 0);
    if (points > MAX_POINTS) return null;
    return valid.length === 1 ? { type: "Polygon", coordinates: valid[0] } : { type: "MultiPolygon", coordinates: valid };
}

function ringBox(ring) {
    const box = { s: 90, n: -90, w: 180, e: -180 };
    for (const [lng, lat] of ring) {
        if (lat < box.s) box.s = lat;
        if (lat > box.n) box.n = lat;
        if (lng < box.w) box.w = lng;
        if (lng > box.e) box.e = lng;
    }
    return box;
}

function ringArea(ring) {
    let sum = 0;
    for (let i = 0; i < ring.length - 1; i++) sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    return Math.abs(sum / 2);
}

function unionBoxes(boxes) {
    return boxes.reduce((a, b) => ({ s: Math.min(a.s, b.s), n: Math.max(a.n, b.n), w: Math.min(a.w, b.w), e: Math.max(a.e, b.e) }));
}

// Framing thresholds (see computeFitBounds): a part must be at least this
// share of the largest part's area, and lie within this multiple of the
// largest part's own span (never less than FIT_MIN_REACH_DEG) of it.
const FIT_MIN_PART_SHARE = 0.005;
const FIT_REACH_FACTOR = 0.75;
const FIT_MIN_REACH_DEG = 5;

function boxGap(a, b) {
    return {
        lng: Math.max(0, a.w - b.e, b.w - a.e),
        lat: Math.max(0, a.s - b.n, b.s - a.n),
    };
}

// [[south, west], [north, east]] to frame the boundary. Every part is still
// DRAWN; this only decides the initial viewport (the client also adds the
// property markers to it). Framed: the largest part, plus every part that
// is both significant (≥0.5% of its area — keeps Tasmania, Alaska,
// Northern Ireland, Corsica) and near it. Confirmed live, without this:
// France's overseas regions (French Guiana, New Caledonia), Australia's
// Heard Island and American Samoa framed mostly empty ocean, and New
// Zealand's Chatham Islands (across the antimeridian, so far away in raw
// longitude) framed the whole world.
function computeFitBounds(geometry) {
    const polys = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
    const parts = polys.map((p) => ({ box: ringBox(p[0]), area: ringArea(p[0]) }));
    const largest = parts.reduce((a, b) => (b.area > a.area ? b : a));
    const reach = Math.max(FIT_MIN_REACH_DEG, FIT_REACH_FACTOR * Math.max(largest.box.e - largest.box.w, largest.box.n - largest.box.s));
    const chosen = parts.filter((p) => {
        if (p === largest) return true;
        if (p.area < largest.area * FIT_MIN_PART_SHARE) return false;
        const gap = boxGap(p.box, largest.box);
        return gap.lng <= reach && gap.lat <= reach;
    });
    const b = unionBoxes(chosen.map((p) => p.box));
    return [[b.s, b.w], [b.n, b.e]];
}

function boxesOverlap(a, b) {
    return a.s <= b.n && b.s <= a.n && a.w <= b.e && b.w <= a.e;
}

// ── candidate selection ──

// 3 = Nominatim linked this boundary to the place node of that name
//     (`_place_name`): "Greater London" carries _place_name:en "London" —
//     the boundary that IS the city,
// 2 = the query is this boundary's own (English/official) name,
// 1 = a weak match: a short name, or the query as a whole word of the name.
//     Confirmed live: the City of London (the square mile) has
//     short_name "London", so short names must never outrank 3/2,
// 0 = unrelated.
function nameScore(result, queryKey) {
    const nd = result.namedetails || {};
    const keys = (...vals) => vals.filter(Boolean).map(locationKey);
    if (keys(nd._place_name, nd["_place_name:en"]).includes(queryKey)) return 3;
    const primary = keys(result.name, nd.name, nd["name:en"], nd.official_name, nd["official_name:en"]);
    if (primary.includes(queryKey)) return 2;
    if (keys(nd.short_name, nd["short_name:en"]).includes(queryKey)) return 1;
    if (primary.some((n) => ` ${n} `.includes(` ${queryKey} `))) return 1;
    return 0;
}

function categoryOf(result) {
    return result.category || result.class || null;
}

function isAreaFeature(result) {
    const cat = categoryOf(result);
    return (cat === "boundary" && result.type === "administrative") || cat === "place";
}

function toCandidate(result, profile) {
    if (!isAreaFeature(result)) return null;
    const geometry = normalizeGeometry(result.geojson, profile.precision);
    if (!geometry) return null;
    return { result, geometry, importance: Number(result.importance) || 0, rank: Number(result.place_rank) || 99 };
}

function toFound(candidate, locationType, query) {
    const { result, geometry } = candidate;
    return {
        status: "found",
        locationType,
        name: result.name || null,
        query,
        geometry,
        bounds: computeFitBounds(geometry),
        source: {
            provider: "OpenStreetMap Nominatim",
            osmType: result.osm_type || null,
            osmId: result.osm_id != null ? String(result.osm_id) : null,
            kind: result.addresstype || null,
        },
        attribution: ATTRIBUTION,
    };
}

function selectCity(results, cityName) {
    const key = locationKey(cityName);
    const candidates = results
        .filter((r) => Object.prototype.hasOwnProperty.call(SETTLEMENT_TIER, r.addresstype))
        .map((r) => {
            const c = toCandidate(r, PROFILE.city);
            if (!c) return null;
            c.nameScore = nameScore(r, key);
            c.tier = SETTLEMENT_TIER[r.addresstype];
            return c.nameScore > 0 ? c : null;
        })
        .filter(Boolean)
        .sort((a, b) => b.nameScore - a.nameScore || a.tier - b.tier || b.importance - a.importance || a.rank - b.rank);
    if (!candidates.length) return { status: "not_found", reason: "no_polygon_match" };
    const [best, next] = candidates;
    if (
        next && next.nameScore === best.nameScore && next.tier === best.tier &&
        best.importance - next.importance < AMBIGUITY_IMPORTANCE_GAP &&
        !boxesOverlap(ringBoxOf(best.geometry), ringBoxOf(next.geometry))
    ) {
        return { status: "not_found", reason: "ambiguous" };
    }
    return { status: "found", candidate: best };
}

function ringBoxOf(geometry) {
    const polys = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
    return unionBoxes(polys.map((p) => ringBox(p[0])));
}

// Structured `country=` search: the result's addresstype must be "country".
// No name check — OSM's English name may legitimately differ from the
// site's (Czech Republic -> "Czechia"); the structured query already
// constrains the match.
function selectCountry(results) {
    const best = results
        .filter((r) => r.addresstype === "country")
        .map((r) => toCandidate(r, PROFILE.country))
        .filter(Boolean)
        .sort((a, b) => b.importance - a.importance)[0];
    return best ? { status: "found", candidate: best } : { status: "not_found", reason: "no_country_polygon" };
}

// Free-text fallback for territories OSM doesn't tag as countries (Hong
// Kong): an administrative boundary, exactly the same name, region level
// or above. Larger (lower rank) wins a tie.
function selectCountryFallback(results, countryName) {
    const key = locationKey(countryName);
    const best = results
        .filter((r) => categoryOf(r) === "boundary" && r.type === "administrative" && Number(r.place_rank) <= COUNTRY_FALLBACK_MAX_RANK)
        .filter((r) => nameScore(r, key) >= 2)
        .map((r) => toCandidate(r, PROFILE.country))
        .filter(Boolean)
        .sort((a, b) => b.importance - a.importance || a.rank - b.rank)[0];
    return best ? { status: "found", candidate: best } : { status: "not_found", reason: "no_country_polygon" };
}

// ── Nominatim ──

async function nominatimSearch(params, profile) {
    const gotSlot = await waitForRateSlot().catch(() => false);
    if (!gotSlot) {
        const err = new Error("Nominatim rate limit budget exhausted");
        err.code = "RATE_LIMITED";
        throw err;
    }
    const url = `${NOMINATIM_SEARCH_URL}?${new URLSearchParams({
        ...params,
        format: "jsonv2",
        polygon_geojson: "1",
        polygon_threshold: profile.threshold,
        addressdetails: "1",
        namedetails: "1",
        limit: "5",
        "accept-language": "en",
    }).toString()}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), NOMINATIM_TIMEOUT_MS);
    try {
        const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" }, signal: controller.signal });
        if (!res.ok) {
            const err = new Error(`Nominatim returned ${res.status}`);
            err.code = "UPSTREAM_ERROR";
            throw err;
        }
        const body = await res.json();
        return Array.isArray(body) ? body : [];
    } finally {
        clearTimeout(timeout);
    }
}

// Throws on a transient failure (the caller maps it to "unavailable").
async function lookupBoundary(locationType, cityName, countryName) {
    const query = { city: cityName || null, country: countryName };
    if (locationType === "city") {
        const results = await nominatimSearch({ city: cityName, country: countryName }, PROFILE.city);
        const pick = selectCity(results, cityName);
        return pick.status === "found" ? toFound(pick.candidate, locationType, query) : { status: "not_found", locationType, query, reason: pick.reason };
    }
    let pick = selectCountry(await nominatimSearch({ country: countryName }, PROFILE.country));
    if (pick.status !== "found") pick = selectCountryFallback(await nominatimSearch({ q: countryName }, PROFILE.country), countryName);
    return pick.status === "found" ? toFound(pick.candidate, locationType, query) : { status: "not_found", locationType, query, reason: pick.reason };
}

// ── caching ──

const memCache = new Map(); // key -> {value, expiresAt}
const inFlight = new Map(); // key -> Promise

function memGet(key) {
    const hit = memCache.get(key);
    if (!hit) return undefined;
    if (Date.now() >= hit.expiresAt) {
        memCache.delete(key);
        return undefined;
    }
    return hit.value;
}

function memSet(key, value, ttlMs) {
    if (memCache.size >= MEM_CACHE_MAX) memCache.delete(memCache.keys().next().value);
    memCache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

function clean(value) {
    return typeof value === "string" ? value.trim().slice(0, MAX_INPUT_LENGTH) : "";
}

// Resolves {type: "city"|"country", city?, country} to one of:
//   {status: "found", locationType, name, query, geometry, bounds, source, attribution}
//   {status: "not_found", locationType, query, reason}
//   {status: "unavailable", locationType, reason}      (transient; not persisted)
//   {status: "invalid", reason}                        (bad input; no lookup)
// Never throws.
async function resolveLocationBoundary({ type, city, country } = {}) {
    if (type !== "city" && type !== "country") return { status: "invalid", reason: "type must be city or country" };
    const cityInput = clean(city);
    const countryInput = clean(country);
    if (type === "city" && !cityInput) return { status: "invalid", reason: "'city' is required" };
    if (!countryInput) return { status: "invalid", reason: "'country' is required" };

    let countryName;
    let cityName = null;
    try {
        const canonical = await canonicalizeCountry(countryInput);
        if (!canonical) return { status: "not_found", locationType: type, query: { city: cityInput || null, country: countryInput }, reason: "unknown_location" };
        countryName = canonical.fullName;
        if (type === "city") {
            const resolved = await resolveLocationQuery(`${cityInput}, ${countryName}`);
            if (resolved?.status !== "resolved" || resolved.record.type !== "CITY") {
                return { status: "not_found", locationType: type, query: { city: cityInput, country: countryName }, reason: "unknown_location" };
            }
            cityName = resolved.record.city;
        }
    } catch (err) {
        log(`[boundaryResolver] action=CATALOG_LOOKUP_FAILED error=${err.message}`);
        return { status: "unavailable", locationType: type, reason: "catalog_unavailable" };
    }

    const key = `${CACHE_PREFIX}${type}:${locationKey(countryName)}:${type === "city" ? locationKey(cityName) : ""}`;
    const memo = memGet(key);
    if (memo) return memo;
    if (inFlight.has(key)) return inFlight.get(key);

    const promise = (async () => {
        let stored;
        try {
            stored = await withTimeout(sharedGet(key), CACHE_READ_TIMEOUT_MS, undefined);
        } catch (err) {
            log(`[boundaryResolver] action=CACHE_READ_FAILED key=${key} error=${err.message}`);
        }
        if (stored && (stored.status === "found" || stored.status === "not_found")) {
            memSet(key, stored, (stored.status === "found" ? FOUND_TTL_S : NOT_FOUND_TTL_S) * 1000);
            return stored;
        }

        let result;
        try {
            result = await lookupBoundary(type, cityName, countryName);
        } catch (err) {
            const reason = err.code || (err.name === "AbortError" ? "TIMEOUT" : "UPSTREAM_ERROR");
            log(`[boundaryResolver] action=LOOKUP_UNAVAILABLE key=${key} reason=${reason} error=${err.message}`);
            result = { status: "unavailable", locationType: type, reason };
            memSet(key, result, UNAVAILABLE_MEMO_MS);
            return result;
        }
        const ttlS = result.status === "found" ? FOUND_TTL_S : NOT_FOUND_TTL_S;
        memSet(key, result, ttlS * 1000);
        try {
            await sharedSet(key, result, ttlS);
        } catch (err) {
            log(`[boundaryResolver] action=CACHE_WRITE_FAILED key=${key} error=${err.message}`);
        }
        log(`[boundaryResolver] action=LOOKUP key=${key} status=${result.status}${result.source ? ` osm=${result.source.osmType}/${result.source.osmId}` : ""}${result.reason ? ` reason=${result.reason}` : ""}`);
        return result;
    })().finally(() => inFlight.delete(key));
    inFlight.set(key, promise);
    return promise;
}

module.exports = {
    resolveLocationBoundary,
    // Exported for scripts/verify-location-boundaries.js.
    normalizeGeometry,
    computeFitBounds,
    selectCity,
    selectCountry,
    selectCountryFallback,
    CACHE_PREFIX,
    _resetBoundaryMemo: () => { memCache.clear(); inFlight.clear(); },
};
