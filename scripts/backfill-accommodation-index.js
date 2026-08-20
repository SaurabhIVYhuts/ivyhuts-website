#!/usr/bin/env node
// Milestone 4 (IVYHUTS_MILESTONE_4_INVENTORY_REFRESH_REPORT.md): controlled,
// manually-run backfill for the AccommodationIndexMeta coverage gap
// (Milestone 2 measured 527/575 cities with AccommodationResidence rows but
// no AccommodationIndexMeta document at all — reproduced here by the SAME
// query scripts/measure-meta-coverage.js already used).
//
// SAFETY:
//   - NEVER calls Amber. This script only reads MongoDB and writes to the
//     small Redis-backed refresh queue (accommodationIndex.js's
//     requestBackgroundRefresh) — the actual refresh work happens later,
//     gradually, via the EXISTING */5 * * * * cache-warmer cron
//     (api/warm-amber-cache.js), which drains a couple of queued cities per
//     tick through the normal budgeted/locked/cached fetchListings() path.
//     This script cannot, by itself, cause a single Amber HTTP request.
//   - Dry-run by default. Pass --live to actually write to the queue.
//   - Bounded batch size (--limit, default 20) — this deliberately does NOT
//     queue all 527 cities in one run. Re-run the script (or let it run on a
//     schedule you control) to make further progress; the queue's own
//     dedup (a Set, not a list) makes re-running safe at any time — a city
//     already queued is silently skipped, never queued twice.
//   - "Resume" is implicit: since queueing is idempotent, there's no cursor
//     to track — a re-run naturally skips whatever's already queued or
//     already refreshed (has a fresh/stale-but-recent Meta doc by then), and
//     continues with the highest-value remaining candidates (sorted by
//     existing row count, descending, so cities that already have the most
//     real indexed inventory get prioritized).
//
// Usage:
//   node scripts/backfill-accommodation-index.js --dry-run [--limit N]
//   node scripts/backfill-accommodation-index.js --live --limit 20
"use strict";
const path = require("path");
const ROOT = path.join(__dirname, "..");
require("dotenv").config({ path: path.join(ROOT, ".env.local") });
require("dotenv").config({ path: path.join(ROOT, ".env") });

const { connectToDatabase, disconnectFromDatabase } = require(path.join(ROOT, "api", "_lib", "mongodb"));
const AccommodationResidence = require(path.join(ROOT, "api", "_lib", "models", "AccommodationResidence"));
const AccommodationIndexMeta = require(path.join(ROOT, "api", "_lib", "models", "AccommodationIndexMeta"));
const { requestBackgroundRefresh, REFRESH_QUEUE_KEY } = require(path.join(ROOT, "api", "_lib", "accommodationIndex"));
const { sharedGet } = require(path.join(ROOT, "api", "_lib", "sharedStore"));

function parseArgs(argv) {
    const args = { dryRun: true, limit: 20 };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === "--live") args.dryRun = false;
        else if (argv[i] === "--dry-run") args.dryRun = true;
        else if (argv[i] === "--limit") args.limit = Number(argv[++i]) || args.limit;
    }
    return args;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    console.log(`=== Accommodation Index Backfill (${args.dryRun ? "DRY RUN — no writes" : "LIVE — will write to the refresh queue"}) ===`);
    console.log(`Batch limit this run: ${args.limit}\n`);

    await connectToDatabase();

    const residenceCities = await AccommodationResidence.distinct("city");
    const metaCities = await AccommodationIndexMeta.distinct("city");
    const metaSet = new Set(metaCities);
    const noMeta = residenceCities.filter((c) => !metaSet.has(c));

    console.log(`Cities with residence rows but no AccommodationIndexMeta doc: ${noMeta.length}/${residenceCities.length}`);

    let alreadyQueued = [];
    try {
        const queued = await sharedGet(REFRESH_QUEUE_KEY);
        alreadyQueued = Array.isArray(queued) ? queued : [];
    } catch (err) {
        console.log(`(could not read current queue state: ${err.message} — proceeding, queueing is idempotent either way)`);
    }
    console.log(`Currently queued for background refresh: ${alreadyQueued.length}\n`);

    // Prioritize cities with the most already-indexed inventory — these are
    // both the highest-value candidates (most existing real data to keep
    // fresh) and, per Milestone 2's own findings, plausibly the ones whose
    // very first refresh timed out under the old REFRESH_TIMEOUT_MS (large
    // cities take longer), which is exactly the condition this milestone
    // fixes.
    const counted = [];
    for (const city of noMeta) {
        const count = await AccommodationResidence.countDocuments({ city });
        counted.push({ city, count });
    }
    counted.sort((a, b) => b.count - a.count);

    const candidates = counted.filter((c) => !alreadyQueued.includes(c.city)).slice(0, args.limit);

    console.log(`Candidates for this run (top ${candidates.length} by row count, excluding already-queued):`);
    candidates.forEach((c) => console.log(`  ${c.city}: ${c.count} rows`));

    if (args.dryRun) {
        console.log(`\nDRY RUN — nothing was written. Re-run with --live to actually queue these ${candidates.length} cities.`);
    } else {
        let queuedCount = 0;
        for (const c of candidates) {
            await requestBackgroundRefresh(c.city);
            queuedCount++;
        }
        console.log(`\nQueued ${queuedCount} cities for background refresh. They will be drained a couple at a time by the existing`);
        console.log(`*/5 * * * * cache-warmer cron (api/warm-amber-cache.js) — no Amber call was made by this script itself.`);
    }

    console.log(`\nRemaining no-meta cities after this run: ${noMeta.length - candidates.length} (run again to continue).`);

    await disconnectFromDatabase();
}

main().catch((err) => {
    console.error("Backfill script crashed:", err);
    process.exitCode = 1;
});
