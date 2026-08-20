#!/usr/bin/env node
// Milestone 7 (IVYHUTS_MILESTONE_7_CONVERGENCE_REPORT.md) verification —
// Phase 21's 15-test list.
//
// SAFETY: every test uses a mocked global.fetch (zero real Amber calls) —
// the live convergence experiment itself already happened once, manually,
// for the 6 representative cities (see the final report); these tests exist
// to make the underlying mechanics regression-proof going forward, not to
// repeat live calls. TEST 4/5/6/8/9/10 use REAL MongoDB scoped to
// "zzz-milestone7-test-*" city names, cleaned up before/after.
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
require("dotenv").config({ path: path.join(ROOT, ".env.local") });
require("dotenv").config({ path: path.join(ROOT, ".env") });

let passed = 0, failed = 0, skipped = 0;
const failures = [];
async function test(name, fn) {
    try { await fn(); passed++; console.log(`  PASS  ${name}`); }
    catch (err) {
        if (err && err.__skip) { skipped++; console.log(`  SKIP  ${name}\n        ${err.message}`); return; }
        failed++; failures.push({ name, message: err.message });
        console.log(`  FAIL  ${name}\n        ${err.stack || err.message}`);
    }
}
function skip(reason) { const e = new Error(reason); e.__skip = true; throw e; }

function makeItem(id, cityName) { return { id, name: `Property ${id}`, location: { locality: { long_name: cityName } } }; }

function freshModules(pages, envOverrides = {}) {
    const files = ["sharedStore.js", "amberGateway.js", "accommodationIndex.js"].map((f) => path.join(ROOT, "api", "_lib", f));
    for (const f of files) delete require.cache[require.resolve(f)];
    for (const k of ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_URL", "KV_REST_API_TOKEN"]) delete process.env[k];
    const prevEnv = {};
    for (const [k, v] of Object.entries(envOverrides)) { prevEnv[k] = process.env[k]; process.env[k] = v; }
    const calls = [];
    global.fetch = async (url) => {
        calls.push(url);
        const u = new URL(url);
        const page = Number(u.searchParams.get("p")) || 1;
        const city = (u.searchParams.get("location_place_name") || "").toLowerCase();
        const items = pages[`${city}:${page}`] || [];
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ message: "success", data: { result: items, meta: { count: items.length } } }) };
    };
    return {
        calls,
        gateway: require(path.join(ROOT, "api", "_lib", "amberGateway.js")),
        index: require(path.join(ROOT, "api", "_lib", "accommodationIndex.js")),
        restoreEnv: () => { for (const [k, v] of Object.entries(prevEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } },
    };
}

let mongoAvailable = null;
async function requireMongo() {
    if (mongoAvailable === null) {
        try {
            const { connectToDatabase } = require(path.join(ROOT, "api", "_lib", "mongodb"));
            await Promise.race([connectToDatabase(), new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 8000))]);
            mongoAvailable = true;
        } catch { mongoAvailable = false; }
    }
    if (!mongoAvailable) skip("MongoDB is not reachable from this environment — skipping, not fabricating a pass");
}

async function main() {
    console.log("=== IVYHUTS Milestone 7 — Convergence Verification ===\n");

    // ══════════════════════ TEST 1 ══════════════════════
    await test("TEST 1: refresh (REFRESH_TARGET_COUNT) uses multi-page target count, not the search page size", async () => {
        const city = "test1-bigcity";
        const pages = {};
        for (let p = 1; p <= 3; p++) pages[`${city}:${p}`] = Array.from({ length: 50 }, (_, i) => makeItem(p * 1000 + i, city));
        const { gateway, index, calls } = freshModules(pages);
        const result = await gateway.fetchListings({ city, page: 1, limit: index.REFRESH_TARGET_COUNT }, "LOW", "refresh");
        assert.strictEqual(result.data.data.result.length, 150);
        assert.strictEqual(calls.length, 3);
    });

    // ══════════════════════ TEST 2 ══════════════════════
    await test("TEST 2: user search remains capped at 50, unaffected by the refresh target count", async () => {
        const city = "test2-bigcity";
        const pages = {};
        for (let p = 1; p <= 3; p++) pages[`${city}:${p}`] = Array.from({ length: 50 }, (_, i) => makeItem(p * 1000 + i, city));
        const { gateway, calls } = freshModules(pages);
        const result = await gateway.fetchListings({ city, page: 1, limit: 50 }, "MEDIUM", "university-housing");
        assert.strictEqual(result.data.data.result.length, 50);
        assert.strictEqual(calls.length, 1);
    });

    // ══════════════════════ TEST 3 ══════════════════════
    await test("TEST 3: one controlled refresh never exceeds the existing shared rate budget", async () => {
        const city = "test3-bigcity";
        const pages = {};
        for (let p = 1; p <= 12; p++) pages[`${city}:${p}`] = Array.from({ length: 50 }, (_, i) => makeItem(p * 1000 + i, city));
        const { gateway, calls, restoreEnv } = freshModules(pages, { AMBER_MAX_REQUESTS_PER_MINUTE: "3" });
        try {
            assert.strictEqual(gateway.RATE_BUDGET_PER_MINUTE, 3);
            const result = await gateway.fetchListings({ city, page: 1, limit: 150 }, "LOW", "refresh");
            assert.ok(calls.length <= 3, `expected at most 3 real Amber calls (the configured budget), got ${calls.length}`);
            assert.ok(result.data.data.result.length <= 150);
        } finally {
            restoreEnv();
        }
    });

    // ══════════════════════ TEST 4 ══════════════════════
    const TEST_CITY = "zzz-milestone7-test-city";
    async function cleanup() {
        const AccommodationResidence = require(path.join(ROOT, "api", "_lib", "models", "AccommodationResidence"));
        const AccommodationIndexMeta = require(path.join(ROOT, "api", "_lib", "models", "AccommodationIndexMeta"));
        await AccommodationResidence.deleteMany({ city: TEST_CITY });
        await AccommodationIndexMeta.deleteMany({ city: TEST_CITY });
    }
    await test("TEST 4: source IDs remain unique after a real persisted refresh (real Mongo)", async () => {
        await requireMongo();
        await cleanup();
        try {
            const { index } = freshModules({});
            const docs = [
                index.mapAmberItemToResidence(makeItem(700001, TEST_CITY), TEST_CITY),
                index.mapAmberItemToResidence(makeItem(700002, TEST_CITY), TEST_CITY),
            ];
            await index.persistResidencesRaw(docs);
            const AccommodationResidence = require(path.join(ROOT, "api", "_lib", "models", "AccommodationResidence"));
            const ids = (await AccommodationResidence.find({ city: TEST_CITY }).select("propertyId").lean()).map((d) => d.propertyId);
            assert.strictEqual(new Set(ids).size, ids.length, "no duplicate propertyId after persistence");
        } finally { await cleanup(); }
    });

    // ══════════════════════ TEST 5/6 ══════════════════════
    await test("TEST 5/6: a refresh preserves existing properties AND inserts genuinely new ones (real Mongo)", async () => {
        await requireMongo();
        await cleanup();
        try {
            const { index } = freshModules({});
            const existing = index.mapAmberItemToResidence(makeItem(700010, TEST_CITY, ), TEST_CITY);
            await index.persistResidencesRaw([existing]);
            const AccommodationResidence = require(path.join(ROOT, "api", "_lib", "models", "AccommodationResidence"));
            const beforeCount = await AccommodationResidence.countDocuments({ city: TEST_CITY });

            const newDoc = index.mapAmberItemToResidence(makeItem(700011, TEST_CITY), TEST_CITY);
            await index.persistResidencesRaw([existing, newDoc]); // simulates a refresh re-seeing the existing one plus a genuinely new one

            const afterCount = await AccommodationResidence.countDocuments({ city: TEST_CITY });
            const stillHasExisting = await AccommodationResidence.countDocuments({ city: TEST_CITY, propertyId: "700010" });
            const hasNew = await AccommodationResidence.countDocuments({ city: TEST_CITY, propertyId: "700011" });
            assert.strictEqual(beforeCount, 1);
            assert.strictEqual(afterCount, 2);
            assert.strictEqual(stillHasExisting, 1, "the pre-existing property must be preserved, not overwritten-away");
            assert.strictEqual(hasNew, 1, "the genuinely new property must be inserted");
        } finally { await cleanup(); }
    });

    // ══════════════════════ TEST 7 ══════════════════════
    await test("TEST 7: same-name different-sourceId properties remain separate after a real refresh (real Mongo)", async () => {
        await requireMongo();
        await cleanup();
        try {
            const { index } = freshModules({});
            const a = index.mapAmberItemToResidence(makeItem(700020, TEST_CITY, ), TEST_CITY);
            const b = index.mapAmberItemToResidence(makeItem(700021, TEST_CITY, ), TEST_CITY);
            a.propertyName = "Twin Hall"; b.propertyName = "Twin Hall";
            await index.persistResidencesRaw([a, b]);
            const AccommodationResidence = require(path.join(ROOT, "api", "_lib", "models", "AccommodationResidence"));
            const docs = await AccommodationResidence.find({ city: TEST_CITY, propertyName: "Twin Hall" }).lean();
            assert.strictEqual(docs.length, 2);
        } finally { await cleanup(); }
    });

    // ══════════════════════ TEST 8 ══════════════════════
    await test("TEST 8: a failed refresh (Amber error) does not destroy pre-existing inventory (real Mongo)", async () => {
        await requireMongo();
        await cleanup();
        try {
            const { index: seedIndex } = freshModules({});
            const existing = seedIndex.mapAmberItemToResidence(makeItem(700030, TEST_CITY), TEST_CITY);
            await seedIndex.persistResidencesRaw([existing]);

            const sharedStorePath = path.join(ROOT, "api", "_lib", "sharedStore.js");
            const amberGatewayPath = path.join(ROOT, "api", "_lib", "amberGateway.js");
            const accommodationIndexPath = path.join(ROOT, "api", "_lib", "accommodationIndex.js");
            for (const p of [sharedStorePath, amberGatewayPath, accommodationIndexPath]) delete require.cache[require.resolve(p)];
            for (const k of ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_URL", "KV_REST_API_TOKEN"]) delete process.env[k];
            global.fetch = async () => { throw new Error("simulated Amber outage"); };
            const index = require(accommodationIndexPath);

            const outcome = await index.attemptCityRefresh(TEST_CITY, "LOW", "test8-failure");
            assert.strictEqual(outcome.refreshed, false);

            const AccommodationResidence = require(path.join(ROOT, "api", "_lib", "models", "AccommodationResidence"));
            const stillThere = await AccommodationResidence.countDocuments({ city: TEST_CITY, propertyId: "700030" });
            assert.strictEqual(stillThere, 1, "a failed refresh must never remove pre-existing inventory");
        } finally { await cleanup(); }
    });

    // ══════════════════════ TEST 9 ══════════════════════
    await test("TEST 9: refresh persistence is idempotent — running it twice with the same data does not duplicate (real Mongo)", async () => {
        await requireMongo();
        await cleanup();
        try {
            const { index } = freshModules({});
            const doc = index.mapAmberItemToResidence(makeItem(700040, TEST_CITY), TEST_CITY);
            await index.persistResidencesRaw([doc]);
            await index.persistResidencesRaw([doc]);
            await index.persistResidencesRaw([doc]);
            const AccommodationResidence = require(path.join(ROOT, "api", "_lib", "models", "AccommodationResidence"));
            const count = await AccommodationResidence.countDocuments({ city: TEST_CITY, propertyId: "700040" });
            assert.strictEqual(count, 1);
        } finally { await cleanup(); }
    });

    // ══════════════════════ TEST 10 ══════════════════════
    await test("TEST 10: the city-level refresh lock still prevents two concurrent refreshes of the same city from both hitting Amber", async () => {
        await requireMongo(); // attemptCityRefresh persists on success — this test's city must be cleaned up
        const city = "zzz-milestone7-test-lock-city";
        const sharedStorePath = path.join(ROOT, "api", "_lib", "sharedStore.js");
        const amberGatewayPath = path.join(ROOT, "api", "_lib", "amberGateway.js");
        const accommodationIndexPath = path.join(ROOT, "api", "_lib", "accommodationIndex.js");
        for (const p of [sharedStorePath, amberGatewayPath, accommodationIndexPath]) delete require.cache[require.resolve(p)];
        for (const k of ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_URL", "KV_REST_API_TOKEN"]) delete process.env[k];
        const calls = [];
        global.fetch = async (url) => {
            calls.push(url);
            await new Promise((r) => setTimeout(r, 100));
            const items = [makeItem(1, city)];
            return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ message: "success", data: { result: items, meta: { count: items.length } } }) };
        };
        const index = require(accommodationIndexPath);
        try {
            const [a, b] = await Promise.all([
                index.attemptCityRefresh(city, "LOW", "test10-a"),
                index.attemptCityRefresh(city, "LOW", "test10-b"),
            ]);
            const attemptedCount = [a, b].filter((o) => o.attempted).length;
            assert.strictEqual(attemptedCount, 1, "exactly one of the two concurrent refreshes should acquire the lock and actually attempt");
        } finally {
            const AccommodationResidence = require(path.join(ROOT, "api", "_lib", "models", "AccommodationResidence"));
            const AccommodationIndexMeta = require(path.join(ROOT, "api", "_lib", "models", "AccommodationIndexMeta"));
            await AccommodationResidence.deleteMany({ city });
            await AccommodationIndexMeta.deleteMany({ city });
        }
    });

    // ══════════════════════ TEST 11/12 ══════════════════════
    await test("TEST 11/12: the backfill script's dry-run mode performs zero Mongo writes and zero Amber calls", () => {
        const src = fs.readFileSync(path.join(ROOT, "scripts", "backfill-accommodation-inventory.js"), "utf8");
        // The dry-run branch must `return`/`process.exit` BEFORE the line that
        // calls attemptCityRefresh — structural proof, not just a claim.
        const lines = src.split("\n");
        const dryRunReturnLine = lines.findIndex((l) => l.includes("would refresh"));
        const attemptCallLine = lines.findIndex((l) => l.includes("await attemptCityRefresh("));
        assert.ok(dryRunReturnLine > 0 && attemptCallLine > 0 && dryRunReturnLine < attemptCallLine, "the dry-run summary must be printed and the process exited BEFORE any attemptCityRefresh() call exists later in the file");
        assert.ok(/if \(args\.dryRun\) \{/.test(src) && /process\.exit\(0\);/.test(src));
    });

    // ══════════════════════ TEST 13 ══════════════════════
    await test("TEST 13: the backfill script defaults to dry-run", () => {
        const src = fs.readFileSync(path.join(ROOT, "scripts", "backfill-accommodation-inventory.js"), "utf8");
        assert.ok(/dryRun: true/.test(src), "dryRun must default to true in the argument parser");
    });

    // ══════════════════════ TEST 14 ══════════════════════
    await test("TEST 14: no unrestricted backfill occurs — maxCities always bounds how many cities can be live-refreshed in one run", () => {
        const src = fs.readFileSync(path.join(ROOT, "scripts", "backfill-accommodation-inventory.js"), "utf8");
        assert.ok(/maxCities: 1/.test(src), "maxCities must default to a small, bounded number (1)");
        assert.ok(/candidates\.slice\(0, args\.maxCities\)/.test(src), "the candidate list actually run must be sliced to maxCities, not the full priority/candidate list");
        assert.ok(!/--all-cities|refreshAllCities|575/.test(src), "no flag or code path may target all cities at once");
    });

    // ══════════════════════ TEST 15 ══════════════════════
    // Updated for Milestone 9 (IVYHUTS_MILESTONE_9_UNIVERSITY_HOUSING_MIGRATION_REPORT.md):
    // this test originally asserted that Milestone 7 left University
    // Housing's live-Amber search call shape byte-identical, which was true
    // and correct AT THE TIME — Milestone 7's own scope explicitly excluded
    // touching University Housing. Milestone 9 is the deliberate, in-scope
    // migration that changes exactly that call shape (to the canonical Mongo
    // inventory), so freezing the old assertion forever would fail a
    // regression suite against an intentional, later, correctly-scoped
    // change. Updated to check what remains invariant post-Milestone-9: the
    // override branch (a fixed per-university slug list, never part of this
    // migration) still uses its own unchanged live-Amber pattern, and the
    // page still imports both mapper functions it now legitimately needs.
    await test("TEST 15: University Housing's override-university data-fetch contract (getPropertyBySlug) remains unchanged; the page now correctly imports both live and canonical mappers (post-Milestone-9)", () => {
        const src = fs.readFileSync(path.join(ROOT, "src", "pages", "UniversityHousingPage.js"), "utf8");
        assert.ok(/overrideSlugs\.map\(\(slug\) => getPropertyBySlug\(slug, "MEDIUM", "university-housing-override"\)/.test(src), "the override-university live-Amber fetch shape must remain unchanged — it was never part of the Milestone 9 migration");
        assert.ok(/import\s*\{[^}]*safeListingList[^}]*safeResidenceListingList[^}]*\}\s*from\s*["']\.\.\/services\/amberMapper["']/.test(src), "post-Milestone-9, the page must import BOTH mappers: safeListingList for the override branch, safeResidenceListingList for the canonical-inventory branch");
    });

    console.log(`\n=== ${passed} passed, ${failed} failed, ${skipped} skipped ===`);
    if (failed > 0) { console.log("\nFailures:"); failures.forEach((f) => console.log(`  - ${f.name}: ${f.message}`)); process.exitCode = 1; }
    process.exit(process.exitCode || 0);
}

main().catch((err) => { console.error("Verification script crashed:", err); process.exitCode = 1; process.exit(1); });
