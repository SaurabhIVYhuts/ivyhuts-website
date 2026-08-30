// Scheduled Google Sheet -> Lead sync trigger (see vercel.json's `crons`
// entry). NOT the CRM's manual "Refresh Leads" trigger — that stays
// api/leads/import/google-sheet.js, session/role-gated. This route exists
// so a newly-added spreadsheet row reaches the CRM even if no one clicks
// Refresh: both routes call the exact same api/_lib/leadSheetSync.js core,
// so there is one sync implementation with two triggers, not two
// implementations.
//
// Auth: verifies a bearer secret (CRON_SECRET) against the Authorization
// header, following Vercel's own documented Cron convention — the SAME
// CRON_SECRET already configured for api/warm-amber-cache.js and
// api/insights/*.js (see .env.example); no separate secret. If CRON_SECRET
// isn't set, this endpoint exists but refuses all requests (fails closed,
// not open) — same contract as warm-amber-cache.js.
const { runLeadSheetSync } = require("../../_lib/leadSheetSync");

module.exports = async (req, res) => {
    if (req.method !== "GET") {
        res.status(405).json({ error: "Method not allowed" });
        return;
    }

    const secret = process.env.CRON_SECRET;
    if (!secret) {
        console.warn("[lead-sheet-sync-cron] CRON_SECRET not configured — refusing all requests to /api/leads/import/sync-cron");
        res.status(503).json({ ok: false, error: "not_configured" });
        return;
    }

    const authHeader = req.headers.authorization || "";
    if (authHeader !== `Bearer ${secret}`) {
        res.status(401).json({ ok: false, error: "unauthorized" });
        return;
    }

    try {
        const result = await runLeadSheetSync({ actorUserId: null, actorRole: "cron" });
        if (result.status === "NOT_CONFIGURED" || result.status === "UPSTREAM_ERROR") {
            // Not a Sheet import failure worth alerting on every 15
            // minutes if the feature is simply unconfigured on this
            // deployment — 200 with an honest status field, same spirit as
            // insights/daily-digest.js's own "ran, but skipped a step"
            // convention, never a fabricated success.
            res.status(200).json({ ok: true, status: result.status, reason: result.reason });
            return;
        }
        res.status(200).json({ ok: true, status: "OK", summary: result.summary, syncedAt: new Date().toISOString() });
    } catch (err) {
        console.error("[lead-sheet-sync-cron] sync run failed:", err);
        res.status(500).json({ ok: false, error: "internal_error" });
    }
};
