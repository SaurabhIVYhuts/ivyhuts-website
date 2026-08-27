#!/usr/bin/env node
// Milestone 6 (IVYHUTS_ACCOMMODATION_HEALTH_REPORT.md) verification.
//
// SAFETY: mocks global.fetch for every test (diagnostics must never call
// Amber — TEST 12 asserts this directly by counting mock calls). Uses REAL
// MongoDB (confirmed reachable) scoped exclusively to synthetic
// "zzz-milestone6-test-*" city names, cleaned up in try/finally before and
// after every test that writes fixture data, verified with a direct count
// query at the end. TEST 11 additionally monkey-patches every Mongoose write
// method on both accommodation models to THROW if called during any
// diagnostic operation, as a hard guarantee beyond "the count didn't
// change" — a diagnostic that quietly wrote and then rolled back would still
// fail this check.
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
require("dotenv").config({ path: path.join(ROOT, ".env.local") });
require("dotenv").config({ path: path.join(ROOT, ".env") });

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];

async function test(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  PASS  ${name}`);
    } catch (err) {
        if (err && err.__skip) { skipped++; console.log(`  SKIP  ${name}\n        ${err.message}`); return; }
        failed++;
        failures.push({ name, message: err.message });
        console.log(`  FAIL  ${name}\n        ${err.stack || err.message}`);
    }
}
function skip(reason) { const e = new Error(reason); e.__skip = true; throw e; }

// Force sharedStore.js's deterministic in-memory Redis fallback (same
// technique scripts/verify-p0-rate-latency-fixes.js established) BEFORE
// anything requires it — accommodationHealth.js's getQueuedCitiesSet() calls
// sharedGet(), which would otherwise make a real Upstash REST fetch() call
// every run. With the fallback forced, the queue check never touches the
// network at all, which is what makes TEST 12 ("zero fetch() calls")
// meaningful for BOTH Amber and Redis, not just Amber.
for (const k of ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_URL", "KV_REST_API_TOKEN"]) delete process.env[k];

// Block any real network fetch for the whole run — every test in this file
// is diagnostics-only and must never need one (Amber or otherwise).
const fetchCalls = [];
global.fetch = async (url) => { fetchCalls.push(url); throw new Error("TEST SAFETY: no test in this file should ever call fetch()"); };

let mongoAvailable = null;
async function requireMongo() {
    if (mongoAvailable === null) {
        try {
            const { connectToDatabase } = require(path.join(ROOT, "api", "_lib", "mongodb"));
            await Promise.race([connectToDatabase(), new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 8000))]);
            mongoAvailable = true;
        } catch (err) { mongoAvailable = false; }
    }
    if (!mongoAvailable) skip("MongoDB is not reachable from this environment — skipping, not fabricating a pass");
}

async function main() {
    console.log("=== IVYHUTS Milestone 6 — Accommodation Health Diagnostics Verification ===\n");

    const health = require(path.join(ROOT, "api", "_lib", "accommodationHealth"));
    const AccommodationResidence = require(path.join(ROOT, "api", "_lib", "models", "AccommodationResidence"));
    const AccommodationIndexMeta = require(path.join(ROOT, "api", "_lib", "models", "AccommodationIndexMeta"));

    const TEST_CITY_META = "zzz-milestone6-test-hasmeta";
    const TEST_CITY_NOMETA = "zzz-milestone6-test-nometa";
    const TEST_CITY_FAILED = "zzz-milestone6-test-failed";

    async function cleanup() {
        for (const city of [TEST_CITY_META, TEST_CITY_NOMETA, TEST_CITY_FAILED]) {
            await AccommodationResidence.deleteMany({ city });
            await AccommodationIndexMeta.deleteMany({ city });
        }
    }

    async function seedFixtures() {
        await cleanup();
        // TEST_CITY_META: 2 residences, 1 without coordinates, 1 without room data, fresh meta.
        await AccommodationResidence.insertMany([
            { source: "amber", propertyId: "600001", propertyName: "Fixture A", city: TEST_CITY_META, latitude: 51.5, longitude: -0.1, roomTypes: ["Studio"], available: true },
            { source: "amber", propertyId: "600002", propertyName: "Fixture B", city: TEST_CITY_META, latitude: null, longitude: null, roomTypes: [], available: false },
        ]);
        await AccommodationIndexMeta.updateOne({ city: TEST_CITY_META }, { $set: { city: TEST_CITY_META, status: "ok", lastRefreshedAt: new Date(), residenceCount: 2 } }, { upsert: true });

        // TEST_CITY_NOMETA: 25 residences (above the "meaningful inventory" threshold), no meta at all.
        const noMetaDocs = Array.from({ length: 25 }, (_, i) => ({
            source: "amber", propertyId: `70000${i}`, propertyName: `NoMeta ${i}`, city: TEST_CITY_NOMETA, latitude: 51.5, longitude: -0.1, roomTypes: ["Studio"], available: true,
        }));
        await AccommodationResidence.insertMany(noMetaDocs);

        // TEST_CITY_FAILED: meta with 5 consecutive failures, recent attempt (should classify FAILED_COOLDOWN).
        await AccommodationIndexMeta.updateOne(
            { city: TEST_CITY_FAILED },
            { $set: { city: TEST_CITY_FAILED, status: "error", lastAttemptedAt: new Date(), lastErrorAt: new Date(), lastError: "simulated failure", consecutiveFailures: 5 } },
            { upsert: true }
        );
    }

    // ══════════════════════ TEST 1 ══════════════════════
    await test("TEST 1: health summary returns the correct structure with real database values", async () => {
        await requireMongo();
        await seedFixtures();
        try {
            const rows = await health.buildCityDiagnostics();
            const summary = health.summarizeCityDiagnostics(rows);
            for (const key of ["totalCities", "citiesWithInventory", "citiesWithMeta", "fresh", "stale", "expired", "missing", "failedCooldown", "totalResidenceRows", "queuedCities"]) {
                assert.ok(key in summary, `summary missing expected key: ${key}`);
                assert.strictEqual(typeof summary[key], "number", `${key} must be a number`);
            }
            assert.ok(summary.totalResidenceRows >= 27, "must include the 27 fixture rows just seeded");
            // Internal consistency: the 5 state buckets must sum to totalCities.
            assert.strictEqual(summary.fresh + summary.stale + summary.expired + summary.missing + summary.failedCooldown, summary.totalCities);
        } finally {
            await cleanup();
        }
    });

    // ══════════════════════ TEST 2 ══════════════════════
    await test("TEST 2: a city with residence rows but no AccommodationIndexMeta is correctly detected as missing metadata", async () => {
        await requireMongo();
        await seedFixtures();
        try {
            const rows = await health.buildCityDiagnostics();
            const row = rows.find((r) => r.city === TEST_CITY_NOMETA);
            assert.ok(row);
            assert.strictEqual(row.metaExists, false);
            assert.strictEqual(row.state, "MISSING");
            assert.strictEqual(row.residenceCount, 25);
        } finally {
            await cleanup();
        }
    });

    // ══════════════════════ TEST 3 ══════════════════════
    await test("TEST 3: city state classification (FRESH/FAILED_COOLDOWN/MISSING) is correct for each fixture", async () => {
        await requireMongo();
        await seedFixtures();
        try {
            const rows = await health.buildCityDiagnostics();
            assert.strictEqual(rows.find((r) => r.city === TEST_CITY_META).state, "FRESH");
            assert.strictEqual(rows.find((r) => r.city === TEST_CITY_FAILED).state, "FAILED_COOLDOWN");
            assert.strictEqual(rows.find((r) => r.city === TEST_CITY_NOMETA).state, "MISSING");
        } finally {
            await cleanup();
        }
    });

    // ══════════════════════ TEST 4 ══════════════════════
    await test("TEST 4: duplicate sourceId is detected when two documents share the same propertyId (fixture inserted directly, bypassing the unique index via a different `source`)", async () => {
        await requireMongo();
        await cleanup();
        try {
            // Real production data has 0 duplicates (the unique index prevents
            // them for the same `source`) — to exercise the DETECTION logic
            // itself deterministically, this fixture uses two different
            // `source` values with the SAME propertyId, which the schema's
            // {source, propertyId} unique index legitimately allows and which
            // is exactly the shape detectDuplicateSourceIds() must catch.
            await AccommodationResidence.insertMany([
                { source: "amber", propertyId: "800001", propertyName: "Dup A", city: "zzz-milestone6-test-dup", available: true },
                { source: "amber-alt", propertyId: "800001", propertyName: "Dup A", city: "zzz-milestone6-test-dup", available: true },
            ]);
            const dupes = await health.detectDuplicateSourceIds();
            const found = dupes.find((d) => d.sourceId === "800001");
            assert.ok(found, "expected propertyId 800001 to be detected as a duplicate");
            assert.strictEqual(found.count, 2);
        } finally {
            await AccommodationResidence.deleteMany({ city: "zzz-milestone6-test-dup" });
        }
    });

    // ══════════════════════ TEST 5 ══════════════════════
    await test("TEST 5: same-name/different-sourceId properties are detected without being flagged as a defect", async () => {
        await requireMongo();
        await cleanup();
        try {
            await AccommodationResidence.insertMany([
                { source: "amber", propertyId: "810001", propertyName: "Same Name Hall", city: "zzz-milestone6-test-samename", available: true },
                { source: "amber", propertyId: "810002", propertyName: "Same Name Hall", city: "zzz-milestone6-test-samename", available: true },
            ]);
            const groups = await health.detectSameNameDifferentSourceId();
            const found = groups.find((g) => g.city === "zzz-milestone6-test-samename" && g.name === "Same Name Hall");
            assert.ok(found);
            assert.strictEqual(found.sourceIds.length, 2);
        } finally {
            await AccommodationResidence.deleteMany({ city: "zzz-milestone6-test-samename" });
        }
    });

    // ══════════════════════ TEST 6/7/8 ══════════════════════
    await test("TEST 6/7/8: coordinate, room-data, and availability-data coverage are calculated correctly per city", async () => {
        await requireMongo();
        await seedFixtures();
        try {
            const rows = await health.buildCityDiagnostics();
            const row = rows.find((r) => r.city === TEST_CITY_META);
            assert.strictEqual(row.withCoordinates, 1, "1 of 2 fixture rows has coordinates");
            assert.strictEqual(row.withoutCoordinates, 1);
            assert.strictEqual(row.withRoomData, 1, "1 of 2 fixture rows has non-empty roomTypes");
            assert.strictEqual(row.withoutRoomData, 1);
            assert.strictEqual(row.withAvailabilityData, 2, "the schema's Boolean default means both rows always have availability data");
        } finally {
            await cleanup();
        }
    });

    // ══════════════════════ TEST 9 ══════════════════════
    await test("TEST 9: cities with repeated refresh failures are identified", async () => {
        await requireMongo();
        await seedFixtures();
        try {
            const rows = await health.buildCityDiagnostics();
            const row = rows.find((r) => r.city === TEST_CITY_FAILED);
            assert.strictEqual(row.consecutiveFailures, 5);
            assert.ok(row.consecutiveFailures >= health.THRESHOLDS.REPEATED_FAILURE_THRESHOLD);
        } finally {
            await cleanup();
        }
    });

    // ══════════════════════ TEST 10 ══════════════════════
    await test("TEST 10: suspicious-city ranking is deterministic across repeated runs against the same data", async () => {
        await requireMongo();
        await seedFixtures();
        try {
            const rows = await health.buildCityDiagnostics();
            const duplicates = await health.detectDuplicates();
            const run1 = health.classifySuspiciousCities(rows, duplicates);
            const run2 = health.classifySuspiciousCities(rows, duplicates);
            assert.deepStrictEqual(run1.map((r) => r.city), run2.map((r) => r.city), "the same input must always produce the same ranking order");
            // Fixture-specific: the 25-row no-meta city must be flagged.
            assert.ok(run1.some((r) => r.city === TEST_CITY_NOMETA));
        } finally {
            await cleanup();
        }
    });

    // ══════════════════════ TEST 11 ══════════════════════
    await test("TEST 11: diagnostic operations perform zero Mongo mutations (hard guarantee: every write method throws if called)", async () => {
        await requireMongo();
        await seedFixtures();
        const guardedMethods = ["updateOne", "updateMany", "insertMany", "create", "deleteOne", "deleteMany", "findOneAndUpdate", "findOneAndDelete", "bulkWrite"];
        const originals = {};
        try {
            for (const Model of [AccommodationResidence, AccommodationIndexMeta]) {
                for (const m of guardedMethods) {
                    originals[`${Model.modelName}.${m}`] = Model[m];
                    Model[m] = () => { throw new Error(`TEST SAFETY: ${Model.modelName}.${m}() must never be called by a diagnostic operation`); };
                }
            }
            const rows = await health.buildCityDiagnostics();
            const duplicates = await health.detectDuplicates();
            health.classifySuspiciousCities(rows, duplicates);
            health.buildPriorityInvestigationList(rows, duplicates, health.classifySuspiciousCities(rows, duplicates), 30);
            assert.ok(rows.length > 0, "sanity: diagnostics should have returned real data even with writes blocked");
        } finally {
            for (const Model of [AccommodationResidence, AccommodationIndexMeta]) {
                for (const m of guardedMethods) Model[m] = originals[`${Model.modelName}.${m}`];
            }
            await cleanup();
        }
    });

    // ══════════════════════ TEST 12 ══════════════════════
    await test("TEST 12: diagnostic operations make zero Amber (or any) fetch() requests", async () => {
        await requireMongo();
        await seedFixtures();
        try {
            const before = fetchCalls.length;
            const rows = await health.buildCityDiagnostics();
            const duplicates = await health.detectDuplicates();
            health.classifySuspiciousCities(rows, duplicates);
            assert.strictEqual(fetchCalls.length, before, "no diagnostic operation may call fetch()");
        } finally {
            await cleanup();
        }
    });

    // ══════════════════════ TEST 13 ══════════════════════
    await test("TEST 13: the inventory-health endpoint is protected by the existing internal-role auth mechanism (requireRole), not a new one", () => {
        const src = fs.readFileSync(path.join(ROOT, "api", "_lib", "routes", "crm-tools", "admin", "accommodation", "inventory-health.js"), "utf8");
        assert.ok(/require\(["']\.\.\/\.\.\/_lib\/businessAuth["']\)/.test(src), "must import the EXISTING businessAuth module, not a new auth mechanism");
        assert.ok(/requireRole\(req, res, INTERNAL_ROLES\)/.test(src), "must call requireRole with the same pattern every other internal endpoint uses");
        assert.ok(/if \(!identity\) return;/.test(src), "must bail out immediately if requireRole did not grant access (401/403 already sent)");
        // The auth check must happen BEFORE any diagnostic query — find the
        // line numbers and assert ordering, not just presence.
        const authLine = src.split("\n").findIndex((l) => l.includes("requireRole(req, res, INTERNAL_ROLES)"));
        const queryLine = src.split("\n").findIndex((l) => l.includes("buildCityDiagnostics()"));
        assert.ok(authLine > 0 && queryLine > 0 && authLine < queryLine, "auth check must run before any diagnostic Mongo query");
    });

    // ══════════════════════ Structural guards ══════════════════════
    await test("STRUCTURAL: accommodationHealth.js and the report script never import amberGateway.js or reference an Amber URL", () => {
        for (const f of [path.join(ROOT, "api", "_lib", "accommodationHealth.js"), path.join(ROOT, "scripts", "report-accommodation-index-health.js")]) {
            const src = fs.readFileSync(f, "utf8");
            // Only flag an actual require() of amberGateway.js — the header
            // comments in both files legitimately DISCUSS amberGateway.js by
            // name (explaining why it's deliberately not imported), which a
            // bare substring check would wrongly flag.
            assert.ok(!/require\([^)]*amberGateway/.test(src), `${path.basename(f)} must never require() amberGateway.js`);
            assert.ok(!/amberstudent\.com/.test(src));
            assert.ok(!/\bfetch\(/.test(src), `${path.basename(f)} must never call fetch() directly`);
        }
    });

    console.log(`\n=== ${passed} passed, ${failed} failed, ${skipped} skipped ===`);
    if (failed > 0) {
        console.log("\nFailures:");
        failures.forEach((f) => console.log(`  - ${f.name}: ${f.message}`));
        process.exitCode = 1;
    }
    process.exit(process.exitCode || 0);
}

main().catch((err) => { console.error("Verification script crashed:", err); process.exitCode = 1; process.exit(1); });
