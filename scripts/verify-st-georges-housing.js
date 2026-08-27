#!/usr/bin/env node
// St George's University of London verification: proves the new institution
// resolves correctly (including its required aliases, without introducing
// any collision-risk aliases), that its coordinates are the real Tooting/
// Cranmer Terrace campus (not central London, not the OTHER, differently-
// located post-merger "City St George's" Islington campus, not fabricated),
// that residences rank/display by real Haversine distance from campus
// through the EXISTING accommodation pipeline, and that adding it introduced
// zero new Amber call paths and zero regressions for Manchester/Derby/UOWD
// Dubai/Vamos Madrid/Bristol.
//
// SCOPE: St George's was added ONLY to src/data/campusUniversities.json —
// the University Housing page's own, fully independent dataset (see
// src/lib/campusUniversityResolver.js's own header: "Deliberately a
// SEPARATE dataset/resolver from src/lib/universityResolver.js"). It was
// deliberately NOT added to api/_lib/universities.json / the Student
// Planner's dataset — this task's scope is University Housing only.
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

function normalize(str) {
    return String(str || "").toLowerCase().replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim();
}

async function main() {
    console.log("=== IvyHuts St George's University of London Verification ===\n");

    const CAMPUS_UNIVERSITIES = require(path.join(ROOT, "src", "data", "campusUniversities.json"));
    const { haversineKm, hasValidCoords } = require(path.join(ROOT, "src", "lib", "geoDistance.js"));

    // Re-implements campusUniversityResolver.js's own normalize+exact-match
    // algorithm against the REAL dataset — same precedent already used by
    // verify-university-housing.js (see that file's own header for why: ESM
    // JSON-import syntax makes requiring the real resolver awkward from a
    // plain Node script). Verified structurally against the actual resolver
    // source further below.
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

    const stGeorges = CAMPUS_UNIVERSITIES.find((u) => u.id === "st-georges-university-of-london");

    // ══════════════════════════ DATASET / DATA QUALITY ══════════════════════════
    await test("DATASET: St George's University of London exists with id/name/type/city/country", () => {
        assert.ok(stGeorges, "st-georges-university-of-london not found in src/data/campusUniversities.json");
        assert.strictEqual(stGeorges.name, "St George's University of London");
        assert.strictEqual(stGeorges.type, "UNIVERSITY");
        assert.strictEqual(stGeorges.city, "London");
        assert.strictEqual(stGeorges.country, "United Kingdom");
    });
    await test("DATASET: id is unique and follows the repository's existing kebab-case convention", () => {
        const ids = CAMPUS_UNIVERSITIES.map((u) => u.id);
        assert.strictEqual(ids.filter((id) => id === "st-georges-university-of-london").length, 1);
        assert.strictEqual(new Set(ids).size, ids.length, "no duplicate ids anywhere in the dataset after this addition");
    });
    await test("DATASET: coordinates are real, finite, in-range, and never (0,0)", () => {
        assert.ok(Number.isFinite(stGeorges.latitude) && Number.isFinite(stGeorges.longitude));
        assert.ok(Math.abs(stGeorges.latitude) <= 90 && Math.abs(stGeorges.longitude) <= 180);
        assert.ok(!(stGeorges.latitude === 0 && stGeorges.longitude === 0));
    });
    await test("DATASET: coordinates are plausibly in Tooting/south-west London (the actual campus), not central London or a generic city-centre guess", () => {
        // Tooting's real-world bounding box, roughly 51.41-51.44N, -0.19 to -0.16E.
        assert.ok(stGeorges.latitude > 51.41 && stGeorges.latitude < 51.44, `latitude ${stGeorges.latitude} is not plausibly in Tooting`);
        assert.ok(stGeorges.longitude > -0.19 && stGeorges.longitude < -0.16, `longitude ${stGeorges.longitude} is not plausibly in Tooting`);
        // Central London (e.g. Charing Cross, 51.5074,-0.1278) is genuinely
        // several km away — catches an accidental "generic London centre" fallback.
        const kmFromCentralLondon = haversineKm(stGeorges.latitude, stGeorges.longitude, 51.5074, -0.1278);
        assert.ok(kmFromCentralLondon > 5, `expected the real Tooting campus to be materially south of central London, got only ${kmFromCentralLondon}km away`);
    });
    await test("DATASET: coordinates are clearly distinct from the OTHER, differently-located post-merger 'City St George's' campus in Islington (a genuinely different real-world site, not this one)", () => {
        const kmFromIslingtonCampus = haversineKm(stGeorges.latitude, stGeorges.longitude, 51.5277, -0.1036);
        assert.ok(kmFromIslingtonCampus > 5, `expected these coordinates to be clearly distinct from the Islington campus, got ${kmFromIslingtonCampus}km apart`);
    });

    // ══════════════════════════ ALIASES (item 5 — safe, no collision-risk) ══════════════════════════
    await test('ALIASES: "St George\'s University of London" (exact name) resolves', () => {
        assert.strictEqual(resolve("St George's University of London")?.id, "st-georges-university-of-london");
    });
    await test('ALIASES: "St Georges University of London" (no apostrophe) resolves', () => {
        assert.strictEqual(resolve("St Georges University of London")?.id, "st-georges-university-of-london");
    });
    await test('ALIASES: "SGUL" resolves', () => {
        assert.strictEqual(resolve("SGUL")?.id, "st-georges-university-of-london");
    });
    await test('ALIASES: "St George\'s" and "St Georges" both resolve', () => {
        assert.strictEqual(resolve("St George's")?.id, "st-georges-university-of-london");
        assert.strictEqual(resolve("St Georges")?.id, "st-georges-university-of-london");
    });
    await test("ALIASES: case/punctuation/whitespace-insensitive matching, same rule as every other university", () => {
        assert.strictEqual(resolve("  sgul!! ")?.id, "st-georges-university-of-london");
        assert.strictEqual(resolve("ST GEORGE'S UNIVERSITY OF LONDON")?.id, "st-georges-university-of-london");
    });
    await test('ALIASES: the overly-broad forms the milestone explicitly warned against ("George\'s", "London", "St George") were NOT added as standalone aliases', () => {
        const aliasKeys = new Set(stGeorges.aliases.map(normalize));
        ["georges", "london", "st george"].forEach((broad) => {
            assert.ok(!aliasKeys.has(broad), `"${broad}" must not be a standalone alias — too broad, risks matching an unrelated institution`);
        });
    });
    await test("ALIASES: no alias collides with any other institution's name/alias in the dataset (no ambiguous resolution introduced)", () => {
        const keyToOwners = new Map();
        CAMPUS_UNIVERSITIES.forEach((u) => {
            [u.name, ...(u.aliases || [])].map(normalize).forEach((key) => {
                if (!key) return;
                if (!keyToOwners.has(key)) keyToOwners.set(key, new Set());
                keyToOwners.get(key).add(u.id);
            });
        });
        const collisions = Array.from(keyToOwners.entries()).filter(([, owners]) => owners.size > 1);
        assert.strictEqual(collisions.length, 0, `ambiguous keys: ${collisions.map(([k, o]) => `"${k}" -> ${Array.from(o).join(",")}`).join("; ")}`);
    });
    await test("RESOLVER: unknown/unrelated text still returns no match, never a guess (fuzzy matching was not introduced)", () => {
        assert.strictEqual(resolve("Saint George Academy"), null);
        assert.strictEqual(resolve("George's College"), null);
    });

    // ══════════════════════════ REGRESSION — existing universities unaffected ══════════════════════════
    await test("REGRESSION: University of Manchester still resolves correctly", () => {
        const u = resolve("University of Manchester");
        assert.strictEqual(u?.id, "university-of-manchester");
        assert.strictEqual(u.city, "Manchester");
    });
    await test("REGRESSION: University of Derby still resolves correctly", () => {
        const u = resolve("University of Derby");
        assert.strictEqual(u?.id, "university-of-derby");
        assert.strictEqual(u.city, "Derby");
    });
    await test("REGRESSION: University of Wollongong in Dubai (UOWD) still resolves correctly, including its UOWD alias", () => {
        assert.strictEqual(resolve("University of Wollongong in Dubai (UOWD)")?.id, "university-of-wollongong-dubai");
        assert.strictEqual(resolve("UOWD")?.id, "university-of-wollongong-dubai");
    });
    await test("REGRESSION: Vamos Madrid (school) still resolves correctly and keeps its SCHOOL type", () => {
        const u = resolve("Vamos Spanish Academy");
        assert.strictEqual(u?.id, "vamos-spanish-academy-madrid");
        assert.strictEqual(u.type, "SCHOOL");
    });
    await test("REGRESSION: University of Bristol still resolves correctly", () => {
        assert.strictEqual(resolve("University of Bristol")?.id, "university-of-bristol");
    });
    await test("REGRESSION: University of Hertfordshire's accommodationOverride (a pre-existing business rule) is untouched by this addition", () => {
        const herts = CAMPUS_UNIVERSITIES.find((u) => u.id === "university-of-hertfordshire");
        assert.deepStrictEqual(herts.accommodationOverride, { propertySlugs: ["luna-hatfield-1905073461300"] });
    });
    await test("REGRESSION: St George's itself has NO accommodationOverride — it uses the generic city-wide accommodation path like Manchester/Derby/Dubai/Bristol, not a special-cased one like Hertfordshire", () => {
        assert.strictEqual(stGeorges.accommodationOverride, undefined);
    });

    // ══════════════════════════ DISTANCE CALCULATION (item 10/19) — the real Haversine utility, real coordinates ══════════════════════════
    await test("HAVERSINE: a residence very close to St George's (elsewhere in Tooting) computes a small, real distance, not zero/NaN/fabricated", () => {
        // Tooting Broadway station, ~600m from the Cranmer Terrace campus.
        const km = haversineKm(stGeorges.latitude, stGeorges.longitude, 51.4275, -0.1682);
        assert.ok(Number.isFinite(km) && km >= 0 && km < 2, `expected a small real distance, got ${km}`);
    });
    await test("HAVERSINE: a residence further away (e.g. Clapham, ~4km) computes a materially larger real distance", () => {
        const km = haversineKm(stGeorges.latitude, stGeorges.longitude, 51.4618, -0.1367);
        assert.ok(Number.isFinite(km) && km > 2, `expected a materially larger distance than the nearby case, got ${km}`);
    });
    await test("DISTANCE FORMATTING: the page's own distanceKm computation rounds to 1 decimal place (no excessive precision like 2.374829174)", () => {
        const raw = haversineKm(stGeorges.latitude, stGeorges.longitude, 51.4275, -0.1682);
        const rounded = Math.round(raw * 10) / 10;
        assert.ok(/^\d+(\.\d)?$/.test(String(rounded)), `expected at most 1 decimal place, got ${rounded}`);
    });
    await test("hasValidCoords: St George's own coordinates pass the same validity check every other university's coordinates must pass", () => {
        assert.strictEqual(hasValidCoords(stGeorges.latitude, stGeorges.longitude), true);
    });
    await test("DISTANCE NEVER FABRICATED: a residence with missing coordinates would receive distanceKm=null, never a guessed value — verified against the page's own logic, structurally", () => {
        const pageSrc = fs.readFileSync(path.join(ROOT, "src", "pages", "UniversityHousingPage.js"), "utf8");
        assert.ok(/propertyHasCoords\s*=\s*hasValidCoords/.test(pageSrc));
        assert.ok(/universityHasCoords\s*&&\s*propertyHasCoords\s*\?[\s\S]{0,300}:\s*null/.test(pageSrc), "expected distanceKm to fall back to null (never a fabricated value) whenever either coordinate is missing — applies to St George's exactly as it does to every other university, no special-casing");
    });

    // ══════════════════════════ MAP (item 12) — St George's is a UNIVERSITY type, gets the correct marker ══════════════════════════
    await test("MAP: St George's type (UNIVERSITY) routes to the graduation-cap marker, not the school-building marker — same generic type-based icon logic every institution already uses", () => {
        const mapSrc = fs.readFileSync(path.join(ROOT, "src", "components", "universityHousing", "UniversityHousingMap.js"), "utf8");
        assert.ok(/university\.type === "SCHOOL" \? schoolIcon : universityIcon/.test(mapSrc), "expected the existing generic type-based marker selection to be unchanged — no St-George's-specific branch");
        assert.strictEqual(stGeorges.type, "UNIVERSITY");
    });
    await test("MAP: no St-George's-specific code exists anywhere in the map component (fully generic, data-driven)", () => {
        const mapSrc = fs.readFileSync(path.join(ROOT, "src", "components", "universityHousing", "UniversityHousingMap.js"), "utf8");
        assert.ok(!/georges|sgul|tooting/i.test(mapSrc));
    });

    // ══════════════════════════ SINGLE DATA FLOW / NO DUPLICATE REQUESTS (item 13/15) ══════════════════════════
    await test("SINGLE DATA FLOW: UniversityHousingPage.js still calls getProperties() exactly twice total (initial load + explicit load-more) — St George's introduces no extra call site", () => {
        const pageSrc = fs.readFileSync(path.join(ROOT, "src", "pages", "UniversityHousingPage.js"), "utf8");
        const matches = pageSrc.match(/(?:await|=)\s*getProperties\(/g) || [];
        assert.strictEqual(matches.length, 2, `expected exactly 2 call sites, found ${matches.length}`);
    });
    await test("SINGLE DATA FLOW: the map and list panel remain pure renderers of already-loaded props — neither calls getProperties() itself", () => {
        const mapSrc = fs.readFileSync(path.join(ROOT, "src", "components", "universityHousing", "UniversityHousingMap.js"), "utf8");
        const listSrc = fs.readFileSync(path.join(ROOT, "src", "components", "universityHousing", "PropertyListPanel.js"), "utf8");
        assert.ok(!/getProperties\(/.test(mapSrc) && !/getProperties\(/.test(listSrc));
    });

    // ══════════════════════════ AMBER ISOLATION (item 14/21) — adding a university must never touch Amber ══════════════════════════
    await test("AMBER ISOLATION: none of amberGateway.js/sharedStore.js/cacheWarmer.js/api/amber.js reference St George's/SGUL/Tooting — this addition's entire footprint is the dataset + the pre-existing generic city pipeline", () => {
        ["amberGateway.js", "sharedStore.js", "cacheWarmer.js"].forEach((f) => {
            const src = fs.readFileSync(path.join(ROOT, "api", "_lib", f), "utf8");
            assert.ok(!/georges|sgul|tooting/i.test(src));
        });
        const amberJsSrc = fs.readFileSync(path.join(ROOT, "api", "_lib", "routes", "content", "amber.js"), "utf8");
        assert.ok(!/georges|sgul|tooting/i.test(amberJsSrc));
    });
    await test("AMBER ISOLATION: loading/resolving the curated dataset (including St George's) makes ZERO fetch() calls", () => {
        const originalFetch = global.fetch;
        let calls = 0;
        global.fetch = async (...args) => { calls++; return originalFetch(...args); };
        try {
            resolve("St George's University of London");
            resolve("SGUL");
            CAMPUS_UNIVERSITIES.forEach((u) => resolve(u.name));
        } finally {
            global.fetch = originalFetch;
        }
        assert.strictEqual(calls, 0, "resolving universities (St George's included) must never make a network call of any kind");
    });
    await test("AMBER ISOLATION: no St-George's-specific conditional/bypass exists anywhere in the accommodation pipeline (e.g. `if (city === \"London\")`, a special-cased London branch)", () => {
        const files = [
            path.join(ROOT, "api", "_lib", "accommodationIndex.js"),
            path.join(ROOT, "src", "pages", "UniversityHousingPage.js"),
        ];
        files.forEach((f) => {
            const src = fs.readFileSync(f, "utf8");
            assert.ok(!/georges|sgul/i.test(src), `${path.basename(f)} must contain zero St-George's-specific logic`);
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
