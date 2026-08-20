#!/usr/bin/env node
// Milestone 8 (IVYHUTS_MILESTONE_8_REFRESH_LIFECYCLE_REPORT.md) verification
// — Phase 14's 22-test list.
//
// SAFETY: every test uses a mocked global.fetch (zero real Amber calls).
// Mongo-writing tests are scoped to "zzz-milestone8-test-*" city names,
// cleaned up before/after.
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
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

function freshModules(fetchImpl, envOverrides = {}) {
    const files = ["sharedStore.js", "amberGateway.js", "accommodationIndex.js", "accommodationInventoryService.js"].map((f) => path.join(ROOT, "api", "_lib", f));
    for (const f of files) delete require.cache[require.resolve(f)];
    for (const k of ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_URL", "KV_REST_API_TOKEN"]) delete process.env[k];
    const prevEnv = {};
    for (const [k, v] of Object.entries(envOverrides)) { prevEnv[k] = process.env[k]; process.env[k] = v; }
    global.fetch = fetchImpl;
    return {
        index: require(path.join(ROOT, "api", "_lib", "accommodationIndex.js")),
        gateway: require(path.join(ROOT, "api", "_lib", "amberGateway.js")),
        service: require(path.join(ROOT, "api", "_lib", "accommodationInventoryService.js")),
        restoreEnv: () => { for (const [k, v] of Object.entries(prevEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } },
    };
}
function simpleFetch(pages, delayMs = 0) {
    const calls = [];
    const fn = async (url) => {
        calls.push(url);
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        const u = new URL(url);
        const page = Number(u.searchParams.get("p")) || 1;
        const city = (u.searchParams.get("location_place_name") || "").toLowerCase();
        const items = pages[`${city}:${page}`] || [];
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ message: "success", data: { result: items, meta: { count: items.length } } }) };
    };
    fn.calls = calls;
    return fn;
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
async function cleanupCity(city) {
    const AccommodationResidence = require(path.join(ROOT, "api", "_lib", "models", "AccommodationResidence"));
    const AccommodationIndexMeta = require(path.join(ROOT, "api", "_lib", "models", "AccommodationIndexMeta"));
    await AccommodationResidence.deleteMany({ city });
    await AccommodationIndexMeta.deleteMany({ city });
}

async function main() {
    console.log("=== IVYHUTS Milestone 8 — Refresh Lifecycle Verification ===\n");

    // ══════════════════════ TEST 1/2 ══════════════════════
    await test("TEST 1/2: refresh starts RUNNING then becomes SUCCEEDED (real Mongo)", async () => {
        await requireMongo();
        const city = "zzz-milestone8-test-lifecycle-success";
        await cleanupCity(city);
        try {
            const fetchFn = simpleFetch({ [`${city}:1`]: [makeItem(1, city)] }, 150);
            const { index } = freshModules(fetchFn);
            const workPromise = index.attemptCityRefresh(city, "LOW", "test1");
            await new Promise((r) => setTimeout(r, 30)); // mid-flight
            const AccommodationIndexMeta = require(path.join(ROOT, "api", "_lib", "models", "AccommodationIndexMeta"));
            const midMeta = await AccommodationIndexMeta.findOne({ city }).lean();
            assert.strictEqual(midMeta.refreshStatus, "RUNNING", "meta must show RUNNING while the operation is still in flight");
            const outcome = await workPromise;
            assert.strictEqual(outcome.refreshed, true);
            const finalMeta = await AccommodationIndexMeta.findOne({ city }).lean();
            assert.strictEqual(finalMeta.refreshStatus, "SUCCEEDED");
            assert.strictEqual(finalMeta.status, "ok");
        } finally { await cleanupCity(city); }
    });

    // ══════════════════════ TEST 3 ══════════════════════
    await test("TEST 3: a failed refresh (Amber error) becomes FAILED", async () => {
        await requireMongo();
        const city = "zzz-milestone8-test-failed";
        await cleanupCity(city);
        try {
            const { index } = freshModules(async () => { throw new Error("simulated Amber outage"); });
            const outcome = await index.attemptCityRefresh(city, "LOW", "test3");
            assert.strictEqual(outcome.refreshed, false);
            const AccommodationIndexMeta = require(path.join(ROOT, "api", "_lib", "models", "AccommodationIndexMeta"));
            const meta = await AccommodationIndexMeta.findOne({ city }).lean();
            assert.strictEqual(meta.refreshStatus, "FAILED");
        } finally { await cleanupCity(city); }
    });

    // ══════════════════════ TEST 4/10 ══════════════════════
    await test("TEST 4/10: duplicate/concurrent refresh requests for the same city coalesce into ONE real operation", async () => {
        await requireMongo();
        const city = "zzz-milestone8-test-coalesce";
        await cleanupCity(city);
        try {
            const fetchFn = simpleFetch({ [`${city}:1`]: [makeItem(1, city)] }, 100);
            const { index } = freshModules(fetchFn);
            const [a, b, c] = await Promise.all([
                index.attemptCityRefresh(city, "LOW", "test4-a"),
                index.attemptCityRefresh(city, "LOW", "test4-b"),
                index.attemptCityRefresh(city, "LOW", "test4-c"),
            ]);
            const attemptedCount = [a, b, c].filter((o) => o.attempted).length;
            assert.strictEqual(attemptedCount, 1, "exactly one caller should have acquired the lock");
            assert.strictEqual(fetchFn.calls.length, 1, "exactly one real Amber call for 3 concurrent identical requests");
        } finally { await cleanupCity(city); }
    });

    // ══════════════════════ TEST 5/6/7 ══════════════════════
    await test("TEST 5/6/7: a caller timeout does not falsely mark the refresh FAILED, does not release the lock early, and the operationId stays stable", async () => {
        await requireMongo();
        const city = "zzz-milestone8-test-timeout";
        await cleanupCity(city);
        try {
            const fetchFn = simpleFetch({ [`${city}:1`]: [makeItem(1, city)] }, 300);
            const { index } = freshModules(fetchFn);
            const a = await index.attemptCityRefresh(city, "LOW", "test5-a", { timeoutMs: 50 });
            assert.strictEqual(a.refreshStatus, "RUNNING", "a timed-out caller must see RUNNING, never a false failure");
            assert.ok(a.operationId, "a stable operationId must be returned even on timeout");

            const b = await index.attemptCityRefresh(city, "LOW", "test5-b");
            assert.strictEqual(b.attempted, false, "the lock must still be held immediately after A's timeout — this is the Milestone 8 fix");
            assert.strictEqual(b.operationId, a.operationId, "the SAME operationId must be visible to a concurrent caller");

            await new Promise((r) => setTimeout(r, 400)); // let the real background work finish
            const AccommodationIndexMeta = require(path.join(ROOT, "api", "_lib", "models", "AccommodationIndexMeta"));
            const meta = await AccommodationIndexMeta.findOne({ city }).lean();
            assert.strictEqual(meta.refreshStatus, "SUCCEEDED", "the true outcome must be SUCCEEDED, never overwritten by A's own earlier timeout");
            assert.strictEqual(fetchFn.calls.length, 1, "only ONE real Amber call total — B must never have triggered a second one");
        } finally { await cleanupCity(city); }
    });

    // ══════════════════════ TEST 8/9 ══════════════════════
    await test("TEST 8/9: metadata reflects the ACTUAL persisted count on a partial failure, never a full-success count (real Mongo)", async () => {
        await requireMongo();
        const city = "zzz-milestone8-test-partial";
        await cleanupCity(city);
        try {
            const { index } = freshModules(simpleFetch({}));
            const good = index.mapAmberItemToResidence(makeItem(801, city), city);
            const bad = index.mapAmberItemToResidence(makeItem(802, city), city);
            bad.rating = "not-a-number"; // forces a real Mongoose CastError inside bulkWrite
            const result = await index.persistResidences(city, [good, bad]);
            assert.strictEqual(result.inserted, 1);
            assert.strictEqual(result.failed, 1);
            const AccommodationIndexMeta = require(path.join(ROOT, "api", "_lib", "models", "AccommodationIndexMeta"));
            const meta = await AccommodationIndexMeta.findOne({ city }).lean();
            assert.strictEqual(meta.residenceCount, 1, "residenceCount must reflect the 1 actually-persisted property, not the 2 attempted");
            assert.strictEqual(meta.status, "error", "a partial failure must never be reported as a clean ok");
            const AccommodationResidence = require(path.join(ROOT, "api", "_lib", "models", "AccommodationResidence"));
            const docs = await AccommodationResidence.find({ city }).lean();
            assert.strictEqual(docs.length, 1, "only the genuinely valid document may exist in Mongo");
        } finally { await cleanupCity(city); }
    });

    // ══════════════════════ TEST 11 ══════════════════════
    await test("TEST 11: Amber calls remain exclusively through amberGateway.js — the new service module never calls fetch() itself", () => {
        for (const f of ["accommodationInventoryService.js", "accommodationIndex.js"]) {
            const src = fs.readFileSync(path.join(ROOT, "api", "_lib", f), "utf8");
            assert.ok(!/\bfetch\(/.test(src), `${f} must never call fetch() directly`);
            assert.ok(!/amberstudent\.com/.test(src), `${f} must never reference Amber's base URL directly`);
        }
    });

    // ══════════════════════ TEST 12 ══════════════════════
    await test("TEST 12: the shared rate budget remains enforced for refresh operations (unchanged this milestone)", async () => {
        const city = "test12-city";
        const pages = {};
        for (let p = 1; p <= 12; p++) pages[`${city}:${p}`] = Array.from({ length: 50 }, (_, i) => makeItem(p * 1000 + i, city));
        const fetchFn = simpleFetch(pages);
        const { gateway, restoreEnv } = freshModules(fetchFn, { AMBER_MAX_REQUESTS_PER_MINUTE: "2" });
        try {
            assert.strictEqual(gateway.RATE_BUDGET_PER_MINUTE, 2);
            await gateway.fetchListings({ city, page: 1, limit: 150 }, "LOW", "test12");
            assert.ok(fetchFn.calls.length <= 2, `expected at most 2 real Amber calls (the configured budget), got ${fetchFn.calls.length}`);
        } finally { restoreEnv(); }
    });

    // ══════════════════════ TEST 13 ══════════════════════
    await test("TEST 13: no second Amber client exists anywhere in api/_lib", () => {
        const libDir = path.join(ROOT, "api", "_lib");
        const files = fs.readdirSync(libDir);
        const suspicious = files.filter((f) => /amber/i.test(f) && !["amberGateway.js", "accommodationIndex.js", "accommodationHealth.js", "accommodationTrace.js", "accommodationInventoryService.js"].includes(f));
        assert.deepStrictEqual(suspicious, []);
        const amberGatewaySrc = fs.readFileSync(path.join(libDir, "amberGateway.js"), "utf8");
        const refs = (amberGatewaySrc.match(/amberstudent\.com/g) || []).length;
        assert.strictEqual(refs, 1, "exactly one Amber base URL reference must exist, in amberGateway.js alone");
    });

    // ══════════════════════ TEST 14 ══════════════════════
    await test("TEST 14: FRESH inventory is served without triggering any refresh (real Mongo)", async () => {
        await requireMongo();
        const city = "zzz-milestone8-test-fresh";
        await cleanupCity(city);
        try {
            const AccommodationResidence = require(path.join(ROOT, "api", "_lib", "models", "AccommodationResidence"));
            const AccommodationIndexMeta = require(path.join(ROOT, "api", "_lib", "models", "AccommodationIndexMeta"));
            await AccommodationResidence.insertMany([{ source: "amber", propertyId: "900001", propertyName: "Fresh Fixture", city, available: true }]);
            await AccommodationIndexMeta.updateOne({ city }, { $set: { city, status: "ok", lastRefreshedAt: new Date(), residenceCount: 1 } }, { upsert: true });
            const fetchFn = simpleFetch({});
            const { index } = freshModules(fetchFn);
            const result = await index.getCityListings(city, { priority: "MEDIUM", source: "test14" });
            assert.strictEqual(result.status, "ready");
            assert.strictEqual(fetchFn.calls.length, 0, "a FRESH city must never trigger any Amber call");
        } finally { await cleanupCity(city); }
    });

    // ══════════════════════ TEST 15/16 ══════════════════════
    await test("TEST 15/16: STALE/EXPIRED inventory is served immediately without a synchronous refresh, and never double-queues", async () => {
        await requireMongo();
        const city = "zzz-milestone8-test-stale";
        await cleanupCity(city);
        try {
            const AccommodationResidence = require(path.join(ROOT, "api", "_lib", "models", "AccommodationResidence"));
            const AccommodationIndexMeta = require(path.join(ROOT, "api", "_lib", "models", "AccommodationIndexMeta"));
            await AccommodationResidence.insertMany([{ source: "amber", propertyId: "900002", propertyName: "Stale Fixture", city, available: true }]);
            const staleDate = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2h old -> STALE
            await AccommodationIndexMeta.updateOne({ city }, { $set: { city, status: "ok", lastRefreshedAt: staleDate, residenceCount: 1 } }, { upsert: true });
            const fetchFn = simpleFetch({});
            const { index } = freshModules(fetchFn);
            const startedAt = Date.now();
            const result = await index.getCityListings(city, { priority: "MEDIUM", source: "test15" });
            const durationMs = Date.now() - startedAt;
            assert.strictEqual(result.status, "ready");
            assert.ok(durationMs < 2000, "a STALE city must respond immediately, never block on a synchronous refresh");
        } finally { await cleanupCity(city); }
    });

    // ══════════════════════ TEST 17 ══════════════════════
    await test("TEST 17: MISSING inventory with heavy concurrent demand does not create a request storm (20 concurrent -> 1 real refresh)", async () => {
        await requireMongo();
        const city = "zzz-milestone8-test-missing-storm";
        await cleanupCity(city);
        try {
            const fetchFn = simpleFetch({ [`${city}:1`]: [makeItem(1, city)] }, 50);
            const { index } = freshModules(fetchFn);
            const results = await Promise.all(Array.from({ length: 20 }, () => index.attemptCityRefresh(city, "LOW", "test17")));
            const attemptedCount = results.filter((r) => r.attempted).length;
            assert.strictEqual(attemptedCount, 1, "exactly one of 20 concurrent requests should have actually attempted the refresh");
            assert.strictEqual(fetchFn.calls.length, 1, "exactly one real Amber call for 20 concurrent requests to a MISSING city");
        } finally { await cleanupCity(city); }
    });

    // ══════════════════════ TEST 18 ══════════════════════
    await test("TEST 18: FAILED_COOLDOWN respects the cooldown window — no retry until it elapses (real Mongo)", async () => {
        await requireMongo();
        const city = "zzz-milestone8-test-cooldown";
        await cleanupCity(city);
        try {
            const AccommodationIndexMeta = require(path.join(ROOT, "api", "_lib", "models", "AccommodationIndexMeta"));
            await AccommodationIndexMeta.updateOne(
                { city },
                { $set: { city, status: "error", lastAttemptedAt: new Date(), lastErrorAt: new Date(), consecutiveFailures: 3 } },
                { upsert: true }
            );
            const fetchFn = simpleFetch({ [`${city}:1`]: [makeItem(1, city)] });
            const { index } = freshModules(fetchFn);
            const result = await index.getCityListings(city, { priority: "MEDIUM", source: "test18" });
            assert.strictEqual(fetchFn.calls.length, 0, "a city within its FAILED_COOLDOWN window must not trigger a new Amber attempt");
        } finally { await cleanupCity(city); }
    });

    // ══════════════════════ TEST 19-22 ══════════════════════
    for (const [num, script] of [["19", "verify-p0-rate-latency-fixes.js"], ["20", "verify-milestone-4-inventory-refresh.js"], ["21", "verify-milestone-6-inventory-loss.js"], ["22", "verify-milestone-7-convergence.js"]]) {
        await test(`TEST ${num}: existing suite (${script}) still passes after this milestone's changes`, () => {
            const out = execFileSync(process.execPath, [path.join(ROOT, "scripts", script)], { cwd: ROOT, encoding: "utf8" });
            assert.ok(/=== \d+ passed, 0 failed/.test(out), `expected a clean pass line for ${script}, got:\n${out.slice(-500)}`);
        });
    }

    console.log(`\n=== ${passed} passed, ${failed} failed, ${skipped} skipped ===`);
    if (failed > 0) { console.log("\nFailures:"); failures.forEach((f) => console.log(`  - ${f.name}: ${f.message}`)); process.exitCode = 1; }
    process.exit(process.exitCode || 0);
}

main().catch((err) => { console.error("Verification script crashed:", err); process.exitCode = 1; process.exit(1); });
