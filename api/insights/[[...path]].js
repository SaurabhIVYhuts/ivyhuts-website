// Consolidated dispatcher for every /api/insights/** route — see
// api/wishlist/[[...path]].js for the full explanation of this pattern.
// vercel.json's "functions" maxDuration override for this file is 60s
// (daily-digest's own former override — the longest of the six merged
// routes; safely covers the shorter ones too).
const { matchRoute, vercelSegments } = require("../_lib/routeMatcher");
const routes = require("../_lib/routes/insights");

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
