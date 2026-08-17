// Vercel serverless function backing the universal search bar's autocomplete
// (GET /api/search?q=). Thin by design, same shape as api/amber.js: all the
// actual matching/ranking logic lives in ./_lib/searchIndex.js.
const { searchEntities } = require("./_lib/searchIndex");

module.exports = async (req, res) => {
    if (req.method !== "GET") {
        res.status(405).json({ error: "Method not allowed" });
        return;
    }

    const q = typeof req.query.q === "string" ? req.query.q : "";
    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 10) : 6;

    try {
        const result = await searchEntities(q, limit);
        // Short edge cache — autocomplete queries repeat heavily across users
        // (common city/university names), and this data changes slowly.
        res.setHeader("Cache-Control", "public, max-age=30, stale-while-revalidate=120");
        res.status(200).json({ ok: true, data: result });
    } catch (err) {
        console.log(`[SEARCH] action=SEARCH_FAILED q=${q} error=${err.message}`);
        res.status(502).json({ ok: false, error: "search_failed", message: "Search is temporarily unavailable." });
    }
};
