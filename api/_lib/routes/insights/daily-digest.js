// Triggers the 08:00 IST daily market-intelligence snapshot + email (see
// ./_lib/insightsDigest.js — kept as ../_lib/insightsDigest.js from here).
// Meant to be called by Vercel Cron (vercel.json's `crons` entry, schedule
// "30 2 * * *" = 08:00 IST) — never by the browser, and never linked from
// the public site. Doubles as the manual test entry point: calling this by
// hand with a valid CRON_SECRET runs the exact same pipeline a real 08:00
// run would, including sending the real email.
//
// Auth: identical bearer-secret pattern to api/warm-amber-cache.js — fails
// closed (503) if CRON_SECRET isn't configured, 401 if the header doesn't
// match. No Amber or email credentials live in this file; all of that stays
// in ./_lib/insightsDigest.js's dependencies.
const { runDailyDigest } = require("../../insightsDigest");

module.exports = async (req, res) => {
    if (req.method !== "GET") {
        res.status(405).json({ ok: false, error: "method_not_allowed" });
        return;
    }

    const secret = process.env.CRON_SECRET;
    if (!secret) {
        console.warn("[insights-digest] CRON_SECRET not configured — refusing all requests to /api/insights/daily-digest");
        res.status(503).json({ ok: false, error: "not_configured" });
        return;
    }

    const authHeader = req.headers.authorization || "";
    if (authHeader !== `Bearer ${secret}`) {
        res.status(401).json({ ok: false, error: "unauthorized" });
        return;
    }

    try {
        const result = await runDailyDigest();
        res.status(result.ok ? 200 : 500).json(result);
    } catch (err) {
        console.error("[insights-digest] unexpected error:", err.message);
        res.status(500).json({ ok: false, error: "digest_failed" });
    }
};
