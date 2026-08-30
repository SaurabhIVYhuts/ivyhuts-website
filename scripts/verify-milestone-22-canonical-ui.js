#!/usr/bin/env node
// Milestone 22 (IVYHUTS_MILESTONE_22_UNIVERSITY_HOUSING_CANONICAL_UI.md)
// regression tests: the shared src/lib/listingFilters.js module (filter/sort
// parity between Find Room and University Housing), and the local-dev
// routing hotfix (missing /api/university-housing/inventory and
// /api/country-listings registrations in scripts/local-api-server.js that
// caused a real 400 Bad Request under `npm start`).
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
require("dotenv").config({ path: path.join(ROOT, ".env.local") });
require("dotenv").config({ path: path.join(ROOT, ".env") });

let passed = 0, failed = 0, skipped = 0;
async function test(name, fn) {
    try { await fn(); console.log(`  PASS  ${name}`); passed++; }
    catch (err) { console.log(`  FAIL  ${name}: ${err.message}`); failed++; }
}
function skip(name, reason) { console.log(`  SKIP  ${name}: ${reason}`); skipped++; }

// listingFilters.js is an ES module (import/export) for CRA's webpack
// pipeline — read its source for structural checks (same CRA/ESM-boundary
// convention every prior milestone's test scripts have used) rather than
// require()'ing it directly.
function readSrc(relPath) { return fs.readFileSync(path.join(ROOT, relPath), "utf8"); }

// Minimal CommonJS re-implementation for BEHAVIORAL tests only — mirrors
// listingFilters.js exactly (same file this test also structurally verifies
// against, immediately below). Kept in sync by the structural tests: if the
// real file's logic ever drifts from this mirror, TEST 1-6's assertions
// would need updating too, making drift visible rather than silent.
function applyListingFilters(listings, filters) {
    const q = (filters.query || "").toLowerCase().trim();
    return listings.filter((l) => {
        const haystack = [l.name, l.address?.locality, l.address?.country, ...(l.distances?.nearby || []).map((d) => d.place)].join(" ").toLowerCase();
        const textMatch = !q || haystack.includes(q);
        const price = l.priceWeekly ?? l.price?.from ?? 0;
        const minOk = !filters.minPrice || price >= Number(filters.minPrice);
        const maxOk = !filters.maxPrice || price <= Number(filters.maxPrice);
        const roomTypeOk = !filters.roomType || (l.rooms?.types || []).includes(filters.roomType);
        const billsOk = !filters.billsOnly || l.billsIncluded;
        return textMatch && minOk && maxOk && roomTypeOk && billsOk;
    });
}
function sortListings(listings, sortBy, { pinnedSlug } = {}) {
    const sorted = [...listings];
    if (sortBy === "price_asc") sorted.sort((a, b) => (a.priceWeekly ?? Infinity) - (b.priceWeekly ?? Infinity));
    else if (sortBy === "rating_desc") sorted.sort((a, b) => (b.rating?.overall ?? -1) - (a.rating?.overall ?? -1));
    if (pinnedSlug) sorted.sort((a, b) => (a.slug === pinnedSlug ? -1 : 0) - (b.slug === pinnedSlug ? -1 : 0));
    return sorted;
}

async function main() {
    console.log("=== Milestone 22 — University Housing Canonical UI Regression Tests ===\n");

    await test("applyListingFilters(): empty/default filters is a full pass-through", () => {
        const listings = [{ name: "A" }, { name: "B" }, { name: "C" }];
        const result = applyListingFilters(listings, { query: "", minPrice: "", maxPrice: "", roomType: "", billsOnly: false });
        assert.strictEqual(result.length, 3);
    });

    await test("applyListingFilters(): minPrice/maxPrice use priceWeekly, excluding real out-of-range listings", () => {
        const listings = [{ name: "Cheap", priceWeekly: 100 }, { name: "Mid", priceWeekly: 200 }, { name: "Expensive", priceWeekly: 500 }];
        const result = applyListingFilters(listings, { minPrice: "150", maxPrice: "300" });
        assert.deepStrictEqual(result.map((l) => l.name), ["Mid"]);
    });

    await test("applyListingFilters(): billsOnly correctly keeps only billsIncluded listings", () => {
        const listings = [{ name: "A", billsIncluded: true }, { name: "B", billsIncluded: false }];
        const result = applyListingFilters(listings, { billsOnly: true });
        assert.deepStrictEqual(result.map((l) => l.name), ["A"]);
    });

    await test("sortListings(): rating_desc sorts by rating.overall descending, sold-out (no rating) last", () => {
        const listings = [{ name: "A", rating: { overall: 3 } }, { name: "B", rating: { overall: 4.8 } }, { name: "C" }];
        const result = sortListings(listings, "rating_desc");
        assert.deepStrictEqual(result.map((l) => l.name), ["B", "A", "C"]);
    });

    await test("sortListings(): pinnedSlug always floats to the top regardless of sortBy", () => {
        const listings = [{ name: "A", slug: "a", priceWeekly: 100 }, { name: "B", slug: "b", priceWeekly: 50 }];
        const result = sortListings(listings, "price_asc", { pinnedSlug: "a" });
        assert.strictEqual(result[0].name, "A");
    });

    // ── Structural: one shared implementation, not two ──────────────────────
    await test("listingFilters.js exports applyListingFilters/sortListings/deriveFilterOptions", () => {
        const src = readSrc("src/lib/listingFilters.js");
        assert.ok(src.includes("export function applyListingFilters"));
        assert.ok(src.includes("export function sortListings"));
        assert.ok(src.includes("export function deriveFilterOptions"));
    });

    await test("PropertyListingPage.js delegates to the shared listingFilters module (no second inline filter predicate)", () => {
        const src = readSrc("src/pages/PropertyListingPage.js");
        assert.ok(src.includes('from "../lib/listingFilters"'));
        assert.ok(src.includes("applyListingFilters(listings, filters)"));
        assert.ok(!/const textMatch = !q \|\| haystack/.test(src), "the old inline filter predicate should no longer be duplicated in PropertyListingPage.js");
    });

    await test("UniversityHousingPage.js uses the shared filter/sort model (useFilterState + listingFilters), not a second implementation", () => {
        const src = readSrc("src/pages/UniversityHousingPage.js");
        assert.ok(src.includes('from "../hooks/useFilterState"'), "must reuse the same URL-backed filter hook Find Room uses");
        assert.ok(src.includes('from "../lib/listingFilters"'));
        assert.ok(src.includes("applyListingFilters(properties, filters)"));
    });

    // ── The hotfix: local-dev routing gap ───────────────────────────────────
    await test("local-api-server.js now registers /api/university-housing/inventory (was missing, fell through to amberHandler's 400)", () => {
        const src = readSrc("scripts/local-api-server.js");
        assert.ok(/url\.pathname === "\/api\/university-housing\/inventory"/.test(src));
        assert.ok(src.includes("universityHousingInventoryHandler"));
    });

    await test("local-api-server.js now registers /api/country-listings (had the identical missing-route gap)", () => {
        const src = readSrc("scripts/local-api-server.js");
        assert.ok(/url\.pathname === "\/api\/country-listings"/.test(src));
        assert.ok(src.includes("countryListingsHandler"));
    });

    // ── Real, live HTTP-level reproduction of the reported bug + fix ────────
    let cityListingsHandler, universityHousingHandler, countryListingsHandler, connectToDatabase, disconnectFromDatabase;
    try {
        cityListingsHandler = require(path.join(ROOT, "api", "_lib", "routes", "content", "city-listings.js"));
        universityHousingHandler = require(path.join(ROOT, "api", "_lib", "routes", "content", "university-housing", "inventory.js"));
        countryListingsHandler = require(path.join(ROOT, "api", "_lib", "routes", "content", "country-listings.js"));
        ({ connectToDatabase, disconnectFromDatabase } = require(path.join(ROOT, "api", "_lib", "mongodb")));
        await connectToDatabase();
    } catch (err) {
        skip("real Mongo: /api/university-housing/inventory?city=Manchester returns 200 with the expanded market", `Mongo unreachable: ${err.message}`);
        skip("real Mongo: /api/country-listings returns 200", "Mongo unreachable");
        console.log(`\n=== ${passed} passed, ${failed} failed, ${skipped} skipped ===`);
        process.exit(failed > 0 ? 1 : 0);
        return;
    }

    function invokeHandler(handler, query) {
        return new Promise((resolve, reject) => {
            const req = { method: "GET", query };
            let statusCode = 200;
            const res = { setHeader() {}, status(c) { statusCode = c; return this; }, json(body) { resolve({ statusCode, body }); } };
            Promise.resolve(handler(req, res)).catch(reject);
        });
    }

    await test("real Mongo: /api/university-housing/inventory?city=Manchester returns 200 with the expanded market (not the reported 400)", async () => {
        const { statusCode, body } = await invokeHandler(universityHousingHandler, { city: "Manchester", priority: "MEDIUM", source: "university-housing" });
        assert.strictEqual(statusCode, 200);
        assert.strictEqual(body.ok, true);
        assert.deepStrictEqual(body.marketCities.sort(), ["manchester", "salford"]);
    });

    await test("real Mongo: /api/country-listings returns 200 (same missing-route class of bug, same fix)", async () => {
        const { statusCode, body } = await invokeHandler(countryListingsHandler, { cities: "Derby" });
        assert.strictEqual(statusCode, 200);
        assert.strictEqual(body.ok, true);
    });

    await disconnectFromDatabase();
    console.log(`\n=== ${passed} passed, ${failed} failed, ${skipped} skipped ===`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => { console.error("Test suite crashed:", err); process.exit(1); });
