// Milestone 11 (IVYHUTS_MILESTONE_11_FIND_ROOM_CANONICAL_MIGRATION_REPORT.md):
// canonical, Mongo-only multi-city read for Find Room's `?country=` browse —
// replaces the old getPropertiesForCountry() live-Amber per-city fan-out.
//
// Takes `cities` (comma-separated, already resolved by the frontend from its
// own curated DESTINATIONS dataset — see accommodationIndex.js's
// getCitiesListings() for why city names, not a country string, are the
// correct join key here) rather than `country` — this endpoint never
// attempts its own country->city resolution, avoiding a second copy of that
// mapping (Part 18's explicit instruction).
//
// READ-ONLY: never triggers a refresh (see getCitiesListings()'s own
// header) — a country whose cities aren't all indexed yet simply returns
// whatever exists today; the existing refresh pipeline (city-level visits,
// the cache-warmer cron, the backfill script) is responsible for
// completeness, exactly as Part 7 specifies.
"use strict";
const { getCountryInventory } = require("./_lib/accommodationInventoryService");

module.exports = async (req, res) => {
    if (req.method !== "GET") {
        res.status(405).json({ error: "Method not allowed" });
        return;
    }

    const { cities } = req.query;
    if (!cities) {
        res.status(400).json({ error: "'cities' is required (comma-separated city names)" });
        return;
    }

    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const startedAt = Date.now();
    const cityList = String(cities).split(",").map((c) => c.trim()).filter(Boolean);

    try {
        const result = await getCountryInventory(cityList);
        const durationMs = Date.now() - startedAt;
        res.setHeader("Cache-Control", "public, max-age=30, stale-while-revalidate=120");
        console.log(`[COUNTRY_LISTINGS] requestId=${requestId} cities=${cityList.length} inventorySource=canonical-mongo status=${result.status} count=${result.residences.length} durationMs=${durationMs}`);
        res.status(200).json({ ok: true, status: result.status, residences: result.residences, requestId });
    } catch (err) {
        const durationMs = Date.now() - startedAt;
        console.log(`[COUNTRY_LISTINGS] requestId=${requestId} cities=${cityList.length} error=${err.message} durationMs=${durationMs}`);
        res.status(502).json({ ok: false, error: "upstream_error", message: "Could not load property data right now.", requestId });
    }
};
