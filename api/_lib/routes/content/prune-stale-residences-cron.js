// Internal endpoint that triggers one bounded stale-residence sweep tick
// (see ../../staleResidenceSweep.js). Meant to be called by an external
// scheduler on a short interval — this repo's Hobby Vercel plan can't run
// frequent Vercel Crons itself, so every scheduled job here (see
// api/leads/import/sync-cron.js) is instead triggered by an outside pinger
// like cron-job.org, the same pattern this endpoint follows.
//
// Auth: verifies a bearer secret (CRON_SECRET) against the Authorization
// header — the SAME CRON_SECRET already configured for
// api/warm-amber-cache.js and api/leads/import/sync-cron.js, no separate
// secret. If CRON_SECRET isn't set, this endpoint exists but refuses all
// requests (fails closed, not open).
const { runStaleResidenceSweep, SWEEP_BATCH_SIZE } = require("../../staleResidenceSweep");

module.exports = async (req, res) => {
    if (req.method !== "GET") {
        res.status(405).json({ error: "Method not allowed" });
        return;
    }

    const secret = process.env.CRON_SECRET;
    if (!secret) {
        console.warn("[PruneSweep] CRON_SECRET not configured — refusing all requests to /api/prune-stale-residences-cron");
        res.status(503).json({ ok: false, error: "not_configured" });
        return;
    }

    const authHeader = req.headers.authorization || "";
    if (authHeader !== `Bearer ${secret}`) {
        res.status(401).json({ ok: false, error: "unauthorized" });
        return;
    }

    try {
        const summary = await runStaleResidenceSweep();
        // Bounded, non-sensitive summary only — slugs, city names, counts —
        // never a raw Amber response body or any credential.
        res.status(200).json({ ok: true, batchSize: SWEEP_BATCH_SIZE, ...summary });
    } catch (err) {
        console.error("[PruneSweep] unexpected error:", err.message);
        res.status(500).json({ ok: false, error: "sweep_failed" });
    }
};
