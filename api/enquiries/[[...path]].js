// Consolidated dispatcher for every /api/enquiries/** route — see
// api/wishlist/[[...path]].js for the full explanation of this pattern
// (one Vercel Function instead of one per file, dispatcher never
// reimplements a handler, only picks which unmodified one to call).
const { matchRoute, vercelSegments } = require("../_lib/routeMatcher");
const routes = require("../_lib/routes/enquiries");

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
