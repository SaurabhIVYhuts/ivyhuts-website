// GET /api/insights/market — internal roles only in production (see
// api/_lib/insightsDevAuth.js for the TEMPORARY local-dev RBAC bypass —
// isolated to this file and api/insights/overview.js only). Real, cache-only
// Amber market intelligence (sold-out vs available, asking price, country/
// city/pincode) for the /insight dashboard's Market Intelligence, Property
// Performance, Price Intelligence and Next-Year Opportunity sections. See
// api/_lib/insightsMarket.js — this endpoint never triggers a live Amber
// request, it only reads what's already cached. No MongoDB dependency here
// at all — this endpoint works with or without MONGODB_URI configured.
const { withErrorHandling } = require("../_lib/validation");
const { sendSuccess } = require("../_lib/apiResponse");
const { authorizeInsights } = require("../_lib/insightsDevAuth");
const { getMarketIntelligence } = require("../_lib/insightsMarket");

module.exports = withErrorHandling(async (req, res) => {
    if (req.method !== "GET") {
        res.status(405).json({ error: "Method not allowed" });
        return;
    }
    const identity = await authorizeInsights(req, res);
    if (!identity) return; // authorizeInsights already sent 401/403 (production path only)

    const { country, city } = req.query;
    const market = await getMarketIntelligence({ country, city });

    sendSuccess(res, market);
});
