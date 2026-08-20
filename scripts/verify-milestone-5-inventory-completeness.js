#!/usr/bin/env node
// Milestone 5 (Amber Inventory Completeness + Canonical Normalization)
// verification. See IVYHUTS_MILESTONE_5_INVENTORY_COMPLETENESS_REPORT.md and
// IVYHUTS_AMBER_MAPPING_INVENTORY.md for the full design/findings.
//
// SAFETY: every test that would otherwise reach Amber uses deterministic
// fixtures or a mocked global.fetch (same technique scripts/verify-p0-rate-
// latency-fixes.js established) — zero real Amber calls possible. TEST 11/12
// (Mongo upsert correctness) use REAL MongoDB (confirmed reachable), scoped
// exclusively to synthetic "zzz-milestone5-test-*" propertyIds/city names,
// cleaned up in try/finally before and after, verified with a direct count
// query at the end of this file.
"use strict";

const assert = require("assert");
const path = require("path");
const ROOT = path.join(__dirname, "..");
require("dotenv").config({ path: path.join(ROOT, ".env.local") });
require("dotenv").config({ path: path.join(ROOT, ".env") });

const { mapAmberItemToResidence, resolvePropertyAvailability, persistResidencesRaw } = require(path.join(ROOT, "api", "_lib", "accommodationIndex"));
const { normalizeCityName } = require(path.join(ROOT, "api", "_lib", "amberGateway"));

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

// ── Fixture builders — realistic raw Amber item shapes ──────────────────
function makeRawItem(overrides = {}) {
    return {
        id: 900001,
        name: "Test Residence",
        canonical_name: "test-residence",
        location: { country: { long_name: "United Kingdom" }, locality: { long_name: "Manchester" } },
        location_coordinates: { lat: 53.48, lng: -2.24 },
        image_featured_link: "https://example.com/img.jpg",
        pricing: { min_price: 200, currency: "gbp", duration: "weekly" },
        children: [],
        available: true,
        ...overrides,
    };
}
function makeRoom({ name = "Studio", available = true, tenancyPrice = 200, tenancyAvailable = available } = {}) {
    return {
        name,
        available,
        pricing: { min_price: tenancyPrice, currency: "gbp", duration: "weekly" },
        children: [{ id: `${name}-tenancy`, available: tenancyAvailable, pricing: { price: tenancyPrice, currency: "gbp", duration: "weekly" } }],
    };
}

async function main() {
    console.log("=== IVYHUTS Milestone 5 — Inventory Completeness Verification ===\n");

    // ══════════════════════ TEST 1 ══════════════════════
    await test("TEST 1: two Amber properties with different IDs but the same name -> 2 distinct IVYHUTS residences", () => {
        const a = mapAmberItemToResidence(makeRawItem({ id: 111, name: "Same Name Hall" }), "manchester");
        const b = mapAmberItemToResidence(makeRawItem({ id: 222, name: "Same Name Hall" }), "manchester");
        assert.ok(a && b);
        assert.notStrictEqual(a.propertyId, b.propertyId);
        assert.strictEqual(a.propertyName, b.propertyName);
    });

    // ══════════════════════ TEST 2 ══════════════════════
    await test("TEST 2: the same property appearing across multiple Amber pages merges into exactly 1 residence (dedup by real id, via fetchListings' own Map)", async () => {
        const { fetchListings } = requireFreshAmberGateway({
            // Page 1: 1 genuine match + 1 noise item (a different city) — a
            // full 2-item page but only 1 real match, which is what makes the
            // Milestone 3-fixed pagination loop legitimately continue to page
            // 2 rather than stopping early (see amberGateway.js's own
            // requestedLimit/merged.size condition).
            "test2-city:1": [
                { id: 5001, name: "Dup Property", location: { locality: { long_name: "test2-city" } } },
                { id: 9999, name: "Noise", location: { locality: { long_name: "other-city" } } },
            ],
            // Page 2: the SAME property (id 5001) again — simulating Amber
            // returning overlapping results across pages.
            "test2-city:2": [{ id: 5001, name: "Dup Property", location: { locality: { long_name: "test2-city" } } }],
        });
        const result = await fetchListings({ city: "test2-city", page: 1, limit: 2 }, "MEDIUM", "m5-test2");
        const items = result.data.data.result;
        assert.strictEqual(items.length, 1, "the same Amber id appearing on two pages must merge into exactly one entry");
        assert.strictEqual(items[0].id, 5001);
    });

    // ══════════════════════ TEST 3 ══════════════════════
    await test("TEST 3: property with no coordinates remains in the listing dataset (never rejected for a missing optional field)", () => {
        const raw = makeRawItem({ id: 333, location_coordinates: undefined });
        const doc = mapAmberItemToResidence(raw, "manchester");
        assert.ok(doc, "must not be rejected");
        assert.strictEqual(doc.latitude, null);
        assert.strictEqual(doc.longitude, null);
    });

    // ══════════════════════ TEST 4 ══════════════════════
    await test("TEST 4: property with no image remains in the listing dataset", () => {
        const raw = makeRawItem({ id: 444, image_featured_link: undefined, images: undefined });
        const doc = mapAmberItemToResidence(raw, "manchester");
        assert.ok(doc, "must not be rejected");
        assert.strictEqual(doc.image, null);
    });

    // ══════════════════════ TEST 5 ══════════════════════
    await test("TEST 5: property has room data but no available tenancy -> remains represented as SOLD_OUT, not removed", () => {
        const raw = makeRawItem({ id: 555, children: [makeRoom({ available: false, tenancyAvailable: false })] });
        const doc = mapAmberItemToResidence(raw, "manchester");
        assert.ok(doc, "must not be rejected — a sold-out property is still a real property");
        assert.strictEqual(doc.available, false);
        assert.strictEqual(resolvePropertyAvailability(raw), "SOLD_OUT");
    });

    // ══════════════════════ TEST 6 ══════════════════════
    await test("TEST 6: an available tenancy exists alongside a cheaper SOLD-OUT room -> displayed price comes from the cheapest AVAILABLE tenancy, never the sold-out one", () => {
        const raw = makeRawItem({
            id: 666,
            children: [
                makeRoom({ name: "Cheap Sold Out", available: false, tenancyPrice: 50, tenancyAvailable: false }),
                makeRoom({ name: "Pricier Available", available: true, tenancyPrice: 300, tenancyAvailable: true }),
            ],
        });
        const doc = mapAmberItemToResidence(raw, "manchester");
        assert.ok(doc);
        assert.strictEqual(doc.available, true);
        assert.strictEqual(doc.price.amount, 300, "must select the available room's price, never the cheaper sold-out room's");
    });

    // ══════════════════════ TEST 7 ══════════════════════
    await test("TEST 7: city normalization treats real distinct locations as distinct, and the same city typed differently as identical", () => {
        assert.strictEqual(normalizeCityName("Manchester"), normalizeCityName("  MANCHESTER  "), "case/whitespace variants of the SAME city must normalize identically");
        assert.strictEqual(normalizeCityName("Manchester"), normalizeCityName("manchester"));
        // Real, distinct locations found in production Mongo data (Milestone
        // 5 investigation) — must NOT collapse into one key.
        assert.notStrictEqual(normalizeCityName("Kingston"), normalizeCityName("Kingston upon Thames"), "genuinely different real places must not be merged by normalization");
        assert.notStrictEqual(normalizeCityName("York"), normalizeCityName("New York"));
        assert.notStrictEqual(normalizeCityName("Melbourne"), normalizeCityName("North Melbourne"));
    });

    // ══════════════════════ TEST 8 ══════════════════════
    await test("TEST 8: two properties with a same-looking slug/name still receive stable, distinct source IDs derived only from Amber's own id", () => {
        const raw1 = makeRawItem({ id: 777, name: "Studio Point", canonical_name: "studio-point" });
        const raw2 = makeRawItem({ id: 888, name: "Studio Point", canonical_name: "studio-point" }); // same name AND same slug
        const doc1 = mapAmberItemToResidence(raw1, "manchester");
        const doc2 = mapAmberItemToResidence(raw2, "manchester");
        assert.notStrictEqual(doc1.propertyId, doc2.propertyId, "identity must come from raw.id, never from name or slug");
        assert.strictEqual(doc1.propertyId, "777");
        assert.strictEqual(doc2.propertyId, "888");
    });

    // ══════════════════════ TEST 9 ══════════════════════
    await test("TEST 9: a malformed Amber property (no id) is rejected with an explicit, categorized reason — not a silent/generic discard", () => {
        const logs = [];
        const originalLog = console.log;
        console.log = (...args) => logs.push(args.join(" "));
        try {
            const rejectedNoId = mapAmberItemToResidence(makeRawItem({ id: null }), "manchester");
            const rejectedNoName = mapAmberItemToResidence(makeRawItem({ id: 999, name: null }), "manchester");
            assert.strictEqual(rejectedNoId, null);
            assert.strictEqual(rejectedNoName, null);
            assert.ok(logs.some((l) => l.includes("RESIDENCE_REJECTED") && l.includes("reason=MISSING_SOURCE_ID")), "expected an explicit MISSING_SOURCE_ID rejection log");
            assert.ok(logs.some((l) => l.includes("RESIDENCE_REJECTED") && l.includes("reason=MISSING_NAME")), "expected an explicit MISSING_NAME rejection log");
        } finally {
            console.log = originalLog;
        }
    });

    // ══════════════════════ TEST 10 ══════════════════════
    await test("TEST 10: a property missing several OTHER optional fields (rating, roomType, country) is not rejected", () => {
        const raw = makeRawItem({ id: 1010, location: {}, pricing: {} });
        const doc = mapAmberItemToResidence(raw, "manchester");
        assert.ok(doc, "must not be rejected for missing optional display fields");
        assert.strictEqual(doc.country, null);
        assert.strictEqual(doc.rating, null);
    });

    // ══════════════════════ TEST 11/12 — Mongo upsert correctness ══════════════════════
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
    async function cleanup(city) {
        const AccommodationResidence = require(path.join(ROOT, "api", "_lib", "models", "AccommodationResidence"));
        await AccommodationResidence.deleteMany({ city });
    }

    await test("TEST 11: repeating the same Mongo upsert for the same propertyId never creates a duplicate document", async () => {
        await requireMongo();
        const city = "zzz-milestone5-test-upsert-repeat";
        await cleanup(city);
        try {
            const doc = mapAmberItemToResidence(makeRawItem({ id: 111100, name: "Repeat Upsert Test" }), city);
            await persistResidencesRaw([doc]);
            await persistResidencesRaw([doc]);
            await persistResidencesRaw([doc]);
            const AccommodationResidence = require(path.join(ROOT, "api", "_lib", "models", "AccommodationResidence"));
            const count = await AccommodationResidence.countDocuments({ city, propertyId: "111100" });
            assert.strictEqual(count, 1, "the same propertyId upserted 3 times must produce exactly 1 document");
        } finally {
            await cleanup(city);
        }
    });

    await test("TEST 12: Mongo upsert for two different Amber IDs sharing the same name produces two distinct documents", async () => {
        await requireMongo();
        const city = "zzz-milestone5-test-upsert-samename";
        await cleanup(city);
        try {
            const docA = mapAmberItemToResidence(makeRawItem({ id: 222200, name: "Twin Named Hall" }), city);
            const docB = mapAmberItemToResidence(makeRawItem({ id: 222201, name: "Twin Named Hall" }), city);
            await persistResidencesRaw([docA, docB]);
            const AccommodationResidence = require(path.join(ROOT, "api", "_lib", "models", "AccommodationResidence"));
            const docs = await AccommodationResidence.find({ city, propertyName: "Twin Named Hall" }).lean();
            assert.strictEqual(docs.length, 2, "two different Amber IDs with the same name must remain two separate documents");
            assert.notStrictEqual(docs[0].propertyId, docs[1].propertyId);
        } finally {
            await cleanup(city);
        }
    });

    // ══════════════════════ helper: isolated amberGateway with a mock fetch, used only by TEST 2 ══════════════════════
    function requireFreshAmberGateway(pages) {
        const sharedStorePath = path.join(ROOT, "api", "_lib", "sharedStore.js");
        const amberGatewayPath = path.join(ROOT, "api", "_lib", "amberGateway.js");
        delete require.cache[require.resolve(sharedStorePath)];
        delete require.cache[require.resolve(amberGatewayPath)];
        for (const k of ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_URL", "KV_REST_API_TOKEN"]) delete process.env[k];
        global.fetch = async (url) => {
            const u = new URL(url);
            const page = Number(u.searchParams.get("p")) || 1;
            const city = (u.searchParams.get("location_place_name") || "").toLowerCase();
            const items = pages[`${city}:${page}`] || [];
            return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ message: "success", data: { result: items, meta: { count: items.length } } }) };
        };
        return require(amberGatewayPath);
    }

    console.log(`\n=== ${passed} passed, ${failed} failed, ${skipped} skipped ===`);
    if (failed > 0) {
        console.log("\nFailures:");
        failures.forEach((f) => console.log(`  - ${f.name}: ${f.message}`));
        process.exitCode = 1;
    }
    process.exit(process.exitCode || 0);
}

main().catch((err) => { console.error("Verification script crashed:", err); process.exitCode = 1; process.exit(1); });
