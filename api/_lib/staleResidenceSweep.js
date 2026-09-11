// Bounded, resumable "is this AccommodationResidence row still a real Amber
// property" sweep — the automated counterpart to scripts/prune-stale-residences.js
// (see that file's own header for full background on WHY stale rows
// accumulate). That script requires a human to run it by hand per city;
// this module lets the same check run forever via an external cron hitting
// api/_lib/routes/content/prune-stale-residences-cron.js, a few rows per
// tick, exactly the way api/_lib/cacheWarmer.js already warms cities: no
// sleep/delay loop (a serverless invocation shouldn't sit idle burning
// duration), just a small per-tick batch gated by the SAME live budget check
// real requests use, paced by how often the external cron fires.
//
// Cursor: last processed AccommodationResidence _id (Mongo ObjectIds sort
// insertion-order), stored in Redis like cacheWarmer's ROTATION_CURSOR_KEY.
// Using $gt on _id (never skip/limit) means a row deleted mid-sweep by this
// or any other process never desyncs the cursor. Reaching the end wraps back
// to the start, so the sweep is a continuous rotation over the whole
// collection, not a one-shot job.
const { sharedGet, sharedSet, peekRecentRequestCount, log } = require("./sharedStore");
const { fetchAmber, RATE_BUDGET_PER_MINUTE, RATE_WINDOW_MS, AmberGatewayError } = require("./amberGateway");
const { extractResultArray } = require("./accommodationIndex");
const AccommodationResidence = require("./models/AccommodationResidence");
const { connectToDatabase } = require("./mongodb");

const SOURCE = "stale-residence-sweep-cron";

// Deliberately tiny per tick — this is a background rotation, not a job that
// needs to finish. Proportional pacing (not a fixed count) would overcomplicate
// this for no real benefit given how small the budget already is.
const SWEEP_BATCH_SIZE = Number(process.env.STALE_SWEEP_BATCH_SIZE) || 5;

// Same "leave headroom for real users" fraction cacheWarmer.js uses — both
// modules check the SAME live usage counter independently right before each
// request, so running back-to-back never compounds into an actual overrun.
const SWEEP_BUDGET_FRACTION = 0.5;
const SWEEP_BUDGET_THRESHOLD = Math.max(1, Math.floor(RATE_BUDGET_PER_MINUTE * SWEEP_BUDGET_FRACTION));

const CURSOR_KEY = "amber:prune:cursor";
const CURSOR_TTL_SECONDS = 30 * 24 * 60 * 60; // long-lived; just a rotation index, not real data

async function readCursor() {
    const stored = await sharedGet(CURSOR_KEY);
    return stored || null;
}

async function writeCursor(id) {
    await sharedSet(CURSOR_KEY, id ? String(id) : "", CURSOR_TTL_SECONDS);
}

async function fetchBatch(afterId) {
    const query = { slug: { $exists: true, $ne: null } };
    if (afterId) query._id = { $gt: afterId };
    return AccommodationResidence.find(query).sort({ _id: 1 }).select("_id slug propertyName city").limit(SWEEP_BATCH_SIZE).lean();
}

// Runs one bounded sweep tick. Safe to call more than once concurrently or in
// back-to-back invocations: a row is only ever deleted after a live Amber
// fetch confirms it's really gone, and re-checking an already-deleted row
// (lost a race with another tick) is a harmless no-op detail fetch.
async function runStaleResidenceSweep() {
    const summary = { checked: [], deleted: [], skipped: [] };
    await connectToDatabase();

    let recentUsage;
    try {
        recentUsage = await peekRecentRequestCount(RATE_WINDOW_MS);
    } catch (err) {
        log(`[PruneSweep] action=REDIS_UNAVAILABLE — stopping without checking any rows`);
        summary.error = "cache_unavailable";
        return summary;
    }
    if (recentUsage >= SWEEP_BUDGET_THRESHOLD) {
        log(`[PruneSweep] action=SWEEP_SKIPPED_BUDGET usage=${recentUsage}/${RATE_BUDGET_PER_MINUTE} threshold=${SWEEP_BUDGET_THRESHOLD}`);
        summary.skipped.push({ reason: "budget", usage: recentUsage });
        return summary;
    }

    let cursorId;
    try {
        cursorId = await readCursor();
    } catch (err) {
        log(`[PruneSweep] action=REDIS_UNAVAILABLE — stopping without checking any rows`);
        summary.error = "cache_unavailable";
        return summary;
    }

    let rows = await fetchBatch(cursorId);
    let wrappedToStart = false;
    if (rows.length === 0 && cursorId) {
        rows = await fetchBatch(null); // reached the end — wrap around
        wrappedToStart = true;
    }
    summary.wrapped = wrappedToStart;

    let lastId = cursorId;
    for (const row of rows) {
        lastId = row._id;

        let usageNow;
        try {
            usageNow = await peekRecentRequestCount(RATE_WINDOW_MS);
        } catch (err) {
            log(`[PruneSweep] action=REDIS_UNAVAILABLE slug=${row.slug} — stopping this tick`);
            break;
        }
        if (usageNow >= SWEEP_BUDGET_THRESHOLD) {
            log(`[PruneSweep] action=SWEEP_SKIPPED_BUDGET slug=${row.slug} usage=${usageNow}/${RATE_BUDGET_PER_MINUTE}`);
            summary.skipped.push({ slug: row.slug, reason: "budget" });
            break; // budget's gone for this tick — later rows would all skip anyway
        }

        try {
            const result = await fetchAmber({ type: "detail", params: { slug: row.slug }, priority: "LOW", source: SOURCE });
            const item = extractResultArray(result.data)[0];
            summary.checked.push(row.slug);
            if (!item) {
                await AccommodationResidence.deleteOne({ _id: row._id });
                summary.deleted.push(`${row.propertyName} (${row.slug})`);
                log(`[PruneSweep] action=DELETED city=${row.city} slug=${row.slug}`);
            }
        } catch (err) {
            const isBudgetOrCooldown = err instanceof AmberGatewayError && (err.code === "budget_exceeded" || err.code === "cooldown");
            summary.skipped.push({ slug: row.slug, reason: isBudgetOrCooldown ? "budget" : "error", error: isBudgetOrCooldown ? undefined : err.message });
            log(`[PruneSweep] action=${isBudgetOrCooldown ? "SKIPPED_BUDGET" : "ERROR"} slug=${row.slug} error=${err.message}`);
            if (isBudgetOrCooldown) break; // no point burning the rest of this tick's rows
        }
    }

    try {
        await writeCursor(lastId);
    } catch (err) {
        // Rotation cursor is just an optimization for even coverage over
        // time — losing this write only means the next tick re-covers the
        // same rows, not a correctness problem.
        log(`[PruneSweep] action=REDIS_UNAVAILABLE — could not persist rotation cursor`);
    }

    return summary;
}

module.exports = { runStaleResidenceSweep, SWEEP_BATCH_SIZE };
