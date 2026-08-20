// Conservative, opportunistic cache warming for the highest-value Amber
// listing data. Goal: reduce how often a real visitor is the one who
// triggers a genuinely cold (~13.7s+) Amber request, for the small set of
// destinations most likely to be hit cold.
//
// This module NEVER talks to Amber directly — it only calls fetchListings(),
// the same coordinated entry point every real request goes through, so every
// warming request inherits the exact same cache-first check, cooldown check,
// distributed lock, atomic budget reservation and 20s timeout as a real user
// request would:
//
//   cache warmer -> fetchListings() -> amberGateway -> shared cache
//                                                     -> distributed lock
//                                                     -> global budget
//                                                     -> Amber
//
// It is deliberately NOT a queue, worker, or scheduler of its own — just a
// small bounded function that a protected HTTP endpoint (api/warm-amber-cache.js)
// calls. See that file for how it's triggered.
//
// Milestone 4 (IVYHUTS_MILESTONE_4_INVENTORY_REFRESH_REPORT.md) additive
// change: this warmer now ALSO drains a small batch of cities real user
// requests actually asked for while stale/missing (see accommodationIndex.js's
// requestBackgroundRefresh/drainRefreshQueue) before its own pre-existing
// curated-rotation logic runs. This is deliberately reusing the one cron
// this codebase already has (vercel.json's `*/5 * * * *` schedule for this
// same endpoint), not a new scheduler/queue/worker.
const { sharedGet, sharedSet, peekRecentRequestCount, log } = require("./sharedStore");
const { fetchListings, buildCacheKey, RATE_BUDGET_PER_MINUTE, RATE_WINDOW_MS, TTL, isUsable } = require("./amberGateway");
const { drainRefreshQueue, attemptCityRefresh, classifyCityState } = require("./accommodationIndex");
const AccommodationIndexMeta = require("./models/AccommodationIndexMeta");
const { connectToDatabase, MongoNotConfiguredError } = require("./mongodb");

// Curated warm-target pool: the UK cities from src/data/destinations.js, in
// their declared order. Mirrored here (not imported) for the same reason
// amberGateway.js's TTL table duplicates src/services/amberApi.js's
// CLIENT_TTL instead of sharing a module: api/_lib is a plain CommonJS Node
// runtime with no build step, and src/data/destinations.js is an ES module
// meant for CRA's webpack/babel pipeline — requiring it directly here would
// fail. UK is chosen because it's COUNTRIES[0] in that file (the app's own
// default market) and DESTINATIONS lists all 12 UK cities first, with London
// (DESTINATIONS[0]) already the default city for two separate homepage
// sections. Keep this list in sync by hand if destinations.js's UK cluster
// changes.
const WARM_TARGET_CITIES = [
    "London",
    "Manchester",
    "Birmingham",
    "Coventry",
    "Leeds",
    "Liverpool",
    "Sheffield",
    "Glasgow",
    "Nottingham",
    "Newcastle Upon Tyne",
    "Leicester",
    "Exeter",
    "Guildford",
];

// At most this many candidates are actually refreshed (i.e. reach
// fetchListings, which may itself skip/dedupe further) per single warmer
// execution. Deliberately tiny relative to the 6/min global budget — a
// warmer run must never look anything like a burst.
const WARM_BATCH_SIZE = 1;

// Only warm while comfortably under the global budget, so warming can never
// be the reason a real visitor's request gets throttled. Proportional to the
// configured budget (not a hardcoded absolute number) so this scales
// correctly if AMBER_MAX_REQUESTS_PER_MINUTE is ever changed.
const WARM_BUDGET_FRACTION = 0.5; // only warm if usage is below half the budget
const WARM_BUDGET_THRESHOLD = Math.max(1, Math.floor(RATE_BUDGET_PER_MINUTE * WARM_BUDGET_FRACTION));

const ROTATION_CURSOR_KEY = "amber:warm:cursor";
const ROTATION_CURSOR_TTL_SECONDS = 30 * 24 * 60 * 60; // long-lived; just an index, not real data

// Deliberately tiny and separate from WARM_BATCH_SIZE — queued cities are
// real, demand-driven requests (a real user actually hit a missing/stale
// city), so they're drained BEFORE the opportunistic curated rotation below,
// but still capped small so a sudden burst of distinct cold cities can't
// look anything like a traffic spike against Amber's own budget.
const QUEUE_DRAIN_BATCH_SIZE = 2;

async function readCursor() {
    const stored = await sharedGet(ROTATION_CURSOR_KEY);
    const n = Number(stored);
    return Number.isFinite(n) && n >= 0 ? n : 0;
}

async function writeCursor(next) {
    await sharedSet(ROTATION_CURSOR_KEY, next % WARM_TARGET_CITIES.length, ROTATION_CURSOR_TTL_SECONDS);
}

function pickCandidates(startIndex, count) {
    const picked = [];
    for (let i = 0; i < count && i < WARM_TARGET_CITIES.length; i++) {
        picked.push(WARM_TARGET_CITIES[(startIndex + i) % WARM_TARGET_CITIES.length]);
    }
    return picked;
}

// Cache-first check: does this city's listings cache entry already need a
// refresh, or is it fresh/usable enough to leave alone? Reuses amberGateway's
// own TTL table and isUsable() so this can never silently drift from what the
// gateway itself considers "still good" (see the TTL export's comment there).
async function needsRefresh(city) {
    const cacheKey = buildCacheKey("listings", { city, page: 1, limit: 50 });
    const cached = await sharedGet(cacheKey);
    if (!cached) return true;
    return !isUsable(cached, TTL.listings.maxAgeSeconds);
}

// Drains up to QUEUE_DRAIN_BATCH_SIZE cities real user requests actually
// asked for (accommodationIndex.js's requestBackgroundRefresh) — this is the
// mechanism that gradually closes the AccommodationIndexMeta coverage gap
// (Milestone 2 measured 527/575 cities with no Meta document at all)
// WITHOUT ever attempting all of them at once: only cities someone actually
// searched for get queued in the first place, and only a couple drain per
// 5-minute tick. Each candidate is re-checked against the SAME budget
// threshold and the SAME classifyCityState() cooldown logic real requests
// use, so a city that already recovered (or is in its failure cooldown) by
// the time this tick runs is correctly skipped rather than blindly retried.
async function drainQueuedCities(summary) {
    let queued;
    try {
        queued = await drainRefreshQueue(QUEUE_DRAIN_BATCH_SIZE);
    } catch (err) {
        log(`[Warmer] action=QUEUE_DRAIN_FAILED error=${err.message}`);
        return;
    }
    for (const city of queued) {
        let usageNow;
        try {
            usageNow = await peekRecentRequestCount(RATE_WINDOW_MS);
        } catch (err) {
            log(`[Warmer] action=REDIS_UNAVAILABLE city=${city} source=queue — stopping queue drain`);
            break;
        }
        if (usageNow >= WARM_BUDGET_THRESHOLD) {
            log(`[Warmer] action=QUEUE_SKIPPED_BUDGET city=${city} usage=${usageNow}/${RATE_BUDGET_PER_MINUTE}`);
            summary.skipped.push({ city, reason: "budget", source: "queue" });
            continue;
        }

        let meta = null;
        try {
            await connectToDatabase();
            meta = await AccommodationIndexMeta.findOne({ city }).lean();
        } catch (err) {
            if (!(err instanceof MongoNotConfiguredError)) log(`[Warmer] action=QUEUE_META_LOOKUP_FAILED city=${city} error=${err.message}`);
            summary.skipped.push({ city, reason: "mongo_unavailable", source: "queue" });
            continue;
        }
        const state = classifyCityState(meta, Date.now());
        if (state === "FRESH" || state === "FAILED_COOLDOWN") {
            log(`[Warmer] action=QUEUE_SKIPPED_${state} city=${city}`);
            summary.skipped.push({ city, reason: state.toLowerCase(), source: "queue" });
            continue;
        }

        log(`[Warmer] action=QUEUE_REFRESH city=${city}`);
        const outcome = await attemptCityRefresh(city, "LOW", "cache-warmer-queue");
        summary.warmed.push({ city, refreshed: outcome.refreshed, source: "queue" });
    }
}

// Runs one bounded warming pass. Safe to call more than once concurrently or
// in back-to-back invocations: every actual refresh still goes through
// fetchListings' distributed lock, so two overlapping warm runs targeting the
// same city can never cause two upstream Amber calls, and a run that finds
// nothing worth refreshing does no network work at all.
async function runCacheWarmer() {
    const summary = { considered: [], warmed: [], skipped: [] };

    await drainQueuedCities(summary);

    let recentUsage;
    try {
        recentUsage = await peekRecentRequestCount(RATE_WINDOW_MS);
    } catch (err) {
        log(`[Warmer] action=REDIS_UNAVAILABLE — stopping without attempting any warm work`);
        summary.error = "cache_unavailable";
        return summary;
    }

    if (recentUsage >= WARM_BUDGET_THRESHOLD) {
        log(`[Warmer] action=WARM_SKIPPED_BUDGET usage=${recentUsage}/${RATE_BUDGET_PER_MINUTE} threshold=${WARM_BUDGET_THRESHOLD} — leaving all capacity for real users`);
        summary.skipped.push({ reason: "budget", usage: recentUsage, threshold: WARM_BUDGET_THRESHOLD });
        return summary;
    }

    let cursor;
    try {
        cursor = await readCursor();
    } catch (err) {
        log(`[Warmer] action=REDIS_UNAVAILABLE — stopping without attempting any warm work`);
        summary.error = "cache_unavailable";
        return summary;
    }

    const candidates = pickCandidates(cursor, WARM_BATCH_SIZE);
    summary.considered = candidates;

    let warmedCount = 0;
    for (const city of candidates) {
        // Re-check usage before EACH candidate, not just once at the top —
        // a real user's request could consume budget while this loop runs
        // (WARM_BATCH_SIZE is 1 by default so this rarely matters, but stays
        // correct if it's ever raised).
        let usageNow;
        try {
            usageNow = await peekRecentRequestCount(RATE_WINDOW_MS);
        } catch (err) {
            log(`[Warmer] action=REDIS_UNAVAILABLE city=${city} — stopping`);
            summary.error = "cache_unavailable";
            break;
        }
        if (usageNow >= WARM_BUDGET_THRESHOLD) {
            log(`[Warmer] action=WARM_SKIPPED_BUDGET city=${city} usage=${usageNow}/${RATE_BUDGET_PER_MINUTE}`);
            summary.skipped.push({ city, reason: "budget" });
            continue;
        }

        let stale;
        try {
            stale = await needsRefresh(city);
        } catch (err) {
            log(`[Warmer] action=REDIS_UNAVAILABLE city=${city} — stopping`);
            summary.error = "cache_unavailable";
            break;
        }
        if (!stale) {
            log(`[Warmer] action=WARM_SKIPPED_FRESH city=${city}`);
            summary.skipped.push({ city, reason: "fresh" });
            continue;
        }

        log(`[Warmer] action=WARM_FETCH city=${city}`);
        try {
            // priority "LOW": if the budget was consumed by a real request
            // between the check above and this call, fetchListings/fetchAmber
            // will itself skip rather than force the request through — the
            // same protection every other LOW-priority caller gets.
            const result = await fetchListings({ city, page: 1, limit: 50 }, "LOW", "cache-warmer");
            summary.warmed.push({ city, cacheStatus: result.cacheStatus });
            if (result.cacheStatus === "MISS") warmedCount += 1;
        } catch (err) {
            // A warm attempt failing (budget exhausted between check and call,
            // Amber timeout, lock busy, etc.) is expected and never fatal —
            // this is opportunistic background work, not a required operation.
            log(`[Warmer] action=WARM_FAILED city=${city} error=${err.message}`);
            summary.skipped.push({ city, reason: "error" });
        }
    }

    try {
        await writeCursor(cursor + WARM_BATCH_SIZE);
    } catch (err) {
        // Rotation cursor is just an optimization for even coverage over
        // time — losing this write only means the next run starts from the
        // same place, not a correctness problem.
        log(`[Warmer] action=REDIS_UNAVAILABLE — could not persist rotation cursor`);
    }

    summary.amberCallsMade = warmedCount;
    return summary;
}

module.exports = { runCacheWarmer, WARM_TARGET_CITIES, WARM_BATCH_SIZE, WARM_BUDGET_THRESHOLD };
