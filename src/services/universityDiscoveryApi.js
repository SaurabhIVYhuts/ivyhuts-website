// Frontend client for /api/universities/resolve (AI-assisted university
// discovery — Tier 1 curated -> Tier 2 Mongo -> local fuzzy -> AI-assisted
// interpretation -> Nominatim, all server-side; see
// api/_lib/universityResolveService.js for the full pipeline).
//
// Deliberately separate from src/services/amberApi.js and calls a
// completely different endpoint (/api/universities/resolve, never
// /api/amber) — this file has zero knowledge of Amber and never will. It
// only ever returns a university/school location record (id/name/type/
// city/country/address/latitude/longitude); accommodation retrieval for
// that city remains the EXISTING getProperties() flow in amberApi.js,
// triggered separately once a university is resolved (see
// UniversityHousingPage.js) — never from here.
//
// No client-side caching here beyond the browser's own request lifecycle:
// discovery calls are already deduplicated/rate-limited/cached server-side
// (Redis-backed AI + Nominatim budgets, a server-side Tier 2 cache — see
// api/_lib/universityDiscovery.js and universityAI.js), and search-as-you-go
// UX means every call already has a distinct query, so an L1 cache like
// amberApi.js's would rarely hit anyway.

async function parseJsonSafe(res) {
    try {
        return await res.json();
    } catch {
        return null;
    }
}

// Returns { status: "resolved"|"ambiguous"|"not_found"|"unavailable", data }
// — `data` is a single university record for "resolved", an array of
// candidate records for "ambiguous", or null otherwise. Never throws: a
// network failure or malformed response is itself represented as
// status "unavailable" so callers can render one consistent state.
export async function searchUniversityDiscovery(query, { signal } = {}) {
    const trimmed = String(query || "").trim();
    if (!trimmed) return { status: "not_found", data: null };

    let res;
    try {
        res = await fetch(`/api/universities/resolve?q=${encodeURIComponent(trimmed)}`, { signal });
    } catch (err) {
        if (err.name === "AbortError") throw err; // let the caller's own abort-handling deal with this, not our error state
        return { status: "unavailable", data: null };
    }

    if (!res.ok && res.status !== 400) return { status: "unavailable", data: null };
    const body = await parseJsonSafe(res);
    if (!body || body.ok !== true) return { status: "unavailable", data: null };
    return { status: body.status, data: body.data };
}

export async function resolveUniversityById(id, { signal } = {}) {
    if (!id) return null;
    let res;
    try {
        res = await fetch(`/api/universities/resolve?id=${encodeURIComponent(id)}`, { signal });
    } catch {
        return null;
    }
    if (!res.ok) return null;
    const body = await parseJsonSafe(res);
    if (!body || body.ok !== true || body.status !== "resolved") return null;
    return body.data;
}

// Confirms one candidate the user explicitly picked from an "ambiguous"
// result set — the server re-validates and persists it (see
// validateConfirmedCandidate in universityResolveService.js) without
// spending a second discovery round.
export async function confirmUniversityCandidate(query, candidate) {
    let res;
    try {
        res = await fetch("/api/universities/resolve", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query, candidate }),
        });
    } catch {
        return { status: "unavailable", data: null };
    }
    const body = await parseJsonSafe(res);
    if (!body || body.ok !== true) return { status: "unavailable", data: null };
    return { status: body.status, data: body.data };
}
