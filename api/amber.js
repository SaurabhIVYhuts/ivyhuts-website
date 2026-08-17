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
const { fetchAmber, fetchListings, normalizeCityName, matchesCity, AmberGatewayError } = require("./_lib/amberGateway");
const { getInventoryStats } = require("./_lib/inventoryStats");
const { mapAmberItemToResidence, persistResidences, extractResultArray } = require("./_lib/accommodationIndex");
const AccommodationResidence = require("./_lib/models/AccommodationResidence");
const { connectToDatabase, MongoNotConfiguredError } = require("./_lib/mongodb");
const { withTimeout } = require("./_lib/withTimeout");
const { growSearchDataFromRealTraffic } = require("./_lib/insightsMarket");

const VALID_TYPES = new Set(["listings", "detail", "citystats", "inventorystats"]);
const VALID_PRIORITIES = new Set(["HIGH", "MEDIUM", "LOW"]);

// connectToDatabase() (api/_lib/mongodb.js) uses a 10-SECOND
// serverSelectionTimeoutMS — correct for features that need Mongo, fatal
// here: without a hard bound, a slow/unreachable/misconfigured Mongo would
// make EVERY /api/amber listings/detail request (i.e. the entire find-rooms
// page) hang for up to 10s on a write that's purely opportunistic. This is
// what actually gives indexOnRead() its "never slow down the primary
// response" property — the earlier version of this file awaited it
// unbounded and only assumed that was safe.
const INDEX_ON_READ_TIMEOUT_MS = 1200;

// "Index-on-read": every real listings/detail response this gateway already
// serves opportunistically upserts into the same AccommodationResidence
// mirror the Student Planner uses (api/_lib/accommodationIndex.js), so the
// global search endpoint (api/search.js) can find real properties by name
// without a dedicated crawler — coverage grows from real site traffic
// instead. Reuses the exact mapper/upsert the planner already relies on, so
// this can never diverge into a second "how we normalize a residence" story.
//
// Must be AWAITED (not truly fire-and-forget) before the response is sent —
// a Vercel serverless invocation isn't guaranteed to keep running after
// res.json() returns, same reason amberApi.js's own header notes the server
// "intentionally doesn't" do post-response background work. Every failure
// mode (Mongo not configured, a write error) is swallowed, and the caller
// wraps this whole call in withTimeout() — so neither a real error nor a
// slow/hanging Mongo connection can ever delay the primary Amber response
// the user is actually waiting on.
async function indexOnRead(type, city, rawJson) {
    try {
        await connectToDatabase();
    } catch (err) {
        if (err instanceof MongoNotConfiguredError) return; // search index simply stays empty — not an error
        return;
    }
    try {
        if (type === "listings") {
            const normalizedCity = normalizeCityName(city);
            if (!normalizedCity) return;
            const items = extractResultArray(rawJson);
            const mapped = items.map((item) => mapAmberItemToResidence(item, normalizedCity)).filter(Boolean);
            if (mapped.length) await persistResidences(normalizedCity, mapped);
        } else if (type === "detail") {
            const item = extractResultArray(rawJson)[0];
            if (!item) return;
            const normalizedCity = normalizeCityName(item?.location?.locality?.long_name || city);
            const mapped = mapAmberItemToResidence(item, normalizedCity);
            if (mapped) await persistResidences(normalizedCity, [mapped]);
        }
    } catch (err) {
        console.log(`[SEARCH_INDEX] action=INDEX_ON_READ_FAILED type=${type} city=${city || "-"} error=${err.message}`);
    }
}

// Amber's `location_place_name` search filter is confirmed unreliable for
// at least some cities (Derby: real inventory 29 properties per the
// independent full-catalog crawl, but the live filtered listings call has
// been observed returning as few as 1-3 genuine matches) — fetchListings()'s
// own bounded fallback (amberGateway.js) already compensates some, but it's
// still limited to a couple of UNFILTERED catalog pages, no guarantee of
// finding a specific sparse city's properties.
//
// This is the second, complementary layer: when a listings response still
// looks suspiciously small, check AccommodationResidence — our own mirror,
// populated by real traffic and the full-catalog crawl — for slugs already
// known to belong to this city that AREN'T in the live result, and fetch
// each directly by slug (fetchAmber type:"detail", the same targeted,
// per-property mechanism university accommodationOverrides already use —
// not a broad search, so it isn't subject to the same filter unreliability).
// Every candidate is re-verified via matchesCity() against its OWN freshly-
// fetched location before being trusted — never taken on faith just because
// Mongo says so (this is exactly the guard that would have caught the Derby
// mistagging incident, where 10 wrong-city records were once persisted from
// a single bad batch — see git history/session notes).
//
// Bounded to MONGO_ENRICH_MAX_EXTRA additional Amber calls and an overall
// time budget short enough that, combined with fetchListings' own worst-case
// duration, the whole request still fits inside Vercel's 30s ceiling
// (vercel.json's maxDuration for this function) — never lets a sparse city
// turn into an unbounded hunt.
const MONGO_ENRICH_THRESHOLD = 5;
const MONGO_ENRICH_MAX_EXTRA = 3;
const MONGO_ENRICH_TIMEOUT_MS = 4000;

async function enrichFromKnownResidences(city, result, priority, source) {
    const items = extractResultArray(result.data);
    if (items.length >= MONGO_ENRICH_THRESHOLD) return result;
    const normalizedCity = normalizeCityName(city);
    if (!normalizedCity) return result;
    try {
        await connectToDatabase();
    } catch (err) {
        return result;
    }
    try {
        const knownIds = new Set(items.map((item) => String(item.id)));
        const candidates = await AccommodationResidence.find({ city: normalizedCity })
            .select("propertyId slug")
            .lean();
        const missing = candidates.filter((c) => c.slug && !knownIds.has(String(c.propertyId)));
        if (!missing.length) return result;

        const fetched = await Promise.all(
            missing.slice(0, MONGO_ENRICH_MAX_EXTRA).map(async (candidate) => {
                try {
                    const detail = await fetchAmber({ type: "detail", params: { slug: candidate.slug }, priority, source: `${source}-mongo-enrich` });
                    const item = extractResultArray(detail.data)[0];
                    return item && matchesCity(item, normalizedCity) ? item : null;
                } catch (err) {
                    return null; // best-effort — one bad slug must never fail the whole enrichment
                }
            })
        );
        const verified = fetched.filter(Boolean);
        if (!verified.length) return result;

        const mergedItems = [...items, ...verified];
        return {
            data: { message: result.data?.data?.message || "success", data: { result: mergedItems, meta: { count: mergedItems.length } } },
            cacheStatus: result.cacheStatus,
        };
    } catch (err) {
        console.log(`[GATEWAY] action=MONGO_ENRICH_FAILED city=${city} error=${err.message}`);
        return result;
    }
}

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
        let result = type === "inventorystats"
            ? { data: await getInventoryStats(), cacheStatus: "COMPUTED" }
            : type === "listings"
            ? await fetchListings({ city, page, limit }, p, s)
            : await fetchAmber({ type, params: { city, slug, page, limit }, priority: p, source: s });

        if (type === "listings" && city) {
            result = await withTimeout(enrichFromKnownResidences(city, result, p, s), MONGO_ENRICH_TIMEOUT_MS, result);
        }

        // Only index on a genuine upstream fetch (cacheStatus "MISS") — same
        // guard accommodationIndex.js's own refreshCityIndex() already uses for
        // exactly this reason: re-upserting identical data on every cache HIT
        // for a busy city would be pure wasted Mongo load with zero new
        // information, since the upsert is idempotent on unchanged data anyway.
        if ((type === "listings" || type === "detail") && result.cacheStatus === "MISS") {
            await withTimeout(indexOnRead(type, city, result.data), INDEX_ON_READ_TIMEOUT_MS, undefined);
            // Independent of indexOnRead's Mongo connection (pure Redis, so it
            // still runs even when Mongo is down/not configured) — grows the
            // search-facing country/city dataset from this same real response,
            // never touches the crawl's own dashboard-facing state. See
            // insightsMarket.js's growSearchDataFromRealTraffic for why.
            await withTimeout(growSearchDataFromRealTraffic(extractResultArray(result.data)), INDEX_ON_READ_TIMEOUT_MS, undefined);
        }

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
