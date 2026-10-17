// GET /api/location-boundary?type=city&city=&country=  |  ?type=country&country=
//
// The administrative outline of a searched city/country for University
// Housing's map (api/_lib/boundaryResolver.js). Purely visual context: this
// endpoint is independent of /api/university-housing/inventory, touches no
// inventory or Amber code, and a missing/failed boundary is a normal 200
// with status "not_found"/"unavailable" — the client then just draws no
// outline.
//
// CDN caching follows the resolver's own cache policy: a found boundary is
// long-lived (OSM administrative boundaries change rarely), not-found is
// short, and a transient failure is never cached.
"use strict";
const { resolveLocationBoundary } = require("../../boundaryResolver");

const CACHE_CONTROL = {
    found: "public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400",
    not_found: "public, max-age=900, s-maxage=3600",
    unavailable: "no-store",
};

module.exports = async (req, res) => {
    if (req.method !== "GET") {
        res.status(405).json({ ok: false, error: "Method not allowed" });
        return;
    }
    const { type, city, country } = req.query || {};
    const startedAt = Date.now();
    try {
        const result = await resolveLocationBoundary({ type, city, country });
        if (result.status === "invalid") {
            res.status(400).json({ ok: false, error: result.reason });
            return;
        }
        res.setHeader("Cache-Control", CACHE_CONTROL[result.status] || "no-store");
        console.log(
            `[LOCATION_BOUNDARY] type=${type} city=${city || "-"} country=${country || "-"} status=${result.status}` +
            `${result.reason ? ` reason=${result.reason}` : ""} durationMs=${Date.now() - startedAt}`
        );
        res.status(200).json({ ok: true, ...result });
    } catch (err) {
        console.log(`[LOCATION_BOUNDARY] type=${type} error=${err.message}`);
        res.setHeader("Cache-Control", "no-store");
        res.status(500).json({ ok: false, error: "boundary_error" });
    }
};
