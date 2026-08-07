// Site-wide inventory counters (Total / Sold Out / Remaining) for the
// homepage stats section.
//
// A prior version of this file tried to derive Sold Out/Remaining by paging
// through the ENTIRE catalog (~4,281 items / 86 pages at 50/page) via a
// background job throttled to the shared 6-requests/minute Amber budget —
// that needs ~15 sequential ticks spread across separate 60s rate windows
// to ever finish once, which a single page visit's polling window can never
// survive, so `ready` never became true and the homepage stayed on its
// loading skeleton indefinitely.
//
// Turns out that full crawl was unnecessary: Amber's own /inventories
// endpoint accepts an `available` filter and reports the TRUE filtered
// total in `meta.count`, confirmed live against the real API —
//   available=true  -> meta.count 3221
//   available=false -> meta.count 1060
//   unfiltered       -> meta.count 4281   (3221 + 1060, exact match)
// So all three numbers come from two lightweight (limit=1, count-only)
// requests through the existing rate-limited/cached fetchAmber() gateway —
// no pagination, no multi-minute background build, no persisted progress.
const { fetchAmber } = require("./amberGateway");
const { sharedGet, sharedSet, log } = require("./sharedStore");

const AGGREGATE_KEY = "amber:invstats:aggregate";
const FRESH_SECONDS = 2 * 60; // matches fetchAmber's own "listings" freshness window
const MAX_AGE_SECONDS = 30 * 60; // how long a stale aggregate is still served while a refresh is attempted

function isFresh(entry) {
    return !!entry && Date.now() - entry.computedAt < FRESH_SECONDS * 1000;
}

async function fetchAvailabilityCount(available, source) {
    const { data } = await fetchAmber({
        type: "listings",
        params: { page: 1, limit: 1, available },
        priority: "LOW",
        source,
    });
    // `data` is null when the shared per-minute budget is exhausted (LOW
    // priority backs off instead of forcing the request) — not an error.
    return Number.isFinite(data?.data?.meta?.count) ? data.data.meta.count : null;
}

// Always resolves — never throws. `ready:false` means live counts could not
// be obtained yet (shared budget momentarily exhausted) and there is no
// previous aggregate to fall back on; the caller should retry shortly, and
// that is NOT the same as a real failure.
async function getInventoryStats() {
    const aggregate = await sharedGet(AGGREGATE_KEY);
    if (isFresh(aggregate)) {
        return { ready: true, total: aggregate.total, soldOut: aggregate.soldOut, remaining: aggregate.remaining, stale: false };
    }

    try {
        const remaining = await fetchAvailabilityCount(true, "inventory-stats-remaining");
        const soldOut = await fetchAvailabilityCount(false, "inventory-stats-soldout");

        if (remaining == null || soldOut == null) {
            if (aggregate) return { ready: true, total: aggregate.total, soldOut: aggregate.soldOut, remaining: aggregate.remaining, stale: true };
            return { ready: false };
        }

        const result = { total: remaining + soldOut, soldOut, remaining, computedAt: Date.now() };
        await sharedSet(AGGREGATE_KEY, result, MAX_AGE_SECONDS);
        log(`inventory-stats computed total=${result.total} soldOut=${soldOut} remaining=${remaining}`);
        return { ready: true, total: result.total, soldOut, remaining, stale: false };
    } catch (err) {
        log(`inventory-stats fetch failed: ${err.message}`);
        if (aggregate) return { ready: true, total: aggregate.total, soldOut: aggregate.soldOut, remaining: aggregate.remaining, stale: true };
        return { ready: false };
    }
}

module.exports = { getInventoryStats };
