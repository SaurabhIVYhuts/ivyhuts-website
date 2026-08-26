// Advances the resumable Amber catalog crawl (api/_lib/insightsMarket.js) by
// one shared-budget window's worth of page fetches. Scheduled every 5
// minutes (vercel.json), the same cadence as the existing
// api/warm-amber-cache.js — so the crawl this powers stays continuously
// fresh/complete in the background, meaning both the live /insight dashboard
// and the 08:00 IST daily digest (api/insights/daily-digest.js) always have
// real, near-complete data rather than starting cold.
//
// Calls go through the same fetchListings() global rate budget as every
// other caller (LOW priority, see advanceCrawlSide in insightsMarket.js), so
// this can never burst Amber or starve a real user's request — a busy
// budget just means this tick does nothing.
//
// Auth: identical bearer-secret pattern to api/warm-amber-cache.js.
const { advanceCrawl } = require("../../insightsMarket");

module.exports = async (req, res) => {
    if (req.method !== "GET") {
        res.status(405).json({ ok: false, error: "method_not_allowed" });
        return;
    }

    const secret = process.env.CRON_SECRET;
    if (!secret) {
        console.warn("[insights-crawl] CRON_SECRET not configured — refusing all requests to /api/insights/advance-crawl");
        res.status(503).json({ ok: false, error: "not_configured" });
        return;
    }

    const authHeader = req.headers.authorization || "";
    if (authHeader !== `Bearer ${secret}`) {
        res.status(401).json({ ok: false, error: "unauthorized" });
        return;
    }

    try {
        const state = await advanceCrawl();
        res.status(200).json({
            ok: true,
            soldOutFetched: state.soldOut.fetchedCount,
            soldOutDone: state.soldOut.done,
            availableFetched: state.available.fetchedCount,
            availableDone: state.available.done,
        });
    } catch (err) {
        console.error("[insights-crawl] unexpected error:", err.message);
        res.status(500).json({ ok: false, error: "advance_failed" });
    }
};
