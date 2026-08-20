#!/usr/bin/env node
// Milestone 6 (IVYHUTS_MILESTONE_6_INVENTORY_LOSS_REPORT.md, Phases 2-3, 15)
// — runs api/_lib/accommodationTrace.js's traceAmberInventory() against the
// representative city set for this milestone: Manchester, Derby (mandatory),
// plus Barcelona/Sheffield/Leeds/Glasgow (high-inventory, missing-metadata
// cities per IVYHUTS_ACCOMMODATION_HEALTH_REPORT.md) and Liverpool (the one
// city with a known, already-confirmed-benign same-name-different-sourceId
// pattern).
//
// SAFETY: uses ONLY amberGateway.js's own fetchListings() (LOW priority,
// never competes with real traffic) — one bounded call per city, up to
// REFRESH_TARGET_COUNT=150 (3 Amber pages) each. By default `--persist` is
// OFF (zero Mongo writes, pure inspection). Pass `--persist=CITY_NAME` to
// additionally run ONE real (idempotent, upsert-only) write for a single
// named city, to produce real before/after Mongo counts for the milestone
// report's reconciliation table — never for all 7 at once, and never a
// delete.
"use strict";

const path = require("path");
const ROOT = path.join(__dirname, "..");
require("dotenv").config({ path: path.join(ROOT, ".env.local") });
require("dotenv").config({ path: path.join(ROOT, ".env") });

const { connectToDatabase, disconnectFromDatabase } = require(path.join(ROOT, "api", "_lib", "mongodb"));
const AccommodationResidence = require(path.join(ROOT, "api", "_lib", "models", "AccommodationResidence"));
const { traceAmberInventory } = require(path.join(ROOT, "api", "_lib", "accommodationTrace"));

const REPRESENTATIVE_CITIES = ["Manchester", "Derby", "Barcelona", "Sheffield", "Leeds", "Glasgow", "Liverpool"];

function parseArgs(argv) {
    const persistArg = argv.find((a) => a.startsWith("--persist="));
    return { persistCity: persistArg ? persistArg.split("=")[1] : null };
}

async function main() {
    const { persistCity } = parseArgs(process.argv.slice(2));
    console.log("=== Milestone 6 — Representative City Inventory Trace ===\n");
    if (persistCity) console.log(`(--persist=${persistCity}: this city's trace will perform a REAL, idempotent Mongo upsert)\n`);

    await connectToDatabase();

    for (const city of REPRESENTATIVE_CITIES) {
        const persist = persistCity && persistCity.toLowerCase() === city.toLowerCase();
        const before = await AccommodationResidence.countDocuments({ city: city.toLowerCase() });
        const trace = await traceAmberInventory(city, { priority: "LOW", source: "milestone6-trace", persist });
        console.log(`--- ${city} ${persist ? "(PERSISTED — real write)" : "(dry — zero writes)"} ---`);
        console.log(`  Mongo before: ${before}`);
        console.log(`  pagination: pages=${trace.pagination.pages} rawItems=${trace.pagination.rawItems}`);
        console.log(`  normalization/validation: accepted=${trace.normalization.accepted} rejected=${trace.normalization.rejected} reasons=${JSON.stringify(trace.validation.reasons)}`);
        console.log(`  deduplication: before=${trace.deduplication.before} after=${trace.deduplication.after} removed=${trace.deduplication.removed}`);
        console.log(`  mongo: attempted=${trace.mongo.attempted} inserted=${trace.mongo.inserted} updated=${trace.mongo.updated} failed=${trace.mongo.failed}`);
        if (trace.mongo.errors.length) trace.mongo.errors.forEach((e) => console.log(`    ERROR sourceId=${e.sourceId}: ${e.message}`));
        console.log(`  Mongo after: ${trace.finalMongoCount ?? "(not persisted, unchanged)"}`);
        console.log(`  durationMs=${trace.durationMs}`);
        if (trace.error) console.log(`  ERROR: ${trace.error}`);
        console.log("");
    }

    await disconnectFromDatabase();
    process.exit(0);
}

main().catch((err) => { console.error("Trace script crashed:", err); process.exit(1); });
