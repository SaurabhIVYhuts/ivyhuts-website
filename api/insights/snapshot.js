// GET /api/insights/snapshot — the single data feed for the whole /insight
// dashboard, live and historical alike. Same TEMPORARY RBAC bypass as
// api/insights/market.js and api/insights/overview.js (see
// api/_lib/insightsDevAuth.js).
//
// ?date=YYYY-MM-DD (default: today, IST):
//   - date === today  -> mode:"live". Calls getMarketIntelligence() directly
//     (identical cost/shape to the existing /api/insights/market — no extra
//     Amber traffic beyond what that endpoint already causes).
//   - date < today    -> mode:"historical". Reads the frozen snapshot from
//     MongoDB (api/_lib/insightsSnapshotStore.js) — NEVER touches Amber.
//     Missing snapshot -> {available:false}, never a fabricated dashboard.
//   - date > today    -> 400 (no future dates).
//
// The stored historical document mirrors the live payload's shape exactly
// (see api/_lib/models/InsightSnapshot.js's comment on siteWide/crawlProgress/
// coverage), so every dashboard component consumes one shape regardless of
// mode — the frontend just swaps which date it asks for.
//
// `country`/`city` filters apply to both modes. Live mode filters during the
// crawl aggregation itself (getMarketIntelligence -> buildFullBreakdown).
// Historical mode filters the already-stored flat breakdown in memory via
// insightsMarket.js's filterBreakdown() — the stored document already has
// every real country/city broken out, so narrowing it needs no Amber call.
const { withErrorHandling, badRequest } = require("../_lib/validation");
const { sendSuccess } = require("../_lib/apiResponse");
const { authorizeInsights } = require("../_lib/insightsDevAuth");
const { getMarketIntelligence, filterBreakdown } = require("../_lib/insightsMarket");
const { istDateString, getSnapshotByDate, getPreviousSnapshot, getRecentSnapshots } = require("../_lib/insightsSnapshotStore");

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function average(nums) {
    const valid = nums.filter((n) => Number.isFinite(n));
    return valid.length ? Math.round((valid.reduce((s, n) => s + n, 0) / valid.length) * 10) / 10 : null;
}

// Real average of whatever history exists — sampleSize tells the frontend
// how many days actually went into it, so a 2-day average is never
// presented as if it were a full week.
function computeSevenDayAvg(docs) {
    if (!docs || docs.length === 0) return null;
    return {
        sampleSize: docs.length,
        totalInventory: average(docs.map((d) => d.totalInventory)),
        soldOutInventory: average(docs.map((d) => d.soldOutInventory)),
        soldOutPercentage: average(docs.map((d) => d.soldOutPercentage)),
        averageAskingPrice: average(docs.map((d) => d.pricing?.average)),
    };
}

// null when there's no prior snapshot yet — the frontend renders
// "Comparison unavailable" rather than inventing a delta.
async function buildComparison(date) {
    try {
        const [previous, recent] = await Promise.all([getPreviousSnapshot(date), getRecentSnapshots(date, 7)]);
        if (!previous) return null;
        return { previous, sevenDayAvg: computeSevenDayAvg(recent) };
    } catch (err) {
        console.error("[insights-snapshot] comparison lookup failed (non-fatal):", err.message);
        return null;
    }
}

module.exports = withErrorHandling(async (req, res) => {
    if (req.method !== "GET") {
        res.status(405).json({ error: "Method not allowed" });
        return;
    }
    const identity = await authorizeInsights(req, res);
    if (!identity) return;

    const today = istDateString();
    const { date: rawDate, country, city } = req.query;
    const date = rawDate || today;

    if (!DATE_RE.test(date)) throw badRequest("INVALID_DATE", "date must be in YYYY-MM-DD format.");
    if (date > today) throw badRequest("INVALID_DATE", "date cannot be in the future.");

    if (date === today) {
        const market = await getMarketIntelligence({ country, city });
        sendSuccess(res, { mode: "live", date, available: true, ...market, comparison: await buildComparison(date) });
        return;
    }

    const snapshot = await getSnapshotByDate(date);
    if (!snapshot) {
        sendSuccess(res, { mode: "historical", date, available: false });
        return;
    }

    const filtered = filterBreakdown(snapshot, { country, city });
    sendSuccess(res, { mode: "historical", date, available: true, ...filtered, comparison: await buildComparison(date) });
});
