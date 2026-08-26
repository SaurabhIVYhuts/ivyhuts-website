// Consolidated dispatcher for every /api/wishlist/** route — one Vercel
// Function instead of one per file (api/wishlist/index.js and
// api/wishlist/[propertyId].js used to each count separately toward the
// Hobby plan's 12-Function-per-deployment cap; see api/_lib/routes/wishlist.js
// for the route table and api/_lib/routeMatcher.js for why this only ever
// picks which unmodified handler to call — it never reimplements one).
// [[...path]] (optional catch-all) so this also matches the bare
// /api/wishlist base path (zero segments), not just its sub-paths.
const { matchRoute, vercelSegments } = require("../_lib/routeMatcher");
const routes = require("../_lib/routes/wishlist");

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
