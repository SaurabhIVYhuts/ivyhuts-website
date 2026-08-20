// Mongo-first city browse/search endpoint — the general property listings
// page's counterpart to api/student-planner.js's own Mongo-first read (see
// api/_lib/accommodationIndex.js's getCityListings). Unlike api/amber.js
// (which always makes a live, rate-limited Amber call), this reads the
// already-indexed AccommodationResidence mirror first and only triggers a
// real Amber refresh (via the same budgeted/cached fetchListings gateway)
// when this city's index is missing or stale — so a city with more
// inventory than one live Amber call/page can return (confirmed live:
// London — Amber's own filter recognizes only 38 of 200+ properties) still
// shows everything this site has ever legitimately indexed for it, not just
// whatever the most recent live call happened to find.
//
// Milestone 21 (IVYHUTS_MILESTONE_21_FIND_ROOM_MIGRATION.md): now calls the
// shared getAccommodationInventory() (Milestone 20) instead of
// accommodationIndex.getCityListings() directly, so Find Room's ?city=/
// ?university=/?property= modes (all of which route through this same
// endpoint) get the same verified market-area expansion University Housing
// already has — e.g. a Manchester search now also includes real,
// correctly-attributed Salford inventory. For every city with no
// market-area entry (every city except Manchester today) this is BYTE-FOR-
// BYTE the same query/result as before (proven in Milestone 20's own
// regression suite) — zero behavior change for those cities. Response
// shape gains two additive fields (primaryCity, marketCities); `residences`
// is unchanged, so no frontend change was required.
"use strict";
const { getAccommodationInventory } = require("./_lib/accommodationInventoryService");

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

    try {
        const p = VALID_PRIORITIES.has(priority) ? priority : "MEDIUM";
        const s = source || "unknown";
        const result = await getAccommodationInventory({ city, priority: p, source: s });

        res.setHeader("Cache-Control", "public, max-age=30, stale-while-revalidate=120");
        console.log(`[CITY_LISTINGS] city=${city} marketCities=${result.location.marketCities.join("+")} source=${s} priority=${p} status=${result.status} count=${result.residences.length}`);
        res.status(200).json({
            ok: true,
            status: result.status,
            residences: result.residences,
            primaryCity: result.location.primaryCity,
            marketCities: result.location.marketCities,
        });
    } catch (err) {
        console.log(`[CITY_LISTINGS] city=${city} source=${source || "unknown"} error=${err.message}`);
        res.status(502).json({ ok: false, error: "upstream_error", message: "Could not load property data right now." });
    }
};
