// Consolidated dispatcher for 4 originally-flat/nested, CRM-only public
// routes (properties/search, universities/resolve, staff, admin/
// accommodation/inventory-health) — reached via vercel.json `rewrites`
// that map each original URL onto this file, so nothing external (the
// separate CRM app, or any verify script) ever needs to change. See
// api/wishlist/[[...path]].js for the general dispatcher pattern.
const { matchRoute, vercelSegments } = require("../_lib/routeMatcher");
const routes = require("../_lib/routes/crm-tools");

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
