#!/usr/bin/env node
// Milestone 7 (IVYHUTS_MILESTONE_7_CONVERGENCE_REPORT.md, Phase 18): safe,
// bounded, dry-run-by-default backfill tool that DIRECTLY performs a real
// inventory refresh (unlike scripts/backfill-accommodation-index.js from
// Milestone 4, which only QUEUES cities for the cron to drain later). Use
// this tool when you want to trigger a small, controlled, IMMEDIATE refresh
// for one or a few specific cities — exactly the mechanism Milestone 7's
// controlled convergence experiment used for Barcelona/Sheffield/Manchester/
// Derby/Leeds/Glasgow.
//
// SAFETY (all verified live in Milestone 7):
//   - Uses ONLY attemptCityRefresh() (accommodationIndex.js) -> refreshCityIndex()
//     -> fetchListings() (amberGateway.js). Never calls Amber directly, never
//     bypasses the distributed per-city refresh lock, never bypasses the
//     shared rate budget.
//   - Never deletes anything. persistResidences()'s own upsert (unique index
//     {source, propertyId}) can only insert or update — confirmed live
//     across 6 real refreshes, 0 documents ever removed.
//   - Default is DRY RUN: makes zero Amber calls and zero Mongo writes —
//     only reads current Mongo state and prints what WOULD be refreshed.
//   - Bounded by --limit (candidates considered) and --max-cities (cities
//     actually refreshed this run, hard cap, default 1) — this script will
//     never run more than --max-cities real refreshes in one invocation,
//     regardless of --limit's candidate list size.
//   - --resume is implicit AND explicit: re-running with the same arguments
//     naturally skips cities that already became FRESH/STALE from a prior
//     run (classifyCityState), and --resume additionally persists a small
//     local cursor file (.backfill-inventory-progress.json, gitignored-by-
//     convention scratch state) so a --city-less priority run can continue
//     from where the last run left off instead of restarting the ranking
//     from scratch.
//
// Usage:
//   node scripts/backfill-accommodation-inventory.js --city Barcelona --limit 1 --dry-run
//   node scripts/backfill-accommodation-inventory.js --city Barcelona --live
//   node scripts/backfill-accommodation-inventory.js --live --max-cities 2 --resume   (priority-ranked, no --city)
"use strict";

const path = require("path");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
require("dotenv").config({ path: path.join(ROOT, ".env.local") });
require("dotenv").config({ path: path.join(ROOT, ".env") });

const { connectToDatabase, disconnectFromDatabase } = require(path.join(ROOT, "api", "_lib", "mongodb"));
const AccommodationResidence = require(path.join(ROOT, "api", "_lib", "models", "AccommodationResidence"));
const { attemptCityRefresh } = require(path.join(ROOT, "api", "_lib", "accommodationIndex"));
const { normalizeCityName } = require(path.join(ROOT, "api", "_lib", "amberGateway"));
const { buildCityDiagnostics, buildPriorityInvestigationList, detectDuplicates, classifySuspiciousCities } = require(path.join(ROOT, "api", "_lib", "accommodationHealth"));

const PROGRESS_FILE = path.join(ROOT, ".backfill-inventory-progress.json");

function parseArgs(argv) {
    const args = { dryRun: true, city: null, limit: 20, maxCities: 1, resume: false };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === "--live") args.dryRun = false;
        else if (argv[i] === "--dry-run") args.dryRun = true;
        else if (argv[i] === "--city") args.city = argv[++i];
        else if (argv[i] === "--limit") args.limit = Number(argv[++i]) || args.limit;
        else if (argv[i] === "--max-cities") args.maxCities = Number(argv[++i]) || args.maxCities;
        else if (argv[i] === "--resume") args.resume = true;
    }
    return args;
}

function loadProgress() {
    try { return JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8")); } catch { return { refreshedCities: [] }; }
}
function saveProgress(progress) {
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    console.log(`=== Accommodation Inventory Backfill (${args.dryRun ? "DRY RUN — zero Amber calls, zero writes" : "LIVE — real refresh, bounded"}) ===`);
    console.log(`max-cities this run: ${args.maxCities} | candidate pool limit: ${args.limit} | resume: ${args.resume}\n`);

    await connectToDatabase();

    let candidates;
    if (args.city) {
        candidates = [normalizeCityName(args.city)];
        console.log(`Targeting single city: ${candidates[0]}`);
    } else {
        const rows = await buildCityDiagnostics();
        const duplicates = await detectDuplicates();
        const suspicious = classifySuspiciousCities(rows, duplicates);
        const priority = buildPriorityInvestigationList(rows, duplicates, suspicious, args.limit);
        const progress = args.resume ? loadProgress() : { refreshedCities: [] };
        const alreadyDone = new Set(progress.refreshedCities);
        candidates = priority.map((p) => p.city).filter((c) => !alreadyDone.has(c));
        console.log(`Priority-ranked candidates (top ${args.limit}, ${alreadyDone.size} already done this resume session excluded):`);
        candidates.slice(0, args.maxCities).forEach((c, i) => console.log(`  ${i + 1}. ${c}`));
    }

    const toRun = candidates.slice(0, args.maxCities);
    if (toRun.length === 0) {
        console.log("\nNo candidates to run (either --city resolved to nothing, or --resume has already covered the priority list).");
        await disconnectFromDatabase();
        process.exit(0);
    }

    if (args.dryRun) {
        console.log(`\nDRY RUN — would refresh ${toRun.length} cit${toRun.length === 1 ? "y" : "ies"}: ${toRun.join(", ")}`);
        console.log("Re-run with --live to actually perform these refreshes (via the existing attemptCityRefresh() -> refreshCityIndex() path, real Amber calls, real bounded Mongo writes).");
        await disconnectFromDatabase();
        process.exit(0);
    }

    const progress = loadProgress();
    for (const city of toRun) {
        const before = await AccommodationResidence.countDocuments({ city });
        console.log(`\n--- Refreshing ${city} (before: ${before} residences) ---`);
        const startedAt = Date.now();
        const outcome = await attemptCityRefresh(city, "LOW", "backfill-inventory-script");
        const durationMs = Date.now() - startedAt;
        const after = await AccommodationResidence.countDocuments({ city });
        console.log(`  attempted=${outcome.attempted} refreshed=${outcome.refreshed} reason=${outcome.reason || "n/a"} residences=${outcome.residences.length} durationMs=${durationMs}`);
        console.log(`  after: ${after} residences (${after - before >= 0 ? "+" : ""}${after - before})`);
        if (after < before) {
            console.log(`  *** WARNING: residence count DECREASED for ${city} — this should never happen from a refresh (upsert-only). Investigate before running more cities. ***`);
        }
        progress.refreshedCities = Array.from(new Set([...(progress.refreshedCities || []), city]));
        saveProgress(progress);
    }

    console.log(`\nDone. ${toRun.length} cit${toRun.length === 1 ? "y" : "ies"} refreshed this run.`);
    await disconnectFromDatabase();
    process.exit(0);
}

main().catch((err) => { console.error("Backfill script crashed:", err); process.exit(1); });
