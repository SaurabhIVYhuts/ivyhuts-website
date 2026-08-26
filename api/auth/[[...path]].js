// Consolidated dispatcher for every /api/auth/** route — see
// api/wishlist/[[...path]].js for the full explanation of this pattern.
const { matchRoute, vercelSegments } = require("../_lib/routeMatcher");
const routes = require("../_lib/routes/auth");

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
