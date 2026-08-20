#!/usr/bin/env node
// Milestone 18 (IVYHUTS_MILESTONE_18_AMBER_IVYHUTS_RECONCILIATION_REPORT.md):
// deep, sourceId-level Amber <-> Mongo reconciliation with classification.
// Extends Milestone 12's reconcile-amber-inventory.js (same safety model,
// same gateway, same LOW-priority/sequential/bounded discipline) with:
//   - a citystats (meta.count) call per city, for pagination-completeness
//     evidence (Part 6) — cheap, limit=1, one extra call per city.
//   - full sourceId LISTS (not just counts) for both Amber-only and
//     Mongo-only sets.
//   - a global cross-reference: every Amber-only sourceId is checked
//     against the FULL AccommodationResidence collection (any city, not
//     just the target one) to detect city-mismatch / identity-elsewhere
//     before ever concluding "missing" (Part 8/9's explicit requirement).
//   - a decision-tree classification for every Amber-only record.
//
// SAFETY: same as Milestone 12's script — amberGateway.js only, LOW
// priority, cities processed strictly sequentially, zero Mongo writes.
//
// Usage:
//   node scripts/reconcile-inventory-deep.js --cities=Manchester,Derby
"use strict";

const path = require("path");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
require("dotenv").config({ path: path.join(ROOT, ".env.local") });
require("dotenv").config({ path: path.join(ROOT, ".env") });

const { connectToDatabase, disconnectFromDatabase } = require(path.join(ROOT, "api", "_lib", "mongodb"));
const AccommodationResidence = require(path.join(ROOT, "api", "_lib", "models", "AccommodationResidence"));
const AccommodationIndexMeta = require(path.join(ROOT, "api", "_lib", "models", "AccommodationIndexMeta"));
const { fetchListings, fetchAmber, normalizeCityName } = require(path.join(ROOT, "api", "_lib", "amberGateway"));
const { mapAmberItemToResidence, extractResultArray, classifyCityState } = require(path.join(ROOT, "api", "_lib", "accommodationIndex"));

function parseArgs(argv) {
    const citiesArg = argv.find((a) => a.startsWith("--cities="));
    const cities = citiesArg ? citiesArg.split("=")[1].split(",").map((c) => c.trim()).filter(Boolean) : ["Manchester", "Derby"];
    return { cities };
}

function captureGatewayLog(fn) {
    const lines = [];
    const originalLog = console.log;
    console.log = (...args) => { lines.push(args.join(" ")); originalLog(...args); };
    return fn().finally(() => { console.log = originalLog; }).then((result) => ({ result, lines }));
}

async function reconcileCity(city) {
    const normalizedCity = normalizeCityName(city);

    // ── Part 6 evidence: Amber's own reported total for this city filter ───
    // (known independently unreliable per the Derby precedent — supplementary
    // evidence only, never treated as ground truth on its own.)
    let citystatsCount = null;
    let citystatsError = null;
    try {
        const cs = await fetchAmber({ type: "citystats", params: { city }, priority: "LOW", source: "milestone18-deep-reconcile" });
        citystatsCount = cs?.data?.data?.meta?.count ?? null;
    } catch (err) {
        citystatsError = err.message;
    }

    // ── SOURCE INVENTORY (Amber, live, gateway-bounded pagination) ─────────
    let amberResult;
    let amberError = null;
    let gatewayLogLines = [];
    try {
        const captured = await captureGatewayLog(() => fetchListings({ city, page: 1, limit: 150 }, "LOW", "milestone18-deep-reconcile"));
        amberResult = captured.result;
        gatewayLogLines = captured.lines;
    } catch (err) {
        amberError = err.message;
    }
    const usedFallbackPath = gatewayLogLines.some((l) => l.includes("FETCH_LISTINGS_DONE_FALLBACK"));
    const deadlineOrBudgetHit = gatewayLogLines.some((l) => l.includes("PAGINATE_FAILED") || l.includes("DEADLINE_EXHAUSTED") || l.includes("BUDGET_EXCEEDED"));
    const pagesFetchedMatch = gatewayLogLines.join("\n").match(/action=FETCH_LISTINGS_DONE city=\S+ targetCount=\d+ pages=(\d+)/);
    const pagesFetched = pagesFetchedMatch ? Number(pagesFetchedMatch[1]) : null;
    const wasSkipped = amberResult && amberResult.cacheStatus === "SKIPPED_LOW_PRIORITY";
    const rawAmberItems = amberResult && !wasSkipped ? extractResultArray(amberResult.data) : [];
    const amberMetaCount = amberResult?.data?.data?.meta?.count ?? null;

    const normalized = [];
    const rejected = [];
    for (const raw of rawAmberItems) {
        const sourceId = raw?.id != null ? String(raw.id) : null;
        if (!sourceId) { rejected.push({ sourceId: null, name: raw?.name || null, reason: "MISSING_SOURCE_ID" }); continue; }
        if (!raw?.name) { rejected.push({ sourceId, name: null, reason: "MISSING_NAME" }); continue; }
        const mapped = mapAmberItemToResidence(raw, normalizedCity);
        if (!mapped) { rejected.push({ sourceId, name: raw?.name, reason: "UNKNOWN" }); continue; }
        normalized.push({ raw, mapped });
    }
    const amberIdCounts = new Map();
    for (const r of rawAmberItems) { const id = String(r.id); amberIdCounts.set(id, (amberIdCounts.get(id) || 0) + 1); }
    const amberDuplicateIds = [...amberIdCounts.entries()].filter(([, c]) => c > 1).map(([id]) => id);
    const amberSourceIds = new Set(normalized.map((n) => n.mapped.propertyId));

    // ── CANONICAL INVENTORY (Mongo, real, current, city-scoped) ────────────
    const mongoDocs = await AccommodationResidence.find({ city: normalizedCity }).lean();
    const mongoSourceIds = new Set(mongoDocs.map((d) => d.propertyId));
    const meta = await AccommodationIndexMeta.findOne({ city: normalizedCity }).lean();
    const refreshState = classifyCityState(meta, Date.now());

    const missingFromMongoIds = [...amberSourceIds].filter((id) => !mongoSourceIds.has(id));
    const mongoOnlyIds = [...mongoSourceIds].filter((id) => !amberSourceIds.has(id));
    const matchedIds = [...amberSourceIds].filter((id) => mongoSourceIds.has(id));

    const amberOnlyRecords = missingFromMongoIds.map((id) => {
        const entry = normalized.find((n) => n.mapped.propertyId === id);
        return {
            sourceId: id,
            name: entry?.mapped.propertyName || null,
            requestedCity: normalizedCity,
            country: entry?.mapped.country || null,
            slug: entry?.mapped.slug || null,
            amberLocality: entry?.raw?.location?.locality?.long_name || null,
            amberCityField: entry?.raw?.location?.city?.long_name || null,
            wasDuplicateWithinAmberPage: amberDuplicateIds.includes(id),
        };
    });

    return {
        city: normalizedCity,
        amberDataInconclusive: wasSkipped || usedFallbackPath,
        amberSkippedReason: wasSkipped
            ? "SKIPPED_LOW_PRIORITY (shared Amber rate budget was exhausted at request time)"
            : usedFallbackPath
            ? "FALLBACK_PATH (primary city-filtered page was rejected as untrustworthy; result is a bounded global-catalog scan, not a genuine city-scoped fetch)"
            : null,
        citystatsCount,
        citystatsError,
        amberCount: rawAmberItems.length,
        amberMetaCount,
        amberUniqueCount: amberSourceIds.size,
        amberRejectedCount: rejected.length,
        amberRejectedReasons: rejected.reduce((acc, r) => { acc[r.reason] = (acc[r.reason] || 0) + 1; return acc; }, {}),
        amberDuplicateIds,
        pagesFetched,
        deadlineOrBudgetHit,
        amberError,
        mongoCount: mongoDocs.length,
        matched: matchedIds.length,
        missingFromMongo: missingFromMongoIds.length,
        mongoOnly: mongoOnlyIds.length,
        refreshState,
        lastRefreshedAt: meta?.lastRefreshedAt || null,
        amberOnlyRecords: (wasSkipped || usedFallbackPath) ? [] : amberOnlyRecords,
        mongoOnlyIds: (wasSkipped || usedFallbackPath) ? [] : mongoOnlyIds,
    };
}

// Part 8/9: for every Amber-only sourceId, check the FULL Mongo collection
// (any city, any source) — not just this one city's slice — before ever
// concluding "missing." A hit here means the property IS in Mongo, just
// filed under a different city (CITY_MISMATCH), not genuinely absent.
async function crossReferenceGlobally(amberOnlyRecords) {
    for (const rec of amberOnlyRecords) {
        const elsewhere = await AccommodationResidence.findOne({ propertyId: rec.sourceId }).lean();
        rec.foundElsewhereInMongo = Boolean(elsewhere);
        rec.elsewhereCity = elsewhere?.city || null;
        rec.elsewhereSlug = elsewhere?.slug || null;
    }
}

function classify(rec, cityResult) {
    if (rec.foundElsewhereInMongo && rec.elsewhereSlug && rec.elsewhereSlug !== rec.slug) {
        return { classification: "SOURCE_ID_MAPPING_FAILURE", evidence: `sourceId ${rec.sourceId} exists in Mongo under city="${rec.elsewhereCity}" but with a different slug ("${rec.elsewhereSlug}" vs Amber's "${rec.slug}") — same propertyId, inconsistent identity.` };
    }
    if (rec.foundElsewhereInMongo) {
        return { classification: "CITY_MISMATCH", evidence: `sourceId ${rec.sourceId} exists in Mongo under city="${rec.elsewhereCity}", not "${rec.requestedCity}" — property is present, just filed under a different city.` };
    }
    if (rec.wasDuplicateWithinAmberPage) {
        return { classification: "DEDUPLICATION_COLLISION", evidence: `sourceId ${rec.sourceId} appeared more than once within the same Amber page fetch for "${rec.requestedCity}" — possible upstream duplicate.` };
    }
    if (cityResult.deadlineOrBudgetHit) {
        return { classification: "PAGINATION_MISSING", evidence: `This city's fetch hit a deadline/budget/pagination bound (pagesFetched=${cityResult.pagesFetched}, citystats meta.count=${cityResult.citystatsCount}) — some genuine Amber inventory for this city may not have been captured by this pull at all, so this record's status beyond "present in what we fetched" is unproven either way.` };
    }
    return { classification: "UNKNOWN", evidence: `No corroborating evidence found: not present elsewhere in Mongo, not a within-page Amber duplicate, and this city's fetch completed without hitting a pagination/budget bound. Genuinely unexplained with available evidence — not guessed.` };
}

async function main() {
    const { cities } = parseArgs(process.argv.slice(2));
    console.log(`=== Milestone 18 — Deep Amber <-> Mongo Reconciliation (read-only) ===`);
    console.log(`Cities: ${cities.join(", ")}\n`);

    await connectToDatabase();
    const report = { generatedAt: new Date().toISOString(), cities: {} };

    for (const city of cities) {
        console.log(`--- Reconciling ${city} ---`);
        const result = await reconcileCity(city);
        await crossReferenceGlobally(result.amberOnlyRecords);
        for (const rec of result.amberOnlyRecords) {
            const { classification, evidence } = classify(rec, result);
            rec.classification = classification;
            rec.evidence = evidence;
        }
        report.cities[result.city] = result;
        if (result.amberDataInconclusive) console.log(`  *** INCONCLUSIVE: ${result.amberSkippedReason} ***`);
        console.log(`  citystats.meta.count=${result.citystatsCount} amber=${result.amberCount} unique=${result.amberUniqueCount} pagesFetched=${result.pagesFetched} deadlineOrBudgetHit=${result.deadlineOrBudgetHit} mongo=${result.mongoCount} matched=${result.matched} missingFromMongo=${result.missingFromMongo} mongoOnly=${result.mongoOnly}`);
        if (result.amberOnlyRecords.length) {
            for (const rec of result.amberOnlyRecords) console.log(`    AMBER-ONLY ${rec.sourceId} "${rec.name}" -> ${rec.classification}: ${rec.evidence}`);
        }
    }

    const outPath = path.join(ROOT, "IVYHUTS_MILESTONE_18_RECONCILIATION_DATA.json");
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.log(`\nFull data written to ${outPath}`);

    await disconnectFromDatabase();
    process.exit(0);
}

main().catch((err) => { console.error("Reconciliation script crashed:", err); process.exit(1); });
