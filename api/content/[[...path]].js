// Consolidated dispatcher for 11 originally-flat, unrelated public routes
// (amber, city-listings, country-listings, search, search-data,
// university-housing/inventory, student-planner, student-planner-ppt,
// enquire, events, warm-amber-cache) — reached via vercel.json `rewrites`
// that map each original URL (e.g. /api/amber) onto this file
// (/api/content/amber) so nothing external ever needs to change. See
// api/wishlist/[[...path]].js for the general dispatcher pattern.
//
// vercel.json's "functions" maxDuration override for this file is 30s
// (amber/city-listings/student-planner's own former override — the longest
// among these 11; safely covers student-planner-ppt's former 15s too).
const { matchRoute, vercelSegments } = require("../_lib/routeMatcher");
const routes = require("../_lib/routes/content");

module.exports = async (req, res) => {
    const segments = vercelSegments(req);
    const match = matchRoute(routes, segments);
    if (!match) {
        res.status(404).json({ error: "Not found" });
        return;
    }
    Object.assign(req.query, match.params);
    await match.handler(req, res);
};
