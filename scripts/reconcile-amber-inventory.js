#!/usr/bin/env node
// Milestone 12 (IVYHUTS_MILESTONE_12_AMBER_INVENTORY_RECONCILIATION_REPORT.md):
// read-only, identity-level Amber <-> Mongo reconciliation tool.
//
// SAFETY:
//   - NEVER calls Amber directly. Only amberGateway.js's own fetchListings()
//     is used — LOW priority, never competes with real MEDIUM/HIGH traffic,
//     backs off silently rather than erroring if the budget is tight. Same
//     precedent as scripts/measure-inventory-reconciliation.js (Milestone 2)
//     and scripts/measure-milestone-5-reconciliation.js (Milestone 5).
//   - Exactly ONE fetchListings() call per city (bounded by the gateway's
//     own existing pagination/rate/deadline protections, unchanged).
//   - Cities are processed SEQUENTIALLY, never concurrently — this script
//     itself never fans out multiple simultaneous Amber requests.
//   - Zero Mongo writes. Zero deletes. Zero upserts. Read-only throughout.
//   - Frontend never touches Amber — this is a backend-only Node script.
//
// Usage:
//   node scripts/reconcile-amber-inventory.js --cities Manchester,Derby
//   node scripts/reconcile-amber-inventory.js --cities Manchester,Derby,Barcelona,Sheffield,Leeds,Glasgow,Liverpool
"use strict";

const path = require("path");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
require("dotenv").config({ path: path.join(ROOT, ".env.local") });
require("dotenv").config({ path: path.join(ROOT, ".env") });

const { connectToDatabase, disconnectFromDatabase } = require(path.join(ROOT, "api", "_lib", "mongodb"));
const AccommodationResidence = require(path.join(ROOT, "api", "_lib", "models", "AccommodationResidence"));
const AccommodationIndexMeta = require(path.join(ROOT, "api", "_lib", "models", "AccommodationIndexMeta"));
const { fetchListings, normalizeCityName } = require(path.join(ROOT, "api", "_lib", "amberGateway"));
const { mapAmberItemToResidence, extractResultArray, classifyCityState } = require(path.join(ROOT, "api", "_lib", "accommodationIndex"));

function parseArgs(argv) {
    const citiesArg = argv.find((a) => a.startsWith("--cities="));
    const cities = citiesArg ? citiesArg.split("=")[1].split(",").map((c) => c.trim()).filter(Boolean) : ["Manchester", "Derby"];
    return { cities };
}

// The gateway itself never returns a machine-readable flag distinguishing
// "primary city-filtered page was trustworthy" from "primary was rejected,
// fell back to paging the UNFILTERED catalog" (amberGateway.js lines
// ~682-760) — both branches return the identical {data, cacheStatus} shape.
// The only real, existing evidence of which branch ran is the gateway's own
// console.log action codes (FETCH_LISTINGS_DONE vs FETCH_LISTINGS_DONE_FALLBACK
// / PAGINATE_FAILED / FALLBACK_PAGE_FAILED). Capturing those lines is
// read-only observation of output the gateway already produces — NOT a
// modification of gateway behavior — and lets this script honestly flag
// when a low amberCount is a structural artifact of the bounded
// FALLBACK_MAX_EXTRA_PAGES scan (which only samples a few pages of the
// ~86-page global catalog) rather than genuine evidence of a small city.
function captureGatewayLog(fn) {
    const lines = [];
    const originalLog = console.log;
    console.log = (...args) => { lines.push(args.join(" ")); originalLog(...args); };
    return fn().finally(() => { console.log = originalLog; }).then((result) => ({ result, lines }));
}

async function reconcileCity(city) {
    const normalizedCity = normalizeCityName(city);

    // ── SOURCE INVENTORY (Amber, live, one bounded gateway call) ──────────
    let amberResult;
    let amberError = null;
    let gatewayLogLines = [];
    try {
        const captured = await captureGatewayLog(() => fetchListings({ city, page: 1, limit: 150 }, "LOW", "milestone12-reconcile"));
        amberResult = captured.result;
        gatewayLogLines = captured.lines;
    } catch (err) {
        amberError = err.message;
    }
    const usedFallbackPath = gatewayLogLines.some((l) => l.includes("FETCH_LISTINGS_DONE_FALLBACK"));
    const fallbackPagesFailed = gatewayLogLines.some((l) => l.includes("FALLBACK_PAGE_FAILED"));
    // Explicit, honest disambiguation (do not let "amber=0" silently mean
    // two different things): a LOW-priority caller can be skipped outright
    // if the shared budget is tight — that returns cacheStatus
    // "SKIPPED_LOW_PRIORITY" with data:null, which must NEVER be reported as
    // "confirmed 0 live properties." This case is flagged explicitly so it's
    // never mistaken for a genuine reconciliation result.
    const wasSkipped = amberResult && amberResult.cacheStatus === "SKIPPED_LOW_PRIORITY";
    const rawAmberItems = amberResult && !wasSkipped ? extractResultArray(amberResult.data) : [];
    const amberMetaCount = amberResult?.data?.data?.meta?.count ?? null;

    // Run the SAME canonical mapper every real refresh uses, to see which
    // raw items would be accepted/rejected, and why — reusing Milestone 5's
    // rejection-reason instrumentation rather than re-deriving it.
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
    const amberSourceIds = new Set(normalized.map((n) => n.mapped.propertyId));
    const amberDuplicatesWithinPage = rawAmberItems.length - new Set(rawAmberItems.map((r) => String(r.id))).size;

    // ── CANONICAL INVENTORY (Mongo, real, current state) ───────────────────
    const mongoDocs = await AccommodationResidence.find({ city: normalizedCity }).lean();
    const mongoSourceIds = new Set(mongoDocs.map((d) => d.propertyId));
    const meta = await AccommodationIndexMeta.findOne({ city: normalizedCity }).lean();
    const refreshState = classifyCityState(meta, Date.now());

    // ── IDENTITY-LEVEL SET COMPARISON (Part 21 — never trust counts alone) ─
    const missingFromMongoIds = [...amberSourceIds].filter((id) => !mongoSourceIds.has(id));
    const mongoOnlyIds = [...mongoSourceIds].filter((id) => !amberSourceIds.has(id));
    const matchedIds = [...amberSourceIds].filter((id) => mongoSourceIds.has(id));

    const missingProperties = missingFromMongoIds.map((id) => {
        const entry = normalized.find((n) => n.mapped.propertyId === id);
        return {
            sourceId: id,
            name: entry?.mapped.propertyName || null,
            city: normalizedCity,
            country: entry?.mapped.country || null,
            slug: entry?.mapped.slug || null,
            classification: "MISSING_FROM_REFRESH", // this city's Mongo mirror has never captured this specific, currently-live property
            evidence: `present in this live Amber page fetch (source=milestone12-reconcile), absent from AccommodationResidence for city=${normalizedCity} as of this run`,
        };
    });

    // Duplicate / data-quality checks on the Mongo side (real, current data).
    const mongoIdCounts = new Map();
    for (const d of mongoDocs) mongoIdCounts.set(d.propertyId, (mongoIdCounts.get(d.propertyId) || 0) + 1);
    const mongoDuplicates = [...mongoIdCounts.entries()].filter(([, c]) => c > 1);
    const mongoMissingCoords = mongoDocs.filter((d) => d.latitude == null || d.longitude == null).length;
    const mongoMissingRoomData = mongoDocs.filter((d) => (!Array.isArray(d.roomTypes) || d.roomTypes.length === 0) && !(d.roomsCount > 0)).length;
    const mongoMissingAvailability = mongoDocs.filter((d) => typeof d.available !== "boolean").length; // schema-defaulted, expect 0

    return {
        city: normalizedCity,
        // INCONCLUSIVE — not "confirmed 0 missing" — whenever the LOW-priority
        // request was skipped for budget reasons. Every downstream Amber-vs-
        // Mongo comparison field below is meaningless (not "zero", genuinely
        // UNKNOWN) for this city when this flag is true; report readers must
        // check this before trusting missingFromMongo/matched for this city.
        amberDataInconclusive: wasSkipped || usedFallbackPath,
        amberSkippedReason: wasSkipped
            ? "SKIPPED_LOW_PRIORITY (shared Amber rate budget was exhausted at request time)"
            : usedFallbackPath
            ? `FALLBACK_PATH (primary city-filtered page was rejected as untrustworthy by amberGateway.js's own matchesCity() check; result comes from a BOUNDED scan of only a few pages of the unfiltered global catalog, not a genuine city-scoped fetch — structurally undercounts and must not be read as this city's true Amber inventory${fallbackPagesFailed ? "; some fallback pages additionally failed (budget/deadline exhausted mid-scan)" : ""})`
            : null,
        amberCount: rawAmberItems.length,
        amberMetaCount,
        amberUniqueCount: amberSourceIds.size,
        amberRejectedCount: rejected.length,
        amberRejectedReasons: rejected.reduce((acc, r) => { acc[r.reason] = (acc[r.reason] || 0) + 1; return acc; }, {}),
        amberDuplicatesWithinPage,
        amberError,
        mongoCount: mongoDocs.length,
        matched: matchedIds.length,
        missingFromMongo: missingFromMongoIds.length,
        mongoOnly: mongoOnlyIds.length,
        duplicates: mongoDuplicates.length,
        missingCoordinates: mongoMissingCoords,
        missingRoomData: mongoMissingRoomData,
        missingAvailability: mongoMissingAvailability,
        refreshState,
        lastRefreshedAt: meta?.lastRefreshedAt || null,
        missingProperties: (wasSkipped || usedFallbackPath) ? [] : missingProperties,
    };
}

async function main() {
    const { cities } = parseArgs(process.argv.slice(2));
    console.log(`=== Milestone 12 — Amber <-> Mongo Inventory Reconciliation (read-only) ===`);
    console.log(`Cities (sequential, LOW priority, one bounded gateway call each): ${cities.join(", ")}\n`);

    await connectToDatabase();

    const report = { generatedAt: new Date().toISOString(), cities: {} };
    const allMissingProperties = [];

    for (const city of cities) {
        console.log(`--- Reconciling ${city} ---`);
        const result = await reconcileCity(city);
        report.cities[result.city] = result;
        allMissingProperties.push(...result.missingProperties.map((p) => ({ ...p })));
        if (result.amberDataInconclusive) {
            console.log(`  *** INCONCLUSIVE: ${result.amberSkippedReason} — this city's Amber-vs-Mongo comparison is UNKNOWN, not "0 missing" ***`);
        }
        console.log(`  amber=${result.amberCount} (unique=${result.amberUniqueCount}, rejected=${result.amberRejectedCount}) mongo=${result.mongoCount} matched=${result.matched} missingFromMongo=${result.missingFromMongo} mongoOnly=${result.mongoOnly} duplicates=${result.duplicates} refreshState=${result.refreshState}`);
        if (result.amberError) console.log(`  AMBER ERROR: ${result.amberError}`);
    }

    report.missingProperties = allMissingProperties;

    const totalAmber = Object.values(report.cities).reduce((s, c) => s + c.amberUniqueCount, 0);
    const totalMatched = Object.values(report.cities).reduce((s, c) => s + c.matched, 0);
    const totalMissing = Object.values(report.cities).reduce((s, c) => s + c.missingFromMongo, 0);
    const totalMongoOnly = Object.values(report.cities).reduce((s, c) => s + c.mongoOnly, 0);
    report.global = {
        totalAmberUnique: totalAmber,
        totalMatched,
        totalMissingFromMongo: totalMissing,
        totalMongoOnly,
        coveragePercentage: totalAmber > 0 ? Math.round((totalMatched / totalAmber) * 1000) / 10 : null,
    };

    console.log("\n--- Global ---");
    console.log(JSON.stringify(report.global, null, 2));

    const outPath = path.join(ROOT, "IVYHUTS_MILESTONE_12_RECONCILIATION_DATA.json");
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.log(`\nFull data written to ${outPath}`);

    await disconnectFromDatabase();
    process.exit(0);
}

main().catch((err) => { console.error("Reconciliation script crashed:", err); process.exit(1); });
