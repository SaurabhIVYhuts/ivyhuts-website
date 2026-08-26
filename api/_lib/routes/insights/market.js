// GET /api/insights/market — internal roles only (MARKETING_AGENT,
// MARKETING_MANAGER, ADMIN; see api/_lib/insightsDevAuth.js, Milestone 22).
// Real, cache-only
// Amber market intelligence (sold-out vs available, asking price, country/
// city/pincode) for the /insight dashboard's Market Intelligence, Property
// Performance, Price Intelligence and Next-Year Opportunity sections. See
// api/_lib/insightsMarket.js — this endpoint never triggers a live Amber
// request, it only reads what's already cached. No MongoDB dependency here
// at all — this endpoint works with or without MONGODB_URI configured.
const { withErrorHandling } = require("../../validation");
const { sendSuccess } = require("../../apiResponse");
const { authorizeInsights } = require("../../insightsDevAuth");
const { getMarketIntelligence } = require("../../insightsMarket");

module.exports = withErrorHandling(async (req, res) => {
    if (req.method !== "GET") {
        res.status(405).json({ error: "Method not allowed" });
        return;
    }
    const identity = await authorizeInsights(req, res);
    if (!identity) return; // authorizeInsights already sent 401/403

    const { country, city } = req.query;
    const market = await getMarketIntelligence({ country, city });

    sendSuccess(res, market);
});
