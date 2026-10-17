// Client for GET /api/location-boundary (api/_lib/routes/content/location-boundary.js):
// the real administrative outline of a searched city/country, drawn on the
// University Housing map as visual context only.
//
// Never rejects — every failure resolves to `null` ("draw no outline"), so a
// boundary problem can never surface as a search error or touch listings.
// Results are memoised per location for the session (the server and CDN
// cache too), and concurrent callers share one request, so re-renders,
// filter changes and switching back to an earlier search never re-fetch.
// This file has no inventory/Amber dependency, by design.

const FOUND_TTL_MS = 6 * 60 * 60 * 1000;
const NOT_FOUND_TTL_MS = 10 * 60 * 1000;
const FAILURE_TTL_MS = 60 * 1000;
const MAX_ENTRIES = 50;

const cache = new Map(); // key -> {promise, expiresAt}

export function boundaryKey({ type, city, country }) {
  const norm = (s) => String(s || "").trim().toLowerCase();
  return `${norm(type)}|${type === "city" ? norm(city) : ""}|${norm(country)}`;
}

function isRenderableGeometry(geometry) {
  return Boolean(geometry)
    && (geometry.type === "Polygon" || geometry.type === "MultiPolygon")
    && Array.isArray(geometry.coordinates)
    && geometry.coordinates.length > 0;
}

function isValidBounds(bounds) {
  return Array.isArray(bounds) && bounds.length === 2
    && bounds.every((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite));
}

// Resolves to {key, name, geometry, bounds, attribution} or null.
export function getLocationBoundary({ type, city, country }) {
  const key = boundaryKey({ type, city, country });
  const hit = cache.get(key);
  if (hit && Date.now() < hit.expiresAt) return hit.promise;

  const entry = { expiresAt: Infinity, promise: null }; // in-flight: shared until settled
  const settle = (ttl) => { entry.expiresAt = Date.now() + ttl; };
  const params = new URLSearchParams({ type });
  if (type === "city" && city) params.set("city", city);
  if (country) params.set("country", country);

  // Started inside the chain so even a synchronous fetch failure resolves to null.
  entry.promise = Promise.resolve()
    .then(() => fetch(`/api/location-boundary?${params.toString()}`))
    .then((res) => res.json())
    .then((body) => {
      if (body?.ok && body.status === "found" && isRenderableGeometry(body.geometry) && isValidBounds(body.bounds)) {
        settle(FOUND_TTL_MS);
        return { key, name: body.name || null, geometry: body.geometry, bounds: body.bounds, attribution: body.attribution || null };
      }
      settle(body?.ok && body.status === "not_found" ? NOT_FOUND_TTL_MS : FAILURE_TTL_MS);
      return null;
    })
    .catch(() => {
      settle(FAILURE_TTL_MS);
      return null;
    });

  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value);
  cache.set(key, entry);
  return entry.promise;
}

// Test-only.
export function _resetBoundaryCache() {
  cache.clear();
}
