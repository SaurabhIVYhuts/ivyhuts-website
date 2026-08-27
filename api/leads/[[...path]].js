// Consolidated dispatcher for 17 of the 18 /api/leads/** routes — see
// api/wishlist/[[...path]].js for the general pattern this follows.
// api/leads/meta/webhook.js is NOT covered here — it stays its own
// standalone Vercel Function (see api/_lib/routes/leads.js's header
// comment for why: it needs the raw, unparsed request body, which this
// dispatcher's siblings all assume Vercel already JSON-parsed for them).
const { matchRoute, vercelSegments } = require("../_lib/routeMatcher");
const routes = require("../_lib/routes/leads");

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
