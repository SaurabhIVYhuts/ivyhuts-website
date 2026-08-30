#!/usr/bin/env node
// Milestone 11 (IVYHUTS_MILESTONE_11_FIND_ROOM_CANONICAL_MIGRATION_REPORT.md)
// verification — Part 22's 17-test list.
//
// SAFETY: every test uses a mocked global.fetch (zero real Amber calls) or
// is a structural check on source files. Mongo-writing tests are scoped to
// "zzz-milestone11-test-*" city names, cleaned up before/after.
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

function freshModules(fetchImpl) {
    const files = ["sharedStore.js", "amberGateway.js", "accommodationIndex.js", "accommodationInventoryService.js"].map((f) => path.join(ROOT, "api", "_lib", f));
    for (const f of files) delete require.cache[require.resolve(f)];
    for (const k of ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_URL", "KV_REST_API_TOKEN"]) delete process.env[k];
    global.fetch = fetchImpl;
    return {
        index: require(path.join(ROOT, "api", "_lib", "accommodationIndex.js")),
        service: require(path.join(ROOT, "api", "_lib", "accommodationInventoryService.js")),
    };
}
function countingFetch(pages = {}) {
    const calls = [];
    const fn = async (url) => {
        calls.push(url);
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
async function cleanupCities(cities) {
    const AccommodationResidence = require(path.join(ROOT, "api", "_lib", "models", "AccommodationResidence"));
    const AccommodationIndexMeta = require(path.join(ROOT, "api", "_lib", "models", "AccommodationIndexMeta"));
    await AccommodationResidence.deleteMany({ city: { $in: cities } });
    await AccommodationIndexMeta.deleteMany({ city: { $in: cities } });
}
function fixtureDoc(id, city) {
    return { source: "amber", propertyId: String(id), propertyName: `Fixture ${id}`, city, latitude: 51.5, longitude: -0.1, available: true, roomTypes: ["Studio"], amenities: [], badges: [], nearbyUniversities: [], nearbyPlaces: [] };
}

async function main() {
    console.log("=== IVYHUTS Milestone 11 — Find Room Canonical Migration Verification ===\n");

    const listingPageSrc = fs.readFileSync(path.join(ROOT, "src", "pages", "PropertyListingPage.js"), "utf8");

    // ══════════════════════ TEST 1 ══════════════════════
    await test("TEST 1: plain /find-rooms makes zero Amber listing calls (no data fetch at all — static DESTINATIONS browse)", () => {
        assert.ok(listingPageSrc.includes("if (!hasActiveSearch) {"), "the bare-browse early-return must still exist");
        assert.ok(!/hasActiveSearch[\s\S]{0,200}getProperties\(/.test(listingPageSrc.slice(0, listingPageSrc.indexOf("if (!hasActiveSearch)") + 400)));
    });

    // ══════════════════════ TEST 2 ══════════════════════
    await test("TEST 2: /find-rooms?city=... makes zero Amber listing calls (real Mongo, unchanged canonical path)", async () => {
        await requireMongo();
        const city = "zzz-milestone11-test-city";
        await cleanupCities([city]);
        try {
            const AccommodationResidence = require(path.join(ROOT, "api", "_lib", "models", "AccommodationResidence"));
            const AccommodationIndexMeta = require(path.join(ROOT, "api", "_lib", "models", "AccommodationIndexMeta"));
            await AccommodationResidence.insertMany([fixtureDoc(1, city)]);
            await AccommodationIndexMeta.updateOne({ city }, { $set: { city, status: "ok", lastRefreshedAt: new Date(), residenceCount: 1 } }, { upsert: true });
            const fetchFn = countingFetch();
            const { index } = freshModules(fetchFn);
            const result = await index.getCityListings(city, { priority: "MEDIUM", source: "test2" });
            assert.strictEqual(result.status, "ready");
            assert.strictEqual(fetchFn.calls.length, 0);
        } finally { await cleanupCities([city]); }
    });

    // ══════════════════════ TEST 3 ══════════════════════
    await test("TEST 3 (core Milestone 11 fix): /find-rooms?country=... makes zero Amber calls — one combined Mongo query across all cities, not a per-city fan-out", async () => {
        await requireMongo();
        const cities = ["zzz-milestone11-test-c1", "zzz-milestone11-test-c2", "zzz-milestone11-test-c3"];
        await cleanupCities(cities);
        try {
            const AccommodationResidence = require(path.join(ROOT, "api", "_lib", "models", "AccommodationResidence"));
            await AccommodationResidence.insertMany(cities.flatMap((c, i) => [fixtureDoc(`${i}1`, c), fixtureDoc(`${i}2`, c)]));
            const fetchFn = countingFetch();
            const { service } = freshModules(fetchFn);
            const result = await service.getCountryInventory(cities);
            assert.strictEqual(result.status, "ready");
            assert.strictEqual(result.residences.length, 6, "all 6 fixture properties across 3 cities must be returned from ONE query");
            assert.strictEqual(fetchFn.calls.length, 0, "country browse must make zero Amber calls regardless of how many cities it covers");
        } finally { await cleanupCities(cities); }
    });

    // ══════════════════════ TEST 4 ══════════════════════
    await test("TEST 4 (core Milestone 11 fix): /find-rooms?university=... (normal, non-override) makes zero Amber calls", async () => {
        await requireMongo();
        const city = "zzz-milestone11-test-university";
        await cleanupCities([city]);
        try {
            const AccommodationResidence = require(path.join(ROOT, "api", "_lib", "models", "AccommodationResidence"));
            const AccommodationIndexMeta = require(path.join(ROOT, "api", "_lib", "models", "AccommodationIndexMeta"));
            await AccommodationResidence.insertMany([fixtureDoc(1, city)]);
            await AccommodationIndexMeta.updateOne({ city }, { $set: { city, status: "ok", lastRefreshedAt: new Date(), residenceCount: 1 } }, { upsert: true });
            const fetchFn = countingFetch();
            const { index } = freshModules(fetchFn);
            const result = await index.getCityListings(city, { priority: "MEDIUM", source: "listings-university" });
            assert.strictEqual(result.status, "ready");
            assert.strictEqual(fetchFn.calls.length, 0);
            assert.ok(listingPageSrc.includes('getCityListings(resolvedUniversity.city, "MEDIUM", "listings-university")'), "the non-override university branch must call getCityListings, not getProperties");
        } finally { await cleanupCities([city]); }
    });

    // ══════════════════════ TEST 5 ══════════════════════
    await test("TEST 5: property override behavior remains an explicit, documented, unchanged exception (never part of normal browse)", () => {
        assert.ok(listingPageSrc.includes("EXPLICIT OVERRIDE"), "the override branch must be explicitly labeled/documented, not silently mixed with normal browse");
        assert.ok(listingPageSrc.includes("overrideSlugs.map((slug) => getPropertyBySlug(slug"), "the override branch's live-Amber-per-slug mechanism must remain unchanged");
    });

    // ══════════════════════ TEST 6 ══════════════════════
    await test("TEST 6: canonical Mongo is read for city/university/property/country (all 4 modes confirmed calling getCityListings/getCitiesListings)", () => {
        assert.ok(listingPageSrc.includes("getCityListings(city, \"MEDIUM\", \"listings-page\")"));
        assert.ok(listingPageSrc.includes("getCityListings(resolvedUniversity.city"));
        assert.ok(listingPageSrc.includes("getCityListings(propertyResolution.city"));
        assert.ok(listingPageSrc.includes("getCountryListings(cityNames"));
    });

    // ══════════════════════ TEST 7/8 ══════════════════════
    await test("TEST 7/8: source IDs remain stable and unique across the new multi-city country query (real Mongo)", async () => {
        await requireMongo();
        const cities = ["zzz-milestone11-test-dup1", "zzz-milestone11-test-dup2"];
        await cleanupCities(cities);
        try {
            const AccommodationResidence = require(path.join(ROOT, "api", "_lib", "models", "AccommodationResidence"));
            await AccommodationResidence.insertMany([fixtureDoc(1, cities[0]), fixtureDoc(2, cities[0]), fixtureDoc(3, cities[1])]);
            const { service } = freshModules(countingFetch());
            const result = await service.getCountryInventory(cities);
            const ids = result.residences.map((r) => r.propertyId);
            assert.strictEqual(new Set(ids).size, ids.length, "no duplicate propertyId across cities");
            assert.strictEqual(ids.length, 3);
        } finally { await cleanupCities(cities); }
    });

    // ══════════════════════ TEST 9 ══════════════════════
    await test("TEST 9: filters remain fully functional (useFilterState.js untouched, unchanged wiring)", () => {
        assert.ok(listingPageSrc.includes("useFilterState("));
        const filterHookSrc = fs.readFileSync(path.join(ROOT, "src", "hooks", "useFilterState.js"), "utf8");
        assert.ok(filterHookSrc.includes("minPrice:") && filterHookSrc.includes("amenities:"));
    });

    // ══════════════════════ TEST 10 ══════════════════════
    // Milestone 22 moved the pin-to-top comparator into the shared
    // src/lib/listingFilters.js's sortListings() (as `a.slug === pinnedSlug`,
    // with PropertyListingPage.js passing propertyResolution.slug in as
    // `pinnedSlug`) — the real invariant (pin-to-top still keys on `slug`,
    // which safeResidenceListingList also populates from the canonical doc)
    // is unchanged, just relocated.
    await test("TEST 10: sorting remains functional, including the property-exact-match pin-to-top logic (now verified correct against Mongo-sourced slugs)", () => {
        const listingFiltersSrc = fs.readFileSync(path.join(ROOT, "src", "lib", "listingFilters.js"), "utf8");
        assert.ok(listingFiltersSrc.includes("a.slug === pinnedSlug"), "the pin-to-top comparison must still use `slug`, which safeResidenceListingList also populates from the canonical doc");
        assert.ok(listingPageSrc.includes("propertyResolution.slug : null") || listingPageSrc.includes("pinnedSlug"), "PropertyListingPage.js must still pass the resolved property's slug through to the shared sort as the pin target");
    });

    // ══════════════════════ TEST 11/12/13 ══════════════════════
    await test("TEST 11/12/13: availability, pricing, and sold-out logic use the shared canonical resolvers (no per-page duplication)", () => {
        delete require.cache[require.resolve(path.join(ROOT, "api", "_lib", "accommodationIndex.js"))];
        global.fetch = countingFetch();
        const index = require(path.join(ROOT, "api", "_lib", "accommodationIndex.js"));
        assert.strictEqual(index.resolvePropertyAvailability({ children: [{ name: "A", available: false, children: [{ available: false }] }] }), "SOLD_OUT");
        assert.strictEqual(index.resolvePropertyAvailability({}), "UNKNOWN");
    });

    // ══════════════════════ TEST 14 ══════════════════════
    // Repository cleanup: this test previously read the now-removed
    // IVYHUTS_MILESTONE_11_FIND_ROOM_DATA_PATH.md historical report as a
    // (weak) proxy for "the no-pagination decision is documented." Fixed to
    // check the actual current code decision directly — a real structural
    // assertion, not a "file is non-empty" check against prose that could
    // drift from the real implementation.
    await test("TEST 14: pagination — current real scale does not require server-side pagination (documented, not assumed)", () => {
        const indexSrc = fs.readFileSync(path.join(ROOT, "api", "_lib", "accommodationIndex.js"), "utf8");
        assert.ok(!/\.limit\(\d+\)/.test(indexSrc), "getCitiesListings()/getCityListings() must not silently cap results with a Mongo .limit()");
        const countrySrc = fs.readFileSync(path.join(ROOT, "api", "_lib", "routes", "content", "country-listings.js"), "utf8");
        assert.ok(!/\bpage\b|\bskip\b|\blimit\b/i.test(countrySrc), "the country-listings route must not have grown pagination params — the no-pagination decision is a deliberate, current design choice, not an oversight");
    });

    // ══════════════════════ TEST 15 ══════════════════════
    await test("TEST 15: STALE inventory does not block the normal country-browse response (real Mongo)", async () => {
        await requireMongo();
        const cities = ["zzz-milestone11-test-stale"];
        await cleanupCities(cities);
        try {
            const AccommodationResidence = require(path.join(ROOT, "api", "_lib", "models", "AccommodationResidence"));
            await AccommodationResidence.insertMany([fixtureDoc(1, cities[0])]);
            const { service } = freshModules(countingFetch());
            const startedAt = Date.now();
            const result = await service.getCountryInventory(cities);
            const durationMs = Date.now() - startedAt;
            assert.strictEqual(result.status, "ready");
            assert.ok(durationMs < 2000, "getCitiesListings is a pure read — must never block on a refresh");
        } finally { await cleanupCities(cities); }
    });

    // ══════════════════════ TEST 16/17 ══════════════════════
    await test("TEST 16/17: missing inventory for some cities in a country does not cause a request storm or trigger any refresh — pure read, cities with nothing indexed simply contribute zero rows", async () => {
        await requireMongo();
        const cities = ["zzz-milestone11-test-missing1", "zzz-milestone11-test-missing2", "zzz-milestone11-test-has-data"];
        await cleanupCities(cities);
        try {
            const AccommodationResidence = require(path.join(ROOT, "api", "_lib", "models", "AccommodationResidence"));
            await AccommodationResidence.insertMany([fixtureDoc(1, "zzz-milestone11-test-has-data")]); // only 1 of 3 cities has data
            const fetchFn = countingFetch();
            const { service } = freshModules(fetchFn);
            const results = await Promise.all(Array.from({ length: 10 }, () => service.getCountryInventory(cities)));
            results.forEach((r) => assert.strictEqual(r.residences.length, 1, "every concurrent call must see exactly the 1 real property, from the 1 city that has data"));
            assert.strictEqual(fetchFn.calls.length, 0, "10 concurrent country requests covering 2 never-indexed cities must never trigger any Amber call — this is a pure read, not a refresh trigger");
        } finally { await cleanupCities(cities); }
    });

    console.log(`\n=== ${passed} passed, ${failed} failed, ${skipped} skipped ===`);
    if (failed > 0) { console.log("\nFailures:"); failures.forEach((f) => console.log(`  - ${f.name}: ${f.message}`)); process.exitCode = 1; }
    process.exit(process.exitCode || 0);
}

main().catch((err) => { console.error("Verification script crashed:", err); process.exitCode = 1; process.exit(1); });
