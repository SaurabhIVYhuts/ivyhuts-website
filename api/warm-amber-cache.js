// Internal endpoint that triggers one bounded cache-warming pass (see
// ./_lib/cacheWarmer.js). Meant to be called by a scheduler — Vercel Cron or
// any external one — not by the browser. No Amber credentials are ever
// present in this file; all Amber access still goes through the existing
// gateway (fetchListings -> amberGateway -> shared cache/lock/budget ->
// Amber), so this endpoint inherits every existing protection automatically.
//
// Auth: verifies a bearer secret (CRON_SECRET) against the Authorization
// header, following Vercel's own documented Cron convention — set
// CRON_SECRET in your Vercel project's environment variables and Vercel
// automatically sends it as `Authorization: Bearer <CRON_SECRET>` when
// invoking a configured cron job (see vercel.json's `crons` entry). If
// CRON_SECRET isn't set, the endpoint exists but refuses all requests
// (fails closed, not open).
const { runCacheWarmer } = require("./_lib/cacheWarmer");

module.exports = async (req, res) => {
    if (req.method !== "GET") {
        res.status(405).json({ error: "Method not allowed" });
        return;
    }

    const secret = process.env.CRON_SECRET;
    if (!secret) {
        console.warn("[Warmer] CRON_SECRET not configured — refusing all requests to /api/warm-amber-cache");
        res.status(503).json({ ok: false, error: "not_configured" });
        return;
    }

    const authHeader = req.headers.authorization || "";
    if (authHeader !== `Bearer ${secret}`) {
        res.status(401).json({ ok: false, error: "unauthorized" });
        return;
    }

    try {
        const summary = await runCacheWarmer();
        // Bounded, non-sensitive summary only — city names and cache
        // statuses, never a raw Amber response body or any credential.
        res.status(200).json({ ok: true, ...summary });
    } catch (err) {
        console.error("[Warmer] unexpected error:", err.message);
        res.status(500).json({ ok: false, error: "warmer_failed" });
    }
};
