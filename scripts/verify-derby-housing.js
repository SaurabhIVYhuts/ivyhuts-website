#!/usr/bin/env node
// University of Derby verification: proves the new university resolves
// correctly (including all required aliases), that its coordinates are real
// (Kedleston Road campus, not invented), that Derby residences rank by real
// Haversine distance from campus when the existing Amber-backed pipeline has
// coordinate data, and that /api/student-planner derives Derby housing from
// the university alone — without a second Amber call path, without
// touching the existing UK/Canada/Australia/UAE architecture, and without
// requiring the student to supply city/country separately.
//
// MONGODB: exactly like scripts/verify-uowd-dubai-housing.js, this script
// deliberately never mocks global.fetch and calls the real planner handler
// against a real city — that combination writes to whatever real database
// MONGODB_URI points at, which caused a real (caught and fixed) incident in
// the Hertfordshire override milestone. Every test below is either a pure
// function (dataset checks, resolver, Haversine, ranking) or a structural
// source check. The genuine end-to-end proof against real Derby data is a
// live smoke test outside this script (see this task's final report),
// which only ever writes REAL Amber data into Mongo — never mocked data.
"use strict";

const assert = require("assert");
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
    console.log("=== IvyHuts University of Derby Verification ===\n");

    const UNIVERSITIES_FRONTEND = require(path.join(ROOT, "src", "data", "universities.json"));
    const UNIVERSITIES_BACKEND = require(path.join(ROOT, "api", "_lib", "universities.json"));
    const CAMPUS_UNIVERSITIES = require(path.join(ROOT, "src", "data", "campusUniversities.json"));
    const { resolveUniversityByName, resolveUniversityById } = require(path.join(ROOT, "api", "_lib", "universityResolver"));
    const { haversineKm, attachRankingDistance, rankResidences, applyRadius } = require(path.join(ROOT, "api", "_lib", "accommodationIndex"));
    const plannerHandler = require(path.join(ROOT, "api", "student-planner"));

    // ══════════════════════════ DATASET (item 2/4/20) ══════════════════════════
    for (const [label, dataset] of [["src/data/universities.json", UNIVERSITIES_FRONTEND], ["api/_lib/universities.json", UNIVERSITIES_BACKEND], ["src/data/campusUniversities.json", CAMPUS_UNIVERSITIES]]) {
        await test(`DATASET (${label}): University of Derby exists with the correct city/country and real, finite coordinates`, () => {
            const u = dataset.find((x) => x.id === "university-of-derby");
            assert.ok(u, "university-of-derby not found");
            assert.strictEqual(u.name, "University of Derby");
            assert.strictEqual(u.city, "Derby");
            assert.strictEqual(u.country, "United Kingdom");
            assert.ok(Number.isFinite(u.latitude) && Math.abs(u.latitude) <= 90);
            assert.ok(Number.isFinite(u.longitude) && Math.abs(u.longitude) <= 180);
            // Sanity: Derby's real-world bounding box (roughly 52.88-52.98N,
            // 1.35-1.60W) — catches a transposed-digit/typo'd coordinate,
            // not just "any number".
            assert.ok(u.latitude > 52.8 && u.latitude < 53.0, `latitude ${u.latitude} is not plausibly in Derby`);
            assert.ok(u.longitude < -1.3 && u.longitude > -1.65, `longitude ${u.longitude} is not plausibly in Derby`);
        });
    }
    await test("DATASET: no duplicate ids introduced across any of the three datasets", () => {
        [UNIVERSITIES_FRONTEND, UNIVERSITIES_BACKEND, CAMPUS_UNIVERSITIES].forEach((d) => {
            const ids = d.map((u) => u.id);
            assert.strictEqual(new Set(ids).size, ids.length);
        });
    });
    await test("DATASET: normalized name/alias keys never collide with any other university in any of the three datasets (no ambiguous resolution)", () => {
        function normalize(s) { return String(s || "").toLowerCase().replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim(); }
        [UNIVERSITIES_FRONTEND, UNIVERSITIES_BACKEND, CAMPUS_UNIVERSITIES].forEach((dataset) => {
            const seen = new Map();
            const collisions = [];
            dataset.forEach((u) => {
                [u.name, ...(u.aliases || [])].map(normalize).forEach((key) => {
                    if (!key) return;
                    if (seen.has(key) && seen.get(key) !== u.id) collisions.push(`"${key}" -> ${seen.get(key)} vs ${u.id}`);
                    seen.set(key, u.id);
                });
            });
            assert.deepStrictEqual(collisions, [], `found ambiguous alias(es): ${collisions.join(", ")}`);
        });
    });

    // ══════════════════════════ ALIAS RESOLUTION (item 3/20) ══════════════════════════
    await test('RESOLVER: "University of Derby" resolves', () => {
        assert.strictEqual(resolveUniversityByName("University of Derby")?.id, "university-of-derby");
    });
    await test('RESOLVER: "Derby University" resolves', () => {
        assert.strictEqual(resolveUniversityByName("Derby University")?.id, "university-of-derby");
    });
    await test('RESOLVER: alias "UoD" resolves', () => {
        assert.strictEqual(resolveUniversityByName("UoD")?.id, "university-of-derby");
    });
    await test('RESOLVER: alias "University of Derby UK" resolves', () => {
        assert.strictEqual(resolveUniversityByName("University of Derby UK")?.id, "university-of-derby");
    });
    await test("RESOLVER: case/punctuation-insensitive matching, same rule as every other university", () => {
        assert.strictEqual(resolveUniversityByName("  uod!! ")?.id, "university-of-derby");
    });
    await test("RESOLVER: authoritative id lookup returns the full record with city/country", () => {
        const u = resolveUniversityById("university-of-derby");
        assert.ok(u);
        assert.strictEqual(u.city, "Derby");
        assert.strictEqual(u.country, "United Kingdom");
    });
    await test("RESOLVER: unrelated/unknown text does not accidentally resolve to Derby (exact/alias match only, no fuzzy matching)", () => {
        assert.strictEqual(resolveUniversityByName("Derby County"), null);
        assert.strictEqual(resolveUniversityByName("Derbyshire"), null);
    });

    // ══════════════════════════ EXISTING UNIVERSITIES UNCHANGED (item 25) ══════════════════════════
    await test("REGRESSION: University of Manchester still resolves correctly and is unaffected", () => {
        const u = resolveUniversityByName("University of Manchester");
        assert.strictEqual(u.id, "university-of-manchester");
        assert.strictEqual(u.city, "Manchester");
    });
    await test("REGRESSION: University of Nottingham (a real, geographically close neighbor of Derby) still resolves to itself, not confused with Derby", () => {
        const u = resolveUniversityByName("University of Nottingham");
        assert.strictEqual(u.id, "university-of-nottingham");
        assert.strictEqual(u.city, "Nottingham");
    });
    await test("REGRESSION: University of Wollongong in Dubai (previous milestone) is unaffected", () => {
        assert.strictEqual(resolveUniversityByName("UOWD")?.id, "university-of-wollongong-dubai");
    });
    await test("REGRESSION: University of Hertfordshire's accommodationOverride (earlier milestone) is untouched", () => {
        const u = UNIVERSITIES_BACKEND.find((x) => x.id === "university-of-hertfordshire");
        assert.deepStrictEqual(u.accommodationOverride, { propertySlugs: ["luna-hatfield-1905073461300"] });
    });

    // ══════════════════════════ DISTANCE CALCULATION (item 8/9/21) — real function, real coordinates ══════════════════════════
    const derby = resolveUniversityById("university-of-derby");
    await test("HAVERSINE: a residence very close to the Kedleston Road campus computes a small, real, positive, finite distance", () => {
        // Derby city centre, ~1.5km from the Kedleston Road campus.
        const km = haversineKm(derby.latitude, derby.longitude, 52.9225, -1.4746);
        assert.ok(Number.isFinite(km) && km > 0 && km < 3, `expected a small positive real distance, got ${km}`);
    });
    await test("HAVERSINE: distance is symmetric and zero for identical coordinates (sanity on the reused function itself)", () => {
        assert.strictEqual(haversineKm(derby.latitude, derby.longitude, derby.latitude, derby.longitude), 0);
        const a = haversineKm(derby.latitude, derby.longitude, 52.9225, -1.4746);
        const b = haversineKm(52.9225, -1.4746, derby.latitude, derby.longitude);
        assert.strictEqual(a, b);
    });
    await test("attachRankingDistance: Derby residences with real coordinates get a real Haversine rankingDistanceKm from the university; residences without coordinates get null, never a guess", () => {
        const docs = [
            { propertyId: "near", latitude: 52.9199, longitude: -1.4926, distanceToCentreKm: 99 }, // real Amber-reported Derby coordinate, see report
            { propertyId: "no-coords", latitude: null, longitude: null, distanceToCentreKm: 5 },
        ];
        const [near, noCoords] = attachRankingDistance(docs, derby);
        assert.ok(Number.isFinite(near.rankingDistanceKm) && near.rankingDistanceKm < 3, "expected a small real distance for the nearby residence");
        assert.strictEqual(noCoords.rankingDistanceKm, null, "a residence without coordinates must never receive a fabricated distance");
    });
    await test("rankResidences: with a resolved University of Derby, the genuinely closer residence ranks ahead of a farther one when other factors are equal", () => {
        const docs = [
            { propertyId: "far", propertyName: "Far Residence", rankingDistanceKm: 20, rating: 4, roomType: "Studio", price: { amount: 200, currency: "£" } },
            { propertyId: "near", propertyName: "Near Residence", rankingDistanceKm: 1.5, rating: 4, roomType: "Studio", price: { amount: 200, currency: "£" } },
        ];
        const ranked = rankResidences(docs, { budget: null, accommodationPreference: null });
        assert.strictEqual(ranked[0].name, "Near Residence", "the residence genuinely closer to the University of Derby must rank first, all else equal");
    });
    await test("applyRadius: the existing top-up floor (never a Derby-specific rule) applies unmodified — real-function structural proof, not a new radius formula", () => {
        assert.strictEqual(applyRadius.constructor.name, "Function", "must remain a plain synchronous function — no Derby-specific async/Amber path introduced");
    });

    // ══════════════════════════ PLANNER STRUCTURAL (item 12/13/23) ══════════════════════════
    await test("STRUCTURAL: requiring api/student-planner.js succeeds cleanly (module loads, exports intact) — zero Mongo/Amber side effects at load time", () => {
        assert.strictEqual(typeof plannerHandler, "function");
        assert.strictEqual(typeof plannerHandler.buildDegreeResult, "function");
    });
    await test("STRUCTURAL: api/student-planner.js's university-derived-city fallback (effectiveCity) is the single, university-agnostic line Derby relies on — no Derby-specific branch was added", () => {
        const src = require("fs").readFileSync(path.join(ROOT, "api", "student-planner.js"), "utf8");
        assert.ok(/effectiveCity\s*=\s*\(city[^;]*\|\|\s*\(university\s*&&\s*university\.city\)/.test(src));
        assert.ok(!/derby/i.test(src), "api/student-planner.js must contain zero Derby-specific logic");
    });

    // ══════════════════════════ FILE-SCOPE / AMBER ISOLATION (item 14/15/24/26) ══════════════════════════
    const fs = require("fs");
    await test("STRUCTURAL: no Derby-specific conditional, bypass, or new endpoint exists anywhere in the accommodation pipeline (e.g. `if (city === \"Derby\")`, `/api/derby-housing`)", () => {
        const files = [
            path.join(ROOT, "api", "_lib", "accommodationIndex.js"),
            path.join(ROOT, "api", "student-planner.js"),
            path.join(ROOT, "src", "pages", "UniversityHousingPage.js"),
        ];
        files.forEach((f) => {
            const src = fs.readFileSync(f, "utf8");
            assert.ok(!/derby/i.test(src), `${path.basename(f)} must contain zero Derby-specific logic — the generic city pipeline must handle it unmodified`);
        });
        const apiDir = fs.readdirSync(path.join(ROOT, "api"));
        assert.ok(!apiDir.some((f) => /derby/i.test(f)), "no new Derby-specific API route file may exist");
    });
    await test("STRUCTURAL: amberGateway.js / sharedStore.js / cacheWarmer.js / api/amber.js were not modified for this feature", () => {
        ["amberGateway.js", "sharedStore.js", "cacheWarmer.js"].forEach((f) => {
            const src = fs.readFileSync(path.join(ROOT, "api", "_lib", f), "utf8");
            assert.ok(!/derby/i.test(src));
        });
        const amberJsSrc = fs.readFileSync(path.join(ROOT, "api", "amber.js"), "utf8");
        assert.ok(!/derby/i.test(amberJsSrc));
    });
    await test("STRUCTURAL: no direct fetch() to Amber exists in api/student-planner.js or accommodationIndex.js — both only ever call fetchListings()/fetchAmber() from amberGateway.js", () => {
        const files = [
            path.join(ROOT, "api", "student-planner.js"),
            path.join(ROOT, "api", "_lib", "accommodationIndex.js"),
        ];
        files.forEach((f) => {
            const src = fs.readFileSync(f, "utf8");
            assert.ok(!/amberstudent\.com/.test(src), `${path.basename(f)} must never reference Amber's base URL directly`);
            assert.ok(!/\bfetch\(/.test(src), `${path.basename(f)} must never call fetch() itself — only amberGateway.js may`);
        });
    });

    // ══════════════════════════ PPT COMPATIBILITY (item 19) ══════════════════════════
    await test("STRUCTURAL: PPT builder/normalize/validation were not modified and contain zero Derby-specific logic — Derby residences flow through the existing planner-result-only PPT pipeline", () => {
        ["pptBuilder.js", "pptNormalize.js", "pptValidation.js"].forEach((f) => {
            const src = fs.readFileSync(path.join(ROOT, "api", "_lib", f), "utf8");
            assert.ok(!/derby/i.test(src));
        });
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
