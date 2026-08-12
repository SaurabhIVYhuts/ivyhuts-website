// GET /api/insights/overview — internal roles only in production (see
// api/_lib/insightsDevAuth.js for the TEMPORARY local-dev RBAC bypass —
// isolated to this file and api/insights/market.js only). Real CRM-derived
// numbers for the /insight dashboard's KPI cards, funnel, trend chart and
// lead-time section. See api/_lib/insightsCrm.js for how each number is
// computed and api/_lib/inventoryStats.js for the one Amber-derived KPI
// (site-wide sold-out/remaining), reused unchanged from the homepage stats.
const { withErrorHandling } = require("../_lib/validation");
const { sendSuccess } = require("../_lib/apiResponse");
const { authorizeInsights } = require("../_lib/insightsDevAuth");
const { getOverview, getDataStatus, EMPTY_OVERVIEW, EMPTY_DATA_STATUS } = require("../_lib/insightsCrm");
const { getInventoryStats } = require("../_lib/inventoryStats");
const { MongoNotConfiguredError } = require("../_lib/mongodb");

module.exports = withErrorHandling(async (req, res) => {
    if (req.method !== "GET") {
        res.status(405).json({ error: "Method not allowed" });
        return;
    }
    const identity = await authorizeInsights(req, res);
    if (!identity) return; // authorizeInsights already sent 401/403 (production path only)

    const { from, to, city, source } = req.query;

    // Amber-derived inventory KPI is independent of MongoDB — always attempt
    // it regardless of whether the CRM side below is available.
    const inventory = await getInventoryStats();

    // CRM (MongoDB) side: if MONGODB_URI isn't configured — the expected
    // local-dev state right now — degrade to an empty-but-shaped payload
    // instead of failing the whole request. Any OTHER error still surfaces
    // normally (withErrorHandling's usual 500/503 handling).
    let overview = EMPTY_OVERVIEW;
    let dataStatus = EMPTY_DATA_STATUS;
    let crmAvailable = true;
    let crmMessage = null;
    try {
        [overview, dataStatus] = await Promise.all([getOverview({ from, to, city, source }), getDataStatus()]);
    } catch (err) {
        if (!(err instanceof MongoNotConfiguredError)) throw err;
        crmAvailable = false;
        crmMessage = "CRM data unavailable — MongoDB is not configured in this environment.";
    }

    sendSuccess(res, { ...overview, inventory, dataStatus, crmAvailable, crmMessage });
});
