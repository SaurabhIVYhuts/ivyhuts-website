// Internal endpoint that triggers one bounded full-catalog crawl advance
// (api/_lib/insightsMarket.js's advanceCrawl()). This is the ONLY mechanism
// in this codebase that backfills AccommodationResidence for properties
// beyond a city's top ~150 (see accommodationIndex.js's REFRESH_TARGET_COUNT)
// and for cities real traffic never happens to hit — it walks Amber's whole
// catalog page by page (sold-out and available sides separately), so
// coverage isn't limited by which cities/properties visitors search for.
//
// advanceCrawl() previously only ran as a side effect of loading the
// /insight Market Intelligence dashboard. That dashboard was extracted to a
// standalone repo/deployment (see git history: "Remove Market Insight
// feature"), which left advanceCrawl() with zero callers anywhere in this
// codebase — the full-catalog backfill silently stopped running entirely,
// not just slowed down. This endpoint gives it a trigger again, independent
// of any dashboard, following the exact same external-cron pattern as
// ./warm-amber-cache.js and ./prune-stale-residences-cron.js.
//
// Safe to call even if some other deployment also still calls advanceCrawl()
// against the same database: it's protected by insightsMarket.js's own
// Redis lock (CRAWL_LOCK_KEY), so two callers can never advance the same
// crawl state concurrently — an overlapping call just reads back whatever
// the lock-holder already persisted.
//
// Auth: verifies a bearer secret (CRON_SECRET) against the Authorization
// header — the SAME CRON_SECRET already configured for
// api/warm-amber-cache.js and api/prune-stale-residences-cron.js. If
// CRON_SECRET isn't set, this endpoint exists but refuses all requests
// (fails closed, not open).
const { advanceCrawl } = require("../../insightsMarket");

module.exports = async (req, res) => {
    if (req.method !== "GET") {
        res.status(405).json({ error: "Method not allowed" });
        return;
    }

    const secret = process.env.CRON_SECRET;
    if (!secret) {
        console.warn("[CrawlAdvance] CRON_SECRET not configured — refusing all requests to /api/advance-crawl-cron");
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
        // Bounded, non-sensitive summary only — page cursors and done-flags,
        // never a raw Amber response body or any credential.
        res.status(200).json({
            ok: true,
            soldOut: { nextPage: state?.soldOut?.nextPage, done: !!state?.soldOut?.done, expectedTotal: state?.soldOut?.expectedTotal ?? null },
            available: { nextPage: state?.available?.nextPage, done: !!state?.available?.done, expectedTotal: state?.available?.expectedTotal ?? null },
        });
    } catch (err) {
        console.error("[CrawlAdvance] unexpected error:", err.message);
        res.status(500).json({ ok: false, error: "advance_failed" });
    }
};
