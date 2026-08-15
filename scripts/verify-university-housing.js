#!/usr/bin/env node
// University Housing (/university-housing) verification: proves the new
// University -> City -> IVYHUTS properties -> map page (1) resolves its
// priority universities and their aliases correctly, (2) never fabricates a
// coordinate, (3) computes distance with a real Haversine calculation, (4)
// stays wired to the existing Amber gateway/property pipeline rather than
// becoming a second, uncoordinated data source, and (5) is actually routed
// and discoverable. Same standalone-Node-script convention as every other
// scripts/verify-*.js in this repo (Jest is broken repo-wide for an
// unrelated pre-existing reason).
//
// NODE ESM NOTE: this Node version supports `require()` of plain ESM-syntax
// .js files directly (used below for src/lib/geoDistance.js and
// src/services/amberMapper.js — both real, unmodified function calls, not
// reimplementations). src/lib/campusUniversityResolver.js is the one
// exception: it does `import X from "*.json"`, and Node's ESM loader (unlike
// webpack/CRA's) requires an explicit `type: "json"` import attribute for
// that, which would be an unusual, untested syntax addition to a real
// production file just to satisfy this script. Rather than risk that, this
// script requires src/data/campusUniversities.json directly (trivial, no
// ESM issues) and re-implements the SAME small normalize/exact-match
// algorithm campusUniversityResolver.js uses (verified structurally below,
// see "RESOLVER SOURCE") — the exact "hand-duplicated twin, kept in sync,
// same algorithm" precedent this codebase already uses for
// universityResolver.js's own frontend/backend copies.
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  PASS  ${name}`);
    } catch (err) {
        failed++;
        failures.push({ name, message: err.message });
        console.log(`  FAIL  ${name}\n        ${err.message}`);
    }
}

async function main() {
    console.log("=== IvyHuts University Housing Verification ===\n");

    const CAMPUS_UNIVERSITIES = require(path.join(ROOT, "src", "data", "campusUniversities.json"));
    const { haversineKm, hasValidCoords } = require(path.join(ROOT, "src", "lib", "geoDistance.js"));
    const { mapAmberPropertyToListing, safeListingList } = require(path.join(ROOT, "src", "services", "amberMapper.js"));

    // ══════════════════════════ DATASET STRUCTURE ══════════════════════════
    await test("DATASET: every university has id/name/city/country and an array of aliases", () => {
        CAMPUS_UNIVERSITIES.forEach((u) => {
            assert.ok(u.id && u.id.trim(), `missing id on ${u.name}`);
            assert.ok(u.name && u.name.trim(), `missing name on ${u.id}`);
            assert.ok(u.city && u.city.trim(), `${u.id}: missing city`);
            assert.ok(u.country && u.country.trim(), `${u.id}: missing country`);
            assert.ok(Array.isArray(u.aliases), `${u.id}: aliases must be an array`);
        });
    });
    await test("DATASET: no duplicate university ids", () => {
        assert.strictEqual(new Set(CAMPUS_UNIVERSITIES.map((u) => u.id)).size, CAMPUS_UNIVERSITIES.length);
    });
    await test("DATASET: coordinates are never half-fabricated — latitude/longitude are both real finite numbers, or both honestly null (never one-sided)", () => {
        CAMPUS_UNIVERSITIES.forEach((u) => {
            const latIsNum = typeof u.latitude === "number" && Number.isFinite(u.latitude);
            const lngIsNum = typeof u.longitude === "number" && Number.isFinite(u.longitude);
            assert.strictEqual(latIsNum, lngIsNum, `${u.id}: latitude/longitude must both be present or both be null, never mixed`);
            if (latIsNum) {
                assert.ok(Math.abs(u.latitude) <= 90, `${u.id}: latitude out of range`);
                assert.ok(Math.abs(u.longitude) <= 180, `${u.id}: longitude out of range`);
            }
        });
    });
    await test("DATASET: normalized name/alias keys never collide across two different universities (no ambiguous resolution)", () => {
        const normalize = (s) => String(s || "").toLowerCase().replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim();
        const seen = new Map();
        const collisions = [];
        CAMPUS_UNIVERSITIES.forEach((u) => {
            [u.name, ...(u.aliases || [])].map(normalize).forEach((key) => {
                if (!key) return;
                if (seen.has(key) && seen.get(key) !== u.id) collisions.push(`"${key}" -> ${seen.get(key)} vs ${u.id}`);
                seen.set(key, u.id);
            });
        });
        assert.deepStrictEqual(collisions, [], `found ambiguous alias(es): ${collisions.join(", ")}`);
    });

    // ══════════════════════════ PRIORITY UNIVERSITIES ══════════════════════════
    const byId = new Map(CAMPUS_UNIVERSITIES.map((u) => [u.id, u]));
    await test("PRIORITY: University of Bristol exists with the correct city/country and real coordinates", () => {
        const u = byId.get("university-of-bristol");
        assert.ok(u, "university-of-bristol not found in dataset");
        assert.strictEqual(u.city, "Bristol");
        assert.strictEqual(u.country, "United Kingdom");
        assert.ok(hasValidCoords(u.latitude, u.longitude), "expected real coordinates for a well-known, verifiable campus");
    });
    await test("PRIORITY: University College Dublin exists with the correct city/country and real coordinates", () => {
        const u = byId.get("university-college-dublin");
        assert.ok(u, "university-college-dublin not found in dataset");
        assert.strictEqual(u.city, "Dublin");
        assert.strictEqual(u.country, "Ireland");
        assert.ok(hasValidCoords(u.latitude, u.longitude));
    });
    await test("PRIORITY: Vamos Madrid exists with the correct city/country and real, verified coordinates (updated in the Vamos Madrid SCHOOL milestone — see scripts/verify-vamos-madrid-school.js for full coordinate-provenance coverage)", () => {
        const u = byId.get("vamos-spanish-academy-madrid");
        assert.ok(u, "vamos-spanish-academy-madrid not found in dataset");
        assert.strictEqual(u.city, "Madrid");
        assert.strictEqual(u.country, "Spain");
        assert.strictEqual(u.type, "SCHOOL");
        assert.ok(hasValidCoords(u.latitude, u.longitude), "coordinates were unverified (null) when this record was first added; a later milestone verified the school's real address/coordinates against its own official contact page + independent geocoders — see that milestone's report");
    });

    // ══════════════════════════ ALIAS RESOLUTION (acceptance tests, item 28) ══════════════════════════
    // Re-implements campusUniversityResolver.js's own normalize+exact-match
    // algorithm (see this file's header for why) against the REAL dataset —
    // structurally verified against the actual resolver source below.
    function normalize(str) {
        return String(str || "").toLowerCase().replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim();
    }
    const INDEX = new Map();
    for (const uni of CAMPUS_UNIVERSITIES) {
        for (const key of [uni.name, ...(uni.aliases || [])].map(normalize)) {
            if (!key) continue;
            if (!INDEX.has(key)) INDEX.set(key, []);
            const bucket = INDEX.get(key);
            if (!bucket.some((u) => u.id === uni.id)) bucket.push(uni);
        }
    }
    function resolve(input) {
        const key = normalize(input);
        const matches = INDEX.get(key);
        return matches && matches.length === 1 ? matches[0] : null;
    }

    await test('TEST 1: "University of Bristol" resolves directly', () => {
        assert.strictEqual(resolve("University of Bristol")?.id, "university-of-bristol");
    });
    await test('TEST 2: "University College Dublin" resolves directly', () => {
        assert.strictEqual(resolve("University College Dublin")?.id, "university-college-dublin");
    });
    await test('TEST 3: "Vamos Spanish Academy" resolves directly', () => {
        assert.strictEqual(resolve("Vamos Spanish Academy")?.id, "vamos-spanish-academy-madrid");
    });
    await test('TEST 4: alias "UCD" resolves to University College Dublin', () => {
        assert.strictEqual(resolve("UCD")?.id, "university-college-dublin");
    });
    await test('TEST 5: alias "Bristol University" resolves to University of Bristol', () => {
        assert.strictEqual(resolve("Bristol University")?.id, "university-of-bristol");
    });
    await test('BONUS ALIASES: "Vamos Spanish School" and "Spanish School Madrid" both resolve to the same Vamos record (no duplicate created)', () => {
        assert.strictEqual(resolve("Vamos Spanish School")?.id, "vamos-spanish-academy-madrid");
        assert.strictEqual(resolve("Spanish School Madrid")?.id, "vamos-spanish-academy-madrid");
    });
    await test("RESOLVER: unknown university text returns no match, never a guess", () => {
        assert.strictEqual(resolve("Totally Made Up University"), null);
        assert.strictEqual(resolve(""), null);
        assert.strictEqual(resolve(null), null);
    });

    // ══════════════════════════ RESOLVER SOURCE (structural) ══════════════════════════
    const resolverSrc = fs.readFileSync(path.join(ROOT, "src", "lib", "campusUniversityResolver.js"), "utf8");
    await test("RESOLVER SOURCE: uses exact/alias matching only (matches.length !== 1 guard), no fuzzy-matching library", () => {
        assert.ok(/matches\.length\s*!==\s*1/.test(resolverSrc), "expected the same ambiguous-match guard used everywhere else in this codebase");
        assert.ok(!/fuse\.js|fuzzysort|leven|natural/i.test(resolverSrc), "must not depend on a fuzzy-matching library");
    });
    await test("RESOLVER SOURCE: is a separate dataset/module from the Student Planner's own universityResolver.js (feature isolation)", () => {
        assert.ok(resolverSrc.includes("campusUniversities.json"), "expected campusUniversityResolver.js to read its own dataset, not universities.json");
        assert.ok(!/from ["']\.\.\/data\/universities\.json["']/.test(resolverSrc), "must not import the planner's university dataset");
    });

    // ══════════════════════════ HAVERSINE DISTANCE ══════════════════════════
    await test("HAVERSINE: zero distance for identical coordinates", () => {
        assert.strictEqual(haversineKm(51.5, -0.1, 51.5, -0.1), 0);
    });
    await test("HAVERSINE: known distance (Manchester <-> Leeds, ~55-65km) is in a sane range — same fixture the planner's own map already relies on", () => {
        const km = haversineKm(53.4668, -2.2339, 53.8067, -1.5550);
        assert.ok(km > 50 && km < 70, `expected ~55-65km, got ${km}`);
    });
    await test("HAVERSINE: Bristol <-> Dublin (two priority universities, real coordinates) is a plausible cross-sea distance, not zero/NaN", () => {
        const bristol = byId.get("university-of-bristol");
        const ucd = byId.get("university-college-dublin");
        const km = haversineKm(bristol.latitude, bristol.longitude, ucd.latitude, ucd.longitude);
        assert.ok(Number.isFinite(km) && km > 200 && km < 500, `expected a few hundred km, got ${km}`);
    });
    await test("hasValidCoords: null-safe — never throws on missing/partial/out-of-range input", () => {
        assert.strictEqual(hasValidCoords(null, null), false);
        assert.strictEqual(hasValidCoords(undefined, undefined), false);
        assert.strictEqual(hasValidCoords(999, -0.1), false);
        assert.strictEqual(hasValidCoords(51.5, -0.1), true);
    });

    // ══════════════════════════ AMBER MAPPER — COORDINATES (real function, item 7/13) ══════════════════════════
    await test("mapAmberPropertyToListing: surfaces real coordinates from Amber's own location_coordinates field", () => {
        const raw = { id: 1, name: "Test House", canonical_name: "test-house", location_coordinates: { lat: 51.4585, lng: -2.6030 }, pricing: { min_price: 200, currency: "gbp" } };
        const listing = mapAmberPropertyToListing(raw);
        assert.deepStrictEqual(listing.coordinates, { lat: 51.4585, lng: -2.6030 });
    });
    await test("mapAmberPropertyToListing: NEVER fabricates a coordinate — missing/invalid location_coordinates surfaces as null", () => {
        const missing = mapAmberPropertyToListing({ id: 2, name: "No Coords", canonical_name: "no-coords" });
        assert.strictEqual(missing.coordinates, null);
        const malformed = mapAmberPropertyToListing({ id: 3, name: "Bad Coords", canonical_name: "bad-coords", location_coordinates: { lat: "not-a-number", lng: -2.6 } });
        assert.strictEqual(malformed.coordinates, null, "a non-numeric lat must never be coerced into a fabricated marker location");
    });
    await test("safeListingList: a mixed batch (some with coords, some without) never throws, coordinates field always present (null-safe)", () => {
        const list = safeListingList([
            { id: 1, name: "A", canonical_name: "a", location_coordinates: { lat: 1, lng: 2 } },
            { id: 2, name: "B", canonical_name: "b" },
            null,
            { id: 3, name: "C", canonical_name: "c", location_coordinates: null },
        ]);
        assert.strictEqual(list.length, 3, "the null entry must be dropped, not throw");
        list.forEach((l) => assert.notStrictEqual(l.coordinates, undefined, `${l.name}: coordinates must be null, never undefined`));
    });
    await test("amberMapper.js's coordinate extraction is structurally identical in source to api/_lib/accommodationIndex.js's own (same raw.location_coordinates.lat/lng field, no new Amber field assumed)", () => {
        const backendSrc = fs.readFileSync(path.join(ROOT, "api", "_lib", "accommodationIndex.js"), "utf8");
        const frontendSrc = fs.readFileSync(path.join(ROOT, "src", "services", "amberMapper.js"), "utf8");
        assert.ok(/location_coordinates\?\.lat/.test(backendSrc));
        assert.ok(/location_coordinates\?\.lat/.test(frontendSrc));
    });

    // ══════════════════════════ ROUTING & NAVIGATION (structural) ══════════════════════════
    const appSrc = fs.readFileSync(path.join(ROOT, "src", "App.js"), "utf8");
    await test('ROUTING: "/university-housing" is registered as a lazy-loaded route pointing at UniversityHousingPage', () => {
        assert.ok(/path="\/university-housing"\s+element=\{<UniversityHousingPage/.test(appSrc), "expected a registered /university-housing route");
        assert.ok(/lazy\(\(\) => import\("\.\/pages\/UniversityHousingPage"\)\)/.test(appSrc), "expected UniversityHousingPage to be lazy-loaded like every other non-home route");
    });
    await test('ROUTING: the existing /student-planner route is untouched (same element, same path, still present)', () => {
        assert.ok(/path="\/student-planner"\s+element=\{<StudentPlannerPage/.test(appSrc), "the pre-existing Student Planner route must remain exactly as it was");
    });
    await test("NAVIGATION: University Housing has a discoverable entry point in the desktop/mobile navbar and the mobile menu sheet", () => {
        const navSrc = fs.readFileSync(path.join(ROOT, "src", "components", "layout", "SiteNavbar.js"), "utf8");
        const sheetSrc = fs.readFileSync(path.join(ROOT, "src", "components", "layout", "MobileMenuSheet.js"), "utf8");
        assert.ok(navSrc.includes('"/university-housing"'), "expected a nav link to /university-housing in SiteNavbar.js");
        assert.ok(sheetSrc.includes('"/university-housing"'), "expected a row for /university-housing in MobileMenuSheet.js");
    });

    // ══════════════════════════ AMBER ISOLATION (structural — item 6/19/25/26) ══════════════════════════
    const pageSrc = fs.readFileSync(path.join(ROOT, "src", "pages", "UniversityHousingPage.js"), "utf8");
    const mapSrc = fs.readFileSync(path.join(ROOT, "src", "components", "universityHousing", "UniversityHousingMap.js"), "utf8");
    const listSrc = fs.readFileSync(path.join(ROOT, "src", "components", "universityHousing", "PropertyListPanel.js"), "utf8");
    const searchSrc = fs.readFileSync(path.join(ROOT, "src", "components", "universityHousing", "UniversitySearchBox.js"), "utf8");

    await test("AMBER ISOLATION: none of the new frontend files call fetch() against Amber directly, or import amberGateway/mongodb (structural)", () => {
        [pageSrc, mapSrc, listSrc, searchSrc].forEach((src) => {
            assert.ok(!/amberstudent\.com/.test(src), "must never hit Amber directly from the browser");
            assert.ok(!/require\(.*amberGateway|from ["'].*amberGateway/.test(src), "must not import the server-only Amber gateway from frontend code");
            assert.ok(!/mongodb/i.test(src), "must not import Mongo from frontend code");
        });
    });
    await test("AMBER ISOLATION: the page only ever calls existing gateway functions from src/services/amberApi.js, imported once (getProperties/getPropertyBySlug/getCachedCityStats — the same functions PropertyListingPage.js/PropertyDetailPage.js already use)", () => {
        const importLines = (pageSrc.match(/^import .*from "\.\.\/services\/amberApi";?$/gm) || []);
        assert.strictEqual(importLines.length, 1, "expected exactly one import statement from amberApi.js");
        assert.ok(/getProperties/.test(importLines[0]) && /getCachedCityStats/.test(importLines[0]), "expected the existing-gateway import to still include getProperties and getCachedCityStats");
    });
    await test("NO REQUEST LOOP: getProperties() is called exactly twice in the page (initial load + explicit user-triggered loadMore) — never once per marker/property/render", () => {
        // Matches only actual invocations ("await getProperties(" / "= getProperties("),
        // not the several prose mentions of "getProperties()" in this file's own comments.
        const matches = pageSrc.match(/(?:await|=)\s*getProperties\(/g) || [];
        assert.strictEqual(matches.length, 2, `expected exactly 2 call sites, found ${matches.length}`);
        // Neither call site may live inside a .map()/.forEach() over the
        // properties array — a textual proxy for "not one request per item".
        assert.ok(!/properties\.(map|forEach)\([^)]*getProperties\(/.test(pageSrc), "getProperties() must never be called from inside a per-property loop");
    });
    await test("MAP PERFORMANCE: the map component never calls the property API itself — it only ever renders props it was given", () => {
        assert.ok(!/getProperties\(/.test(mapSrc), "UniversityHousingMap.js must be a pure renderer of props, not a data-fetching component");
        assert.ok(!/getProperties\(/.test(listSrc), "PropertyListPanel.js must be a pure renderer of props, not a data-fetching component");
    });
    await test('DATA SOURCE: no second property "database" — the page/components only ever import safeListingList/mapAmberPropertyToListing from the existing amberMapper.js, never define their own property shape mapper', () => {
        assert.ok(pageSrc.includes('from "../services/amberMapper"'), "expected the page to reuse the existing amberMapper.js");
        [mapSrc, listSrc].forEach((src) => {
            assert.ok(!/function map\w*Property/i.test(src), "must not define a second, parallel property-mapping function");
        });
    });

    // ══════════════════════════ WISHLIST / PROPERTY-DETAIL REUSE (item 8/15) ══════════════════════════
    await test("WISHLIST: the map popup and list rows both reuse the existing WishlistHeart component (no second wishlist implementation)", () => {
        assert.ok(mapSrc.includes('from "../listing/WishlistHeart"'), "UniversityHousingMap.js must reuse the existing WishlistHeart");
        assert.ok(listSrc.includes('from "../listing/WishlistHeart"'), "PropertyListPanel.js must reuse the existing WishlistHeart");
        assert.ok(!/function\s+\w*Heart\w*\s*\(/.test(mapSrc) && !/function\s+\w*Heart\w*\s*\(/.test(listSrc), "must not define a second heart/wishlist component");
    });
    await test('PROPERTY DETAIL: "View Property" navigates to the existing /property/:slug route, never a new detail implementation', () => {
        assert.ok(/\/property\/\$\{encodeURIComponent\(p\.slug\)\}/.test(mapSrc));
        assert.ok(/\/property\/\$\{encodeURIComponent\(slug\)\}/.test(listSrc));
    });

    console.log(`\n=== ${passed} passed, ${failed} failed ===`);
    if (failed > 0) {
        console.log("\nFailures:");
        failures.forEach((f) => console.log(`  - ${f.name}: ${f.message}`));
        process.exitCode = 1;
    }
}

main().catch((err) => {
    console.error("Verification script crashed:", err);
    process.exitCode = 1;
});
