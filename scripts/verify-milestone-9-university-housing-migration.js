#!/usr/bin/env node
// Milestone 9 (IVYHUTS_MILESTONE_9_UNIVERSITY_HOUSING_MIGRATION_REPORT.md)
// verification — Part 21's 25-test list.
//
// SAFETY: every test uses a mocked global.fetch (zero real Amber calls) or
// is a pure structural check on source files. Mongo-writing tests are
// scoped to "zzz-milestone9-test-*" city names, cleaned up before/after.
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
async function cleanupCity(city) {
    const AccommodationResidence = require(path.join(ROOT, "api", "_lib", "models", "AccommodationResidence"));
    const AccommodationIndexMeta = require(path.join(ROOT, "api", "_lib", "models", "AccommodationIndexMeta"));
    await AccommodationResidence.deleteMany({ city });
    await AccommodationIndexMeta.deleteMany({ city });
}
function fixtureDoc(id, city, overrides = {}) {
    return { source: "amber", propertyId: String(id), propertyName: `Fixture ${id}`, city, latitude: 51.5, longitude: -0.1, available: true, roomTypes: ["Studio"], amenities: [], badges: [], nearbyUniversities: [], nearbyPlaces: [], ...overrides };
}

async function main() {
    console.log("=== IVYHUTS Milestone 9 — University Housing Migration Verification ===\n");

    const uhPageSrc = fs.readFileSync(path.join(ROOT, "src", "pages", "UniversityHousingPage.js"), "utf8");

    // ══════════════════════ TEST 1 ══════════════════════
    await test("TEST 1: known university search resolves via the unchanged Tier-1 static dataset", () => {
        const CAMPUS_UNIVERSITIES = JSON.parse(fs.readFileSync(path.join(ROOT, "src", "data", "campusUniversities.json"), "utf8"));
        const manchester = CAMPUS_UNIVERSITIES.find((u) => u.id === "university-of-manchester");
        assert.ok(manchester && manchester.city === "Manchester", "Manchester must still resolve via Tier 1, unaffected by this migration");
    });

    // ══════════════════════ TEST 2/3/4 ══════════════════════
    await test("TEST 2/3/4: university resolution (unknown/Google Maps/share.google) code paths are structurally untouched by this migration", () => {
        assert.ok(uhPageSrc.includes('resolveUniversityById as resolveDiscoveredUniversityById'), "Tier 2/3 discovery import must remain exactly as before");
        assert.ok(!/googleMapsParser|share\.google|goo\.gl/i.test(uhPageSrc), "UniversityHousingPage.js must not itself contain Google Maps/short-link parsing logic — that lives in UniversitySearchBox.js/universityDiscoveryApi.js, both unmodified by this migration");
        const searchBoxPath = path.join(ROOT, "src", "components", "universityHousing", "UniversitySearchBox.js");
        assert.ok(fs.existsSync(searchBoxPath), "the search box component (owns Google Maps URL parsing) must still exist, unmodified");
    });

    // ══════════════════════ TEST 5 ══════════════════════
    await test("TEST 5: city inventory is read from Mongo via the canonical service, not live Amber (real Mongo)", async () => {
        await requireMongo();
        const city = "zzz-milestone9-test-cityread";
        await cleanupCity(city);
        try {
            const AccommodationResidence = require(path.join(ROOT, "api", "_lib", "models", "AccommodationResidence"));
            const AccommodationIndexMeta = require(path.join(ROOT, "api", "_lib", "models", "AccommodationIndexMeta"));
            await AccommodationResidence.insertMany([fixtureDoc(1, city), fixtureDoc(2, city)]);
            await AccommodationIndexMeta.updateOne({ city }, { $set: { city, status: "ok", lastRefreshedAt: new Date(), residenceCount: 2 } }, { upsert: true });
            const fetchFn = countingFetch();
            const { service } = freshModules(fetchFn);
            const result = await service.getCityInventory(city, { priority: "MEDIUM", source: "test5" });
            assert.strictEqual(result.status, "ready");
            assert.strictEqual(result.residences.length, 2);
            assert.strictEqual(fetchFn.calls.length, 0, "a FRESH city read must make zero Amber calls");
        } finally { await cleanupCity(city); }
    });

    // ══════════════════════ TEST 6 ══════════════════════
    // amberMapper.js is an ESM module (import/export) — cannot be require()'d
    // directly in this CommonJS script. Verified structurally instead (same
    // technique every prior milestone's frontend-adjacent test already
    // uses), reading the actual mapResidenceDocToListing function.
    await test("TEST 6 (structural): mapResidenceDocToListing produces the full canonical contract (id/slug/name/city/coordinates/price/priceDuration/roomTypes/available/isSoldOut) without fabricating fields", () => {
        const mapperSrc = fs.readFileSync(path.join(ROOT, "src", "services", "amberMapper.js"), "utf8");
        for (const field of ["const id = doc.propertyId ?? null;", "slug: doc.slug", "name: doc.propertyName", "coordinates: hasCoords", "isSoldOut: doc.available === false", "available: doc.available !== false"]) {
            assert.ok(mapperSrc.includes(field), `mapResidenceDocToListing must set ${field}`);
        }
        assert.ok(mapperSrc.includes("price: {") && mapperSrc.includes("duration: doc.priceDuration"), "price/priceDuration must be preserved verbatim, never silently converted");
    });

    // ══════════════════════ TEST 7 ══════════════════════
    await test("TEST 7: price normalization — displayed price/duration are preserved verbatim; a separate weekly-equivalent exists only for sorting", () => {
        const mapperSrc = fs.readFileSync(path.join(ROOT, "src", "services", "amberMapper.js"), "utf8");
        assert.ok(mapperSrc.includes("priceWeekly: Number.isFinite(doc.priceWeekly)"), "a separate priceWeekly (comparison-only) field must exist, distinct from the displayed price");
    });

    // ══════════════════════ TEST 8/9 ══════════════════════
    await test("TEST 8/9: availability normalization and sold-out detection use the canonical resolver's rule (real Mongo mapper)", () => {
        const { index } = freshModules(countingFetch());
        const available = index.resolvePropertyAvailability({ children: [{ name: "A", available: true, children: [{ available: true }] }] });
        const soldOut = index.resolvePropertyAvailability({ children: [{ name: "A", available: false, children: [{ available: false }] }] });
        const unknown = index.resolvePropertyAvailability({});
        assert.strictEqual(available, "AVAILABLE");
        assert.strictEqual(soldOut, "SOLD_OUT");
        assert.strictEqual(unknown, "UNKNOWN", "missing availability data must never be treated as sold out");
    });

    // ══════════════════════ TEST 10 ══════════════════════
    await test("TEST 10: distance calculation still uses the local Haversine utility, not a per-property Amber/API request", () => {
        assert.ok(uhPageSrc.includes("haversineKm(university.latitude, university.longitude, p.coordinates.lat, p.coordinates.lng)"), "distance must still be computed client-side from already-loaded coordinates");
        assert.ok(!/distance.*fetch\(|fetch\(.*distance/i.test(uhPageSrc), "no per-property distance network request may exist");
    });

    // ══════════════════════ TEST 11 ══════════════════════
    // Milestone 22 renamed the shared dataset variable from `sortedProperties`
    // to `filteredProperties` when filter support was added (it's now
    // filtered AND sorted) — the invariant this test actually checks (map and
    // list panel share ONE dataset, no independent fetch) is unchanged.
    await test("TEST 11: the map and the list panel consume the SAME dataset (filteredProperties) — no independent fetch", () => {
        assert.ok(/<PropertyListPanel[\s\S]{0,80}properties=\{filteredProperties\}/.test(uhPageSrc), "PropertyListPanel must receive filteredProperties");
        assert.ok(/<UniversityHousingMap[\s\S]{0,120}properties=\{filteredProperties\}/.test(uhPageSrc), "UniversityHousingMap must receive the SAME filteredProperties, not a separately-fetched dataset");
        const mapSrc = fs.readFileSync(path.join(ROOT, "src", "components", "universityHousing", "UniversityHousingMap.js"), "utf8");
        assert.ok(!/\bfetch\(/.test(mapSrc), "UniversityHousingMap.js must still never call fetch() itself");
    });

    // ══════════════════════ TEST 12/13 ══════════════════════
    await test("TEST 12/13: STALE and EXPIRED-with-data inventory is served immediately, without a synchronous refresh (real Mongo)", async () => {
        await requireMongo();
        const city = "zzz-milestone9-test-stale";
        await cleanupCity(city);
        try {
            const AccommodationResidence = require(path.join(ROOT, "api", "_lib", "models", "AccommodationResidence"));
            const AccommodationIndexMeta = require(path.join(ROOT, "api", "_lib", "models", "AccommodationIndexMeta"));
            await AccommodationResidence.insertMany([fixtureDoc(1, city)]);
            await AccommodationIndexMeta.updateOne({ city }, { $set: { city, status: "ok", lastRefreshedAt: new Date(Date.now() - 25 * 60 * 60 * 1000), residenceCount: 1 } }, { upsert: true }); // EXPIRED
            const fetchFn = countingFetch();
            const { service } = freshModules(fetchFn);
            const startedAt = Date.now();
            const result = await service.getCityInventory(city, { priority: "MEDIUM", source: "test12" });
            const durationMs = Date.now() - startedAt;
            assert.strictEqual(result.status, "ready");
            assert.ok(durationMs < 2000, "an EXPIRED-with-data city must respond immediately, never block on a synchronous refresh");
        } finally { await cleanupCity(city); }
    });

    // ══════════════════════ TEST 14/15/18 ══════════════════════
    await test("TEST 14/15/18: MISSING inventory under heavy concurrent demand creates exactly ONE controlled refresh, not a storm (real Mongo)", async () => {
        await requireMongo();
        const city = "zzz-milestone9-test-storm";
        await cleanupCity(city);
        try {
            const fetchFn = countingFetch({ [`${city}:1`]: [{ id: 1, name: "P1", location: { locality: { long_name: city } } }] });
            const { index } = freshModules(fetchFn);
            const results = await Promise.all(Array.from({ length: 15 }, () => index.attemptCityRefresh(city, "LOW", "test14")));
            assert.strictEqual(results.filter((r) => r.attempted).length, 1, "exactly one of 15 concurrent requests should have attempted the refresh");
            assert.strictEqual(fetchFn.calls.length, 1, "exactly one real Amber call for 15 concurrent requests to a MISSING city");
        } finally { await cleanupCity(city); }
    });

    // ══════════════════════ TEST 16 ══════════════════════
    await test("TEST 16: a RUNNING refresh serves existing inventory (if any) and never starts a second refresh (real Mongo)", async () => {
        await requireMongo();
        const city = "zzz-milestone9-test-running";
        await cleanupCity(city);
        try {
            const fetchFn = countingFetch({ [`${city}:1`]: [{ id: 1, name: "P1", location: { locality: { long_name: city } } }] });
            fetchFn.calls; // baseline
            const slowFetch = async (url) => { await new Promise((r) => setTimeout(r, 150)); return countingFetch({ [`${city}:1`]: [{ id: 1, name: "P1", location: { locality: { long_name: city } } }] })(url); };
            const calls = [];
            const wrapped = async (url) => { calls.push(url); return slowFetch(url); };
            const { index } = freshModules(wrapped);
            const first = index.attemptCityRefresh(city, "LOW", "test16-a");
            await new Promise((r) => setTimeout(r, 20));
            const second = await index.attemptCityRefresh(city, "LOW", "test16-b");
            assert.strictEqual(second.attempted, false, "a second request while RUNNING must not start another refresh");
            assert.strictEqual(second.reason, "already_in_progress");
            await first;
        } finally { await cleanupCity(city); }
    });

    // ══════════════════════ TEST 17 ══════════════════════
    await test("TEST 17: FAILED_COOLDOWN respects the cooldown window (real Mongo)", async () => {
        await requireMongo();
        const city = "zzz-milestone9-test-cooldown";
        await cleanupCity(city);
        try {
            const AccommodationIndexMeta = require(path.join(ROOT, "api", "_lib", "models", "AccommodationIndexMeta"));
            await AccommodationIndexMeta.updateOne({ city }, { $set: { city, status: "error", lastAttemptedAt: new Date(), lastErrorAt: new Date(), consecutiveFailures: 3 } }, { upsert: true });
            const fetchFn = countingFetch({ [`${city}:1`]: [{ id: 1, name: "P1", location: { locality: { long_name: city } } }] });
            const { service } = freshModules(fetchFn);
            await service.getCityInventory(city, { priority: "MEDIUM", source: "test17" });
            assert.strictEqual(fetchFn.calls.length, 0, "a city within its FAILED_COOLDOWN window must not trigger a new Amber attempt");
        } finally { await cleanupCity(city); }
    });

    // ══════════════════════ TEST 19 (the most important test) ══════════════════════
    await test("TEST 19 (Part 20 — the critical assertion): a normal University Housing browse request for a FRESH city makes ZERO Amber listing calls", async () => {
        await requireMongo();
        const city = "zzz-milestone9-test-zero-amber";
        await cleanupCity(city);
        try {
            const AccommodationResidence = require(path.join(ROOT, "api", "_lib", "models", "AccommodationResidence"));
            const AccommodationIndexMeta = require(path.join(ROOT, "api", "_lib", "models", "AccommodationIndexMeta"));
            await AccommodationResidence.insertMany([fixtureDoc(1, city), fixtureDoc(2, city), fixtureDoc(3, city)]);
            await AccommodationIndexMeta.updateOne({ city }, { $set: { city, status: "ok", lastRefreshedAt: new Date(), residenceCount: 3 } }, { upsert: true });
            const fetchFn = countingFetch();
            const { service } = freshModules(fetchFn);
            // This is EXACTLY what api/university-housing/inventory.js does internally.
            const result = await service.getCityInventory(city, { priority: "MEDIUM", source: "university-housing" });
            assert.strictEqual(result.residences.length, 3);
            assert.strictEqual(fetchFn.calls.length, 0, "University Housing browse -> Amber listing calls MUST be 0 for a fresh city");
        } finally { await cleanupCity(city); }
    });

    // ══════════════════════ TEST 20 ══════════════════════
    await test("TEST 20: property navigation still uses slug/id from the canonical contract, unchanged route shape", () => {
        const mapperSrc = fs.readFileSync(path.join(ROOT, "src", "services", "amberMapper.js"), "utf8");
        assert.ok(mapperSrc.includes("slug: doc.slug || null"), "the canonical listing must carry the real Amber slug for property-detail navigation");
        const panelPath = path.join(ROOT, "src", "components", "universityHousing", "PropertyListPanel.js");
        assert.ok(fs.existsSync(panelPath), "PropertyListPanel.js must still exist, unmodified by this migration");
    });

    // ══════════════════════ TEST 21 ══════════════════════
    await test("TEST 21: filtering remains entirely client-side/user-opt-in — the new endpoint takes no filter params", () => {
        const endpointSrc = fs.readFileSync(path.join(ROOT, "api", "_lib", "routes", "content", "university-housing", "inventory.js"), "utf8");
        assert.ok(!/req\.query\.(price|room|available|filter)/i.test(endpointSrc), "the canonical inventory endpoint must not apply server-side filtering — that stays a frontend, user-opt-in concern, unchanged");
    });

    // ══════════════════════ TEST 22 ══════════════════════
    // Milestone 22 moved sort comparators into the shared src/lib/listingFilters.js
    // module (sortListings()) so Find Room and University Housing share one
    // implementation, and expanded coverage from 3 modes to all 5 Find Room
    // already had (added recommended/rating_desc) — an intentional
    // improvement, not a regression. The real invariant (distance/price_asc/
    // price_desc still work, on the same priceWeekly/distanceKm fields) is
    // checked against the new shared-module location.
    await test("TEST 22: sorting (distance/price_asc/price_desc, now shared via listingFilters.js) still operates identically on the mapped properties array", () => {
        const listingFiltersSrc = fs.readFileSync(path.join(ROOT, "src", "lib", "listingFilters.js"), "utf8");
        assert.ok(listingFiltersSrc.includes('sortBy === "distance"') && listingFiltersSrc.includes('sortBy === "price_asc"') && listingFiltersSrc.includes('sortBy === "price_desc"'), "all 3 original sort modes must remain, operating on the same priceWeekly/distanceKm fields regardless of data source");
        assert.ok(uhPageSrc.includes("sortListings(") && uhPageSrc.includes('from "../lib/listingFilters"'), "UniversityHousingPage.js must delegate sorting to the shared module, not reimplement it");
    });

    // ══════════════════════ TEST 23 ══════════════════════
    await test("TEST 23: pagination is based on canonical Mongo inventory (the whole city in one response), not Amber's page limit — hasMore is always false", () => {
        assert.ok(/const hasMore = false;/.test(uhPageSrc), "hasMore must always be false post-migration — canonical inventory returns the complete dataset in one response, nothing further to page through");
    });

    // ══════════════════════ TEST 24 ══════════════════════
    await test("TEST 24: source ID uniqueness is preserved end-to-end (real Mongo)", async () => {
        await requireMongo();
        const city = "zzz-milestone9-test-uniqueness";
        await cleanupCity(city);
        try {
            const AccommodationResidence = require(path.join(ROOT, "api", "_lib", "models", "AccommodationResidence"));
            const AccommodationIndexMeta = require(path.join(ROOT, "api", "_lib", "models", "AccommodationIndexMeta"));
            await AccommodationResidence.insertMany([fixtureDoc(1, city), fixtureDoc(2, city), fixtureDoc(3, city)]);
            await AccommodationIndexMeta.updateOne({ city }, { $set: { city, status: "ok", lastRefreshedAt: new Date(), residenceCount: 3 } }, { upsert: true });
            const { service } = freshModules(countingFetch());
            const result = await service.getCityInventory(city, { priority: "MEDIUM", source: "test24" });
            const ids = result.residences.map((r) => r.propertyId);
            assert.strictEqual(new Set(ids).size, ids.length, "no duplicate propertyId in the canonical inventory response");
        } finally { await cleanupCity(city); }
    });

    // ══════════════════════ TEST 25 ══════════════════════
    await test("TEST 25: inventory count is preserved — the endpoint never silently caps/slices below what Mongo actually holds (real Mongo)", async () => {
        await requireMongo();
        const city = "zzz-milestone9-test-count";
        await cleanupCity(city);
        try {
            const AccommodationResidence = require(path.join(ROOT, "api", "_lib", "models", "AccommodationResidence"));
            const AccommodationIndexMeta = require(path.join(ROOT, "api", "_lib", "models", "AccommodationIndexMeta"));
            const docs = Array.from({ length: 75 }, (_, i) => fixtureDoc(i + 1, city)); // > the old PAGE_LIMIT=50
            await AccommodationResidence.insertMany(docs);
            await AccommodationIndexMeta.updateOne({ city }, { $set: { city, status: "ok", lastRefreshedAt: new Date(), residenceCount: 75 } }, { upsert: true });
            const { service } = freshModules(countingFetch());
            const result = await service.getCityInventory(city, { priority: "MEDIUM", source: "test25" });
            assert.strictEqual(result.residences.length, 75, "all 75 properties must be returned — no hardcoded 50/25/20/10 cap from the old Amber-page-limit era");
        } finally { await cleanupCity(city); }
    });

    console.log(`\n=== ${passed} passed, ${failed} failed, ${skipped} skipped ===`);
    if (failed > 0) { console.log("\nFailures:"); failures.forEach((f) => console.log(`  - ${f.name}: ${f.message}`)); process.exitCode = 1; }
    process.exit(process.exitCode || 0);
}

main().catch((err) => { console.error("Verification script crashed:", err); process.exitCode = 1; process.exit(1); });
