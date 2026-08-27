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
"use strict";
const { getAccommodationInventory, getInventoryStatus } = require("../../../accommodationInventoryService");

const VALID_PRIORITIES = new Set(["HIGH", "MEDIUM", "LOW"]);

module.exports = async (req, res) => {
    if (req.method !== "GET") {
        res.status(405).json({ error: "Method not allowed" });
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
