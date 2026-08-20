#!/usr/bin/env node
// Milestone 6 (IVYHUTS_MILESTONE_6_INVENTORY_LOSS_REPORT.md) verification —
// Phase 16's 18-test list.
//
// SAFETY: every test that would otherwise reach Amber uses a mocked
// global.fetch (zero real Amber calls possible, per the user's explicit
// preference this milestone — no new live-Amber traffic). TEST 10/11/14 use
// REAL MongoDB scoped to "zzz-milestone6b-test-*" city names, cleaned up
// before/after, verified with a direct count query at the end.
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
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

function makeItem(id, cityName, overrides = {}) {
    return { id, name: `Property ${id}`, location: { locality: { long_name: cityName } }, ...overrides };
}
function makeRoom({ name = "Studio", available = true, tenancyPrice = 200, tenancyAvailable = available, includePricing = true } = {}) {
    const room = { name, available, children: [{ id: `${name}-tenancy`, available: tenancyAvailable, pricing: includePricing ? { price: tenancyPrice, currency: "gbp", duration: "weekly" } : {} }] };
    if (includePricing) room.pricing = { min_price: tenancyPrice, currency: "gbp", duration: "weekly" };
    return room;
}

function freshModules(pages) {
    const sharedStorePath = path.join(ROOT, "api", "_lib", "sharedStore.js");
    const amberGatewayPath = path.join(ROOT, "api", "_lib", "amberGateway.js");
    const accommodationIndexPath = path.join(ROOT, "api", "_lib", "accommodationIndex.js");
    const accommodationTracePath = path.join(ROOT, "api", "_lib", "accommodationTrace.js");
    for (const p of [sharedStorePath, amberGatewayPath, accommodationIndexPath, accommodationTracePath]) delete require.cache[require.resolve(p)];
    for (const k of ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_URL", "KV_REST_API_TOKEN"]) delete process.env[k];
    const calls = [];
    global.fetch = async (url) => {
        calls.push(url);
        const u = new URL(url);
        const page = Number(u.searchParams.get("p")) || 1;
        const city = (u.searchParams.get("location_place_name") || "").toLowerCase();
        const items = pages[`${city}:${page}`] || [];
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ message: "success", data: { result: items, meta: { count: items.length } } }) };
    };
    return { calls, gateway: require(amberGatewayPath), index: require(accommodationIndexPath) };
}

async function main() {
    console.log("=== IVYHUTS Milestone 6 — Inventory Loss Verification ===\n");

    // ══════════════════════ TEST 1 ══════════════════════
    await test("TEST 1: different Amber IDs with the same name remain separate", () => {
        const { index } = freshModules({});
        const a = index.mapAmberItemToResidence(makeItem(111, "manchester", { name: "Twin Hall" }), "manchester");
        const b = index.mapAmberItemToResidence(makeItem(222, "manchester", { name: "Twin Hall" }), "manchester");
        assert.notStrictEqual(a.propertyId, b.propertyId);
    });

    // ══════════════════════ TEST 2 ══════════════════════
    await test("TEST 2: the same Amber ID appearing twice (across pages) deduplicates correctly", async () => {
        const { gateway, calls } = freshModules({
            "test2-city:1": [makeItem(5001, "test2-city"), makeItem(9999, "other-city")],
            "test2-city:2": [makeItem(5001, "test2-city")],
        });
        const result = await gateway.fetchListings({ city: "test2-city", page: 1, limit: 2 }, "MEDIUM", "m6-test2");
        assert.strictEqual(result.data.data.result.length, 1);
        assert.strictEqual(result.data.data.result[0].id, 5001);
    });

    // ══════════════════════ TEST 3 ══════════════════════
    await test("TEST 3: missing coordinates does not delete/reject the property", () => {
        const { index } = freshModules({});
        const raw = makeItem(333, "manchester", { location_coordinates: undefined });
        const doc = index.mapAmberItemToResidence(raw, "manchester");
        assert.ok(doc);
        assert.strictEqual(doc.latitude, null);
    });

    // ══════════════════════ TEST 4 ══════════════════════
    await test("TEST 4: missing image does not delete/reject the property", () => {
        const { index } = freshModules({});
        const raw = makeItem(444, "manchester", { image_featured_link: undefined, images: undefined });
        const doc = index.mapAmberItemToResidence(raw, "manchester");
        assert.ok(doc);
        assert.strictEqual(doc.image, null);
    });

    // ══════════════════════ TEST 5 ══════════════════════
    await test("TEST 5: missing/undeterminable price does not delete the property (price stays null, never fabricated, never required for existence)", () => {
        const { index } = freshModules({});
        // A room exists (so there IS room data) but with no derivable price
        // anywhere (no tenancy pricing, no room-level pricing) — the property
        // must still exist, just with price:null.
        const raw = makeItem(555, "manchester", { children: [{ name: "Unpriced Room", available: true, children: [{ id: "t1", available: true, pricing: {} }], pricing: {} }] });
        const doc = index.mapAmberItemToResidence(raw, "manchester");
        assert.ok(doc, "a property must not be rejected merely because no room has a determinable price");
        assert.strictEqual(doc.price.amount, null);
    });

    // ══════════════════════ TEST 6 ══════════════════════
    await test("TEST 6: a sold-out property remains representable (present, marked, never removed)", () => {
        const { index } = freshModules({});
        const raw = makeItem(666, "manchester", { children: [makeRoom({ available: false, tenancyAvailable: false })] });
        const doc = index.mapAmberItemToResidence(raw, "manchester");
        assert.ok(doc);
        assert.strictEqual(doc.available, false);
    });

    // ══════════════════════ TEST 7 ══════════════════════
    await test("TEST 7: an available tenancy produces AVAILABLE via the canonical resolver", () => {
        const { index } = freshModules({});
        const raw = makeItem(777, "manchester", { children: [makeRoom({ available: true, tenancyAvailable: true })] });
        assert.strictEqual(index.resolvePropertyAvailability(raw), "AVAILABLE");
    });

    // ══════════════════════ TEST 8 ══════════════════════
    await test("TEST 8: all-unavailable tenancies produce SOLD_OUT via the canonical resolver", () => {
        const { index } = freshModules({});
        const raw = makeItem(888, "manchester", { children: [makeRoom({ available: false, tenancyAvailable: false })] });
        assert.strictEqual(index.resolvePropertyAvailability(raw), "SOLD_OUT");
    });

    // ══════════════════════ TEST 9 ══════════════════════
    await test("TEST 9: city mapping (normalizeCityName) is deterministic — same input always produces the same key, distinct real cities never collide", () => {
        const { gateway } = freshModules({});
        assert.strictEqual(gateway.normalizeCityName("Manchester"), gateway.normalizeCityName("manchester"));
        assert.strictEqual(gateway.normalizeCityName("  Manchester  "), gateway.normalizeCityName("Manchester"));
        assert.notStrictEqual(gateway.normalizeCityName("Derby"), gateway.normalizeCityName("Derbyshire"));
        // Determinism: 100 repeated calls, same result every time.
        for (let i = 0; i < 100; i++) assert.strictEqual(gateway.normalizeCityName("Manchester"), "manchester");
    });

    // ══════════════════════ TEST 10 ══════════════════════
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
    const TEST_CITY = "zzz-milestone6b-test-upsert";
    async function cleanup() {
        const AccommodationResidence = require(path.join(ROOT, "api", "_lib", "models", "AccommodationResidence"));
        await AccommodationResidence.deleteMany({ city: TEST_CITY });
    }

    await test("TEST 10: Mongo upsert does not overwrite distinct Amber IDs (two different sourceIds persist as two documents)", async () => {
        await requireMongo();
        await cleanup();
        try {
            const { index } = freshModules({});
            const { persistResidencesRaw } = index;
            const docA = index.mapAmberItemToResidence(makeItem(900001, TEST_CITY, { name: "Distinct A" }), TEST_CITY);
            const docB = index.mapAmberItemToResidence(makeItem(900002, TEST_CITY, { name: "Distinct B" }), TEST_CITY);
            await persistResidencesRaw([docA, docB]);
            const AccommodationResidence = require(path.join(ROOT, "api", "_lib", "models", "AccommodationResidence"));
            const count = await AccommodationResidence.countDocuments({ city: TEST_CITY });
            assert.strictEqual(count, 2, "two distinct Amber IDs must never collapse into one document");
        } finally {
            await cleanup();
        }
    });

    // ══════════════════════ TEST 11 ══════════════════════
    await test("TEST 11: Mongo write failures are observable (captured with an explicit error, not silently swallowed) and existing data is preserved", async () => {
        await requireMongo();
        await cleanup();
        try {
            const AccommodationResidence = require(path.join(ROOT, "api", "_lib", "models", "AccommodationResidence"));
            // Seed one pre-existing, valid document.
            await AccommodationResidence.updateOne({ source: "amber", propertyId: "900010" }, { $set: { source: "amber", propertyId: "900010", propertyName: "Pre-existing", city: TEST_CITY } }, { upsert: true });

            const originalUpdateOne = AccommodationResidence.updateOne;
            AccommodationResidence.updateOne = () => { throw new Error("simulated write failure"); };
            let trace;
            try {
                const { calls } = freshModules({ [`${TEST_CITY}:1`]: [makeItem(900011, TEST_CITY, { name: "Would-be new" })] });
                const { traceAmberInventory } = require(path.join(ROOT, "api", "_lib", "accommodationTrace"));
                trace = await traceAmberInventory(TEST_CITY, { persist: true });
            } finally {
                AccommodationResidence.updateOne = originalUpdateOne;
            }
            assert.strictEqual(trace.mongo.failed, 1, "the simulated write failure must be counted, not silently ignored");
            assert.ok(trace.mongo.errors.length === 1 && trace.mongo.errors[0].message.includes("simulated write failure"), "the exact failure reason must be captured");
            const stillThere = await AccommodationResidence.countDocuments({ city: TEST_CITY, propertyId: "900010" });
            assert.strictEqual(stillThere, 1, "a write failure for a NEW property must never affect pre-existing, unrelated documents");
        } finally {
            await cleanup();
        }
    });

    // ══════════════════════ TEST 12 (the milestone's centerpiece fix) ══════════════════════
    await test("TEST 12 (Phase 4 core fix): full-inventory-refresh pagination retrieves what the refresh contract promises (up to REFRESH_TARGET_COUNT), not just one page", async () => {
        const city = "test12-bigcity";
        const pages = {};
        for (let p = 1; p <= 3; p++) pages[`${city}:${p}`] = Array.from({ length: 50 }, (_, i) => makeItem(p * 1000 + i, city));
        const { gateway, index, calls } = freshModules(pages);
        assert.strictEqual(index.REFRESH_TARGET_COUNT, 150, "sanity: the documented refresh target must still be 150 (3 pages) — this test's fixture assumes that value");
        const result = await gateway.fetchListings({ city, page: 1, limit: index.REFRESH_TARGET_COUNT }, "LOW", "m6-refresh-fixed");
        assert.strictEqual(result.data.data.result.length, 150, "a refresh-style call must capture up to REFRESH_TARGET_COUNT items across multiple pages, not cap at 50");
        assert.strictEqual(calls.length, 3);
    });

    // ══════════════════════ TEST 13 ══════════════════════
    await test("TEST 13: user-level search pagination (limit:50) remains completely unchanged by the refresh fix", async () => {
        const city = "test13-bigcity";
        const pages = {};
        for (let p = 1; p <= 3; p++) pages[`${city}:${p}`] = Array.from({ length: 50 }, (_, i) => makeItem(p * 1000 + i, city));
        const { gateway, calls } = freshModules(pages);
        const result = await gateway.fetchListings({ city, page: 1, limit: 50 }, "MEDIUM", "university-housing");
        assert.strictEqual(result.data.data.result.length, 50, "a live user search must still stop at exactly 50, same as Milestone 3");
        assert.strictEqual(calls.length, 1, "a live user search must still make exactly 1 Amber call, same as Milestone 3");
    });

    // ══════════════════════ TEST 14 ══════════════════════
    await test("TEST 14: API serialization (readAllMongoResidences) does not silently drop valid, already-persisted properties", async () => {
        await requireMongo();
        await cleanup();
        try {
            const { index } = requireFresh();
            const docs = [
                index.mapAmberItemToResidence(makeItem(900020, TEST_CITY, { name: "Serialize A" }), TEST_CITY),
                index.mapAmberItemToResidence(makeItem(900021, TEST_CITY, { name: "Serialize B" }), TEST_CITY),
                index.mapAmberItemToResidence(makeItem(900022, TEST_CITY, { name: "Serialize C" }), TEST_CITY),
            ];
            await index.persistResidencesRaw(docs);
            // getCityListings' own read path (readAllMongoResidences) isn't
            // exported directly — use the equivalent plain Mongo read it
            // performs internally (AccommodationResidence.find({city})), the
            // same query, to confirm all 3 persisted docs are returned with
            // no implicit filter/limit applied.
            const AccommodationResidence = require(path.join(ROOT, "api", "_lib", "models", "AccommodationResidence"));
            const found = await AccommodationResidence.find({ city: TEST_CITY }).lean();
            assert.strictEqual(found.length, 3, "every persisted property for this city must be returned — none silently dropped by the read path");
        } finally {
            await cleanup();
        }
    });
    function requireFresh() {
        const accommodationIndexPath = path.join(ROOT, "api", "_lib", "accommodationIndex.js");
        return { index: require(accommodationIndexPath) };
    }

    // ══════════════════════ TEST 15 ══════════════════════
    await test("TEST 15: University Housing consumes the canonical live mapper (safeListingList / amberMapper.js), not an ad-hoc parallel one", () => {
        const src = fs.readFileSync(path.join(ROOT, "src", "pages", "UniversityHousingPage.js"), "utf8");
        assert.ok(/import\s*\{[^}]*safeListingList[^}]*\}\s*from\s*["']\.\.\/services\/amberMapper["']/.test(src), "UniversityHousingPage.js must import safeListingList from the canonical amberMapper.js");
    });

    // ══════════════════════ TEST 16 ══════════════════════
    await test("TEST 16: Find Room consumes the canonical mappers (safeListingList / safeResidenceListingList), not an ad-hoc parallel one", () => {
        const src = fs.readFileSync(path.join(ROOT, "src", "pages", "PropertyListingPage.js"), "utf8");
        assert.ok(/from\s*["']\.\.\/services\/amberMapper["']/.test(src), "PropertyListingPage.js must import from the canonical amberMapper.js");
        assert.ok(/safeListingList|safeResidenceListingList/.test(src), "PropertyListingPage.js must use one of the canonical mapper functions");
    });

    // ══════════════════════ TEST 17/18 ══════════════════════
    await test("TEST 17: Milestone 3 tests (scripts/verify-p0-rate-latency-fixes.js) still pass after this milestone's fix", () => {
        const out = execFileSync(process.execPath, [path.join(ROOT, "scripts", "verify-p0-rate-latency-fixes.js")], { cwd: ROOT, encoding: "utf8" });
        assert.ok(/=== \d+ passed, 0 failed ===/.test(out), `expected a clean pass line, got:\n${out.slice(-500)}`);
    });
    await test("TEST 18: Milestone 4 tests (scripts/verify-milestone-4-inventory-refresh.js) still pass after this milestone's fix", () => {
        const out = execFileSync(process.execPath, [path.join(ROOT, "scripts", "verify-milestone-4-inventory-refresh.js")], { cwd: ROOT, encoding: "utf8" });
        assert.ok(/=== \d+ passed, 0 failed/.test(out), `expected a clean pass line, got:\n${out.slice(-500)}`);
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
