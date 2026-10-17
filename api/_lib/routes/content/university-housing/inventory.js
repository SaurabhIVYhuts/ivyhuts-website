// Milestone 9 (IVYHUTS_MILESTONE_9_UNIVERSITY_HOUSING_MIGRATION_REPORT.md):
// University Housing's canonical-inventory endpoint — GET /api/university-housing/inventory?city=
//
// This is the FIRST real consumer of Milestone 8's canonical service
// (api/_lib/accommodationInventoryService.js), wired here rather than at the
// page layer so University Housing gets its own clean observability surface
// (Part 19) distinct from Find Room's /api/city-listings, even though both
// ultimately read the same canonical Mongo inventory via the same
// accommodationIndex.js functions underneath — no duplicate logic, one
// canonical read path, two named entry points for two different pages'
// own request tracing.
//
// Response shape is deliberately identical to /api/city-listings
// ({ok, status, residences}) so the frontend can reuse the exact same
// src/services/amberMapper.js's safeResidenceListingList() mapper Find Room
// already uses — no second normalization contract (Part 4/Part 7).
//
// Milestone 20 (IVYHUTS_MILESTONE_20_ACCOMMODATION_ARCHITECTURE_IMPLEMENTATION.md):
// now calls the shared getAccommodationInventory() instead of getCityInventory()
// directly — expands `city` to its verified market area (marketAreas.js)
// before querying canonical Mongo, e.g. a University of Manchester search
// now also includes real, correctly-attributed Salford inventory. Response
// shape gains two ADDITIVE fields (primaryCity, marketCities); `residences`
// remains the same array shape every existing consumer already expects —
// zero breaking change for a client that ignores the new fields.
//
// City/country search: `?type=city&city=&country=` or
// `?type=country&country=&page=&limit=` reads the same canonical Mongo
// inventory for a whole city or country (see handleAreaSearch below).
// Without `type` the university path above is unchanged. Responses carry
// `locationType`/`total`/`page`/`hasMore`, so a country page is never
// mistaken for the complete country, and the URL (which includes type,
// location and page) keeps every CDN cache entry distinct per search.
"use strict";
const {
    getAccommodationInventory,
    getInventoryStatus,
    getCitySearchInventory,
    getCountrySearchInventoryPage,
} = require("../../../accommodationInventoryService");
const { canonicalizeCountry, curatedCitiesForCountry } = require("../../../locationResolver");
const { connectToDatabase, MongoNotConfiguredError } = require("../../../mongodb");

const VALID_PRIORITIES = new Set(["HIGH", "MEDIUM", "LOW"]);
const MAX_LOCATION_LENGTH = 120;

async function handleAreaSearch(req, res) {
    const { type, city, country, page, limit, priority, source } = req.query;
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const startedAt = Date.now();
    const cityName = typeof city === "string" ? city.trim().slice(0, MAX_LOCATION_LENGTH) : "";
    const countryInput = typeof country === "string" ? country.trim().slice(0, MAX_LOCATION_LENGTH) : "";

    if (type === "city" && !cityName) {
        res.status(400).json({ ok: false, error: "'city' is required for a city search" });
        return;
    }
    if (type === "country" && !countryInput) {
        res.status(400).json({ ok: false, error: "'country' is required for a country search" });
        return;
    }

    try {
        // Never invent a country: an unrecognised value is used verbatim,
        // which simply matches nothing rather than a guessed neighbour.
        const canonical = countryInput ? await canonicalizeCountry(countryInput) : null;
        const countryName = canonical ? canonical.fullName : countryInput || null;

        let result;
        if (type === "city") {
            const p = VALID_PRIORITIES.has(priority) ? priority : "MEDIUM";
            result = await getCitySearchInventory(cityName, { country: countryName, priority: p, source: source || "university-housing-city" });
        } else {
            result = await getCountrySearchInventoryPage(countryName, {
                fallbackCityNames: curatedCitiesForCountry(canonical),
                page,
                limit,
            });
        }

        const durationMs = Date.now() - startedAt;
        res.setHeader("Cache-Control", "public, max-age=30, stale-while-revalidate=120");
        console.log(
            `[UNIVERSITY_HOUSING_INVENTORY] requestId=${requestId} locationType=${type} city=${cityName || "-"} country=${countryName || "-"} ` +
            `inventorySource=canonical-mongo status=${result.status} count=${result.residences.length} total=${result.total} page=${result.page} durationMs=${durationMs}`
        );
        res.status(200).json({
            ok: true,
            status: result.status,
            residences: result.residences,
            locationType: type,
            city: type === "city" ? cityName : null,
            country: countryName,
            total: result.total,
            page: result.page,
            hasMore: result.hasMore,
            requestId,
        });
    } catch (err) {
        const durationMs = Date.now() - startedAt;
        console.log(`[UNIVERSITY_HOUSING_INVENTORY] requestId=${requestId} locationType=${type} error=${err.message} durationMs=${durationMs}`);
        res.status(502).json({ ok: false, error: "upstream_error", message: "Could not load property data right now.", requestId });
    }
}

// The shared inventory helpers (getCityListings/getCitiesListings, also used
// by Find Room) treat an unconfigured MongoDB as "building" with zero rows.
// For this endpoint that made a missing database indistinguishable from a
// genuinely empty city/country/university — the page showed "0 properties"
// instead of an error. Check once here and fail loudly; an unreachable (but
// configured) database already throws further down and returns 502.
async function ensureInventoryDatabase(res) {
    try {
        await connectToDatabase();
        return true;
    } catch (err) {
        if (!(err instanceof MongoNotConfiguredError)) throw err;
        console.log("[UNIVERSITY_HOUSING_INVENTORY] error=inventory_not_configured (MONGODB_URI is not set)");
        res.status(503).json({
            ok: false,
            error: "inventory_unavailable",
            message: "Accommodation inventory is unavailable: the database is not configured for this environment.",
        });
        return false;
    }
}

module.exports = async (req, res) => {
    if (req.method !== "GET") {
        res.status(405).json({ error: "Method not allowed" });
        return;
    }

    try {
        if (!(await ensureInventoryDatabase(res))) return;
    } catch (err) {
        console.log(`[UNIVERSITY_HOUSING_INVENTORY] database connection failed: ${err.message}`);
        res.status(502).json({ ok: false, error: "upstream_error", message: "Could not load property data right now." });
        return;
    }

    if (req.query.type === "city" || req.query.type === "country") {
        await handleAreaSearch(req, res);
        return;
    }

    const { city, priority, source } = req.query;
    if (!city) {
        res.status(400).json({ error: "'city' is required" });
        return;
    }

    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const startedAt = Date.now();

    try {
        const p = VALID_PRIORITIES.has(priority) ? priority : "MEDIUM";
        const s = source || "university-housing";

        // Observability read (Part 19) — a single, cheap, indexed Meta
        // lookup, separate from the real data read below, purely so this
        // endpoint's own logs can prove "0 Amber listing calls happened for
        // a FRESH/STALE city" without guessing from the response alone.
        // Never blocks or affects the real request if it fails.
        let statusBefore = null;
        try { statusBefore = await getInventoryStatus(city); } catch (_) { /* observability only */ }

        const result = await getAccommodationInventory({ city, priority: p, source: s });
        const durationMs = Date.now() - startedAt;

        res.setHeader("Cache-Control", "public, max-age=30, stale-while-revalidate=120");
        console.log(
            `[UNIVERSITY_HOUSING_INVENTORY] requestId=${requestId} city=${city} marketCities=${result.location.marketCities.join("+")} source=${s} priority=${p} ` +
            `inventorySource=canonical-mongo freshnessState=${statusBefore?.state || "unknown"} ` +
            `operationId=${statusBefore?.operationId || "-"} refreshStatus=${statusBefore?.refreshStatus || "-"} ` +
            `status=${result.status} count=${result.residences.length} durationMs=${durationMs}`
        );
        res.status(200).json({
            ok: true,
            status: result.status,
            residences: result.residences,
            primaryCity: result.location.primaryCity,
            marketCities: result.location.marketCities,
            requestId,
        });
    } catch (err) {
        const durationMs = Date.now() - startedAt;
        console.log(`[UNIVERSITY_HOUSING_INVENTORY] requestId=${requestId} city=${city} error=${err.message} durationMs=${durationMs}`);
        res.status(502).json({ ok: false, error: "upstream_error", message: "Could not load property data right now.", requestId });
    }
};
