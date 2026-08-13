// GET /api/insights/snapshot-dates — powers the /insight calendar's
// availability dots. Returns only dates + a couple of headline numbers
// (never full snapshot bodies) for whichever dates have a stored snapshot.
// Same TEMPORARY RBAC bypass as the other /api/insights/* routes.
//
// ?month=YYYY-MM narrows to one month (what the calendar actually needs per
// render); omitted returns every stored date.
const { withErrorHandling } = require("../_lib/validation");
const { sendSuccess } = require("../_lib/apiResponse");
const { authorizeInsights } = require("../_lib/insightsDevAuth");
const { listSnapshotDates } = require("../_lib/insightsSnapshotStore");

module.exports = withErrorHandling(async (req, res) => {
    if (req.method !== "GET") {
        res.status(405).json({ error: "Method not allowed" });
        return;
    }
    const identity = await authorizeInsights(req, res);
    if (!identity) return;

    const { month } = req.query;
    const dates = await listSnapshotDates({ month });
    sendSuccess(res, { dates });
});
