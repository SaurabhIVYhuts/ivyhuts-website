#!/usr/bin/env node
// Milestone 6 (IVYHUTS_ACCOMMODATION_HEALTH_REPORT.md) diagnostic script.
//
// READ ONLY, by construction: this script only calls the read-only
// aggregation/query functions in api/_lib/accommodationHealth.js — the same
// module the /api/admin/accommodation/inventory-health endpoint uses, so the
// CLI report and the dashboard endpoint can never disagree on what a metric
// means. It never imports amberGateway.js, never calls fetchListings/
// fetchAmber, never calls persistResidences/persistResidencesRaw/
// requestBackgroundRefresh/attemptCityRefresh, and performs zero Mongo
// writes of any kind.
//
// Usage: node scripts/report-accommodation-index-health.js [--important-only]
"use strict";

const path = require("path");
const ROOT = path.join(__dirname, "..");
require("dotenv").config({ path: path.join(ROOT, ".env.local") });
require("dotenv").config({ path: path.join(ROOT, ".env") });

const { connectToDatabase, disconnectFromDatabase } = require(path.join(ROOT, "api", "_lib", "mongodb"));
const {
    buildCityDiagnostics,
    summarizeCityDiagnostics,
    detectDuplicates,
    classifySuspiciousCities,
    buildPriorityInvestigationList,
    getQueuedCitiesSet,
} = require(path.join(ROOT, "api", "_lib", "accommodationHealth"));

// Section 10: explicitly required diagnostic rows, always shown regardless
// of ranking, even if a city doesn't otherwise make the top-30 list.
const IMPORTANT_CITIES = ["manchester", "derby", "barcelona", "sheffield", "leeds", "glasgow"];

function fmtDate(d) {
    return d ? new Date(d).toISOString() : "never";
}

async function main() {
    const importantOnly = process.argv.includes("--important-only");
    console.log("=== IVYHUTS Accommodation Inventory Health Report (read-only) ===\n");
    console.log(`Generated: ${new Date().toISOString()}\n`);

    await connectToDatabase();

    const [cityDiagnostics, duplicates, queuedSet] = await Promise.all([buildCityDiagnostics(), detectDuplicates(), getQueuedCitiesSet()]);
    const summary = summarizeCityDiagnostics(cityDiagnostics, queuedSet);

    console.log("--- Health Summary (Section 2) ---");
    console.log(JSON.stringify(summary, null, 2));

    console.log("\n--- Missing-Meta Report (Phase 4) ---");
    const missingMeta = cityDiagnostics
        .filter((r) => !r.metaExists && r.residenceCount > 0)
        .sort((a, b) => b.residenceCount - a.residenceCount);
    console.log(`Total cities with residence rows but no AccommodationIndexMeta: ${missingMeta.length}\n`);
    console.log("| City | Residence Rows | Coordinates | Room Data | Last Known State |");
    console.log("|------|----------------|-------------|-----------|-------------------|");
    const toShow = importantOnly ? missingMeta.slice(0, 30) : missingMeta;
    for (const r of toShow) {
        console.log(`| ${r.city} | ${r.residenceCount} | ${r.withCoordinates}/${r.residenceCount} | ${r.withRoomData}/${r.residenceCount} | MISSING (never refreshed) |`);
    }
    if (importantOnly && missingMeta.length > 30) console.log(`... and ${missingMeta.length - 30} more (run without --important-only to see all)`);

    console.log("\n--- Failed-Refresh Cities (consecutiveFailures > 0) ---");
    const failed = cityDiagnostics.filter((r) => r.consecutiveFailures > 0).sort((a, b) => b.consecutiveFailures - a.consecutiveFailures);
    if (failed.length === 0) {
        console.log("None — 0 cities currently have any recorded refresh failure.");
    } else {
        for (const r of failed) console.log(`  ${r.city}: ${r.consecutiveFailures} consecutive failures, lastErrorAt=${fmtDate(r.lastErrorAt)}, lastError=${JSON.stringify(r.lastError)}`);
    }

    console.log("\n--- Duplicate Detection (Phase 6) ---");
    console.log(`A. Duplicate sourceId groups: ${duplicates.duplicateSourceIds.length}`);
    duplicates.duplicateSourceIds.slice(0, 10).forEach((d) => console.log(`   DUPLICATE_SOURCE_ID sourceId=${d.sourceId} count=${d.count} cities=${JSON.stringify(d.cities)}`));
    console.log(`B. Same name + same city, different sourceId groups: ${duplicates.sameNameDifferentSourceId.length}`);
    duplicates.sameNameDifferentSourceId.forEach((d) => console.log(`   SAME_NAME_DIFFERENT_SOURCE_ID name="${d.name}" city=${d.city} sourceIds=${JSON.stringify(d.sourceIds)}`));
    console.log(`C. Same slug, different sourceId groups: ${duplicates.sameSlugDifferentSourceId.length}`);
    duplicates.sameSlugDifferentSourceId.forEach((d) => console.log(`   SAME_SLUG_DIFFERENT_SOURCE_ID slug=${d.slug} sourceIds=${JSON.stringify(d.sourceIds)}`));

    console.log("\n--- Suspicious Cities (Phase 7) ---");
    const suspicious = classifySuspiciousCities(cityDiagnostics, duplicates);
    console.log(`Total flagged SUSPICIOUS: ${suspicious.length}`);
    for (const s of suspicious) {
        console.log(`  SUSPICIOUS: ${s.city} (${s.residenceCount} rows)`);
        s.reasons.forEach((r) => console.log(`    - ${r}`));
    }

    console.log("\n--- Priority Investigation List (Phase 9, top 30) ---");
    const priority = buildPriorityInvestigationList(cityDiagnostics, duplicates, suspicious, 30);
    priority.forEach((p, i) => console.log(`  ${i + 1}. ${p.city} — score=${p.score} residenceCount=${p.residenceCount} state=${p.state} flags=${JSON.stringify(p.flags)}`));

    console.log("\n--- Important Cities (Section 10) ---");
    for (const city of IMPORTANT_CITIES) {
        const row = cityDiagnostics.find((r) => r.city === city);
        if (!row) {
            console.log(`  ${city}: NOT FOUND in AccommodationResidence at all`);
            continue;
        }
        console.log(`  ${city}: residenceCount=${row.residenceCount} state=${row.state} metaExists=${row.metaExists} lastRefreshedAt=${fmtDate(row.lastRefreshedAt)} withCoordinates=${row.withCoordinates}/${row.residenceCount} withRoomData=${row.withRoomData}/${row.residenceCount} queued=${row.queued}`);
    }

    await disconnectFromDatabase();
    process.exit(0);
}

main().catch((err) => { console.error("Report script crashed:", err); process.exit(1); });
