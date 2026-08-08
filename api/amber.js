// Vercel serverless function — the ONLY place in this deployment that is
// allowed to talk to base.amberstudent.com. The browser now calls this
// endpoint (same-origin, e.g. /api/amber?type=listings&city=London)
// instead of contacting Amber directly, so Amber usage can be coordinated
// across every user, tab and instance rather than per-browser.
//
// Thin by design: all the actual coordination (cache, cooldown, stampede
// lock, rate budget) lives in ./_lib/amberGateway.js so it can be unit
// tested directly with plain Node, without needing a live Vercel/HTTP
// round-trip.
const { fetchAmber, fetchListings, AmberGatewayError } = require("./_lib/amberGateway");
const { getInventoryStats } = require("./_lib/inventoryStats");

const VALID_TYPES = new Set(["listings", "detail", "citystats", "inventorystats"]);
const VALID_PRIORITIES = new Set(["HIGH", "MEDIUM", "LOW"]);

module.exports = async (req, res) => {
    if (req.method !== "GET") {
        res.status(405).json({ error: "Method not allowed" });
        return;
    }

    const { type, city, slug, page, limit, priority, source } = req.query;

    if (!VALID_TYPES.has(type)) {
        res.status(400).json({ error: "Invalid or missing 'type' (expected listings, detail, citystats, or inventorystats)" });
        return;
    }
    if (type === "detail" && !slug) {
        res.status(400).json({ error: "'slug' is required for type=detail" });
        return;
    }

    try {
        const p = VALID_PRIORITIES.has(priority) ? priority : "MEDIUM";
        const s = source || "unknown";
        const result = type === "inventorystats"
            ? { data: await getInventoryStats(), cacheStatus: "COMPUTED" }
            : type === "listings"
            ? await fetchListings({ city, page, limit }, p, s)
            : await fetchAmber({ type, params: { city, slug, page, limit }, priority: p, source: s });

        // Cache at the edge/CDN too for a short window — extra protection for
        // the "many users hit this at once" case with near-zero cost, on top
        // of the shared-store coordination above.
        res.setHeader("Cache-Control", "public, max-age=30, stale-while-revalidate=120");
        console.log(`[GATEWAY] type=${type} city=${city || "-"} slug=${slug || "-"} source=${s} priority=${p} cache=${result.cacheStatus} upstream=${result.cacheStatus === "MISS" ? "YES" : "NO"} budget=server queue=none cooldown=0`);
        res.status(200).json({ ok: true, cache: result.cacheStatus, data: result.data });
    } catch (err) {
        const status = err instanceof AmberGatewayError ? err.status : 502;
        // Never leak upstream internals (stack traces, raw Amber error bodies) —
        // just enough for the frontend to show its existing friendly states.
        const retryAfterSeconds = err instanceof AmberGatewayError && err.retryAfterSeconds ? err.retryAfterSeconds : 300;
        // `code` is the specific, stable reason (cooldown / budget_exceeded /
        // lock_busy / cache_unavailable / amber_timeout / upstream_error) —
        // lets the frontend distinguish these cases where it wants to, without
        // requiring any UI change (existing callers that only look at `error`
        // or HTTP status keep working exactly as before).
        const code = (err instanceof AmberGatewayError && err.code) || (status === 429 ? "rate_limited" : "upstream_error");
        console.log(`[GATEWAY] type=${type} city=${city || "-"} slug=${slug || "-"} source=${source || "unknown"} priority=${priority || "MEDIUM"} cache=MISS upstream=NO code=${code} cooldown=${status === 429 ? retryAfterSeconds : 0}`);
        if (status === 429) res.setHeader("Retry-After", String(retryAfterSeconds));
        res.status(status).json({
            ok: false,
            error: code,
            retryAfterSeconds: status === 429 ? retryAfterSeconds : undefined,
            message: status === 429 ? "Amber is temporarily unavailable — please try again shortly." : "Could not load property data right now.",
        });
    }
};
