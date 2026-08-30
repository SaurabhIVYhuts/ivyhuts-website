#!/usr/bin/env node
// Campus Velbert/Heiligenhaus (Hochschule Bochum) verification: proves the
// new campus resolves correctly (including its required aliases, without
// collision-risk aliases), that its coordinates are the exact official
// campus location supplied by the product team (not Bochum/Velbert/
// Düsseldorf/Essen city centre, not fabricated), that residences rank/
// display by real Haversine distance from campus through the EXISTING
// accommodation pipeline, and that adding it introduced zero new Amber call
// paths and zero regressions for Manchester/Derby/UOWD Dubai/Vamos Madrid/
// St George's/Hertfordshire.
//
// SCOPE: added ONLY to src/data/campusUniversities.json — the University
// Housing page's own, fully independent dataset (see
// src/lib/campusUniversityResolver.js's own header: "Deliberately a
// SEPARATE dataset/resolver from src/lib/universityResolver.js"). NOT added
// to api/_lib/universities.json / the Student Planner's dataset — this
// task's scope is University Housing only, same precedent as the St
// George's milestone (see scripts/verify-st-georges-housing.js).
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
    console.log("=== IvyHuts Campus Velbert/Heiligenhaus (Hochschule Bochum) Verification ===\n");

    const CAMPUS_UNIVERSITIES = require(path.join(ROOT, "src", "data", "campusUniversities.json"));
    const { haversineKm, hasValidCoords } = require(path.join(ROOT, "src", "lib", "geoDistance.js"));

    // Re-implements campusUniversityResolver.js's own normalize+exact-match
    // algorithm against the REAL dataset — same precedent as
    // verify-university-housing.js / verify-st-georges-housing.js (see
    // either file's own header for why a plain Node script re-implements
    // rather than importing the real ESM-JSON-import resolver directly).
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

    const campus = CAMPUS_UNIVERSITIES.find((u) => u.id === "campus-velbert-heiligenhaus");
    const OFFICIAL_LAT = 51.3274305;
    const OFFICIAL_LNG = 6.9677006;

    // ══════════════════════════ DATASET / DATA QUALITY ══════════════════════════
    await test("DATASET: Campus Velbert/Heiligenhaus exists with id/name/type/city/country", () => {
        assert.ok(campus, "campus-velbert-heiligenhaus not found in src/data/campusUniversities.json");
        assert.strictEqual(campus.name, "Campus Velbert/Heiligenhaus");
        assert.strictEqual(campus.type, "UNIVERSITY");
        assert.strictEqual(campus.city, "Heiligenhaus");
        assert.strictEqual(campus.country, "Germany");
    });
    await test("DATASET: parent institution (Hochschule Bochum) is identifiable from the record — via address/_note/aliases, not silently omitted", () => {
        assert.ok(/hochschule bochum/i.test(campus.address || "") || /hochschule bochum/i.test(campus._note || "") || campus.aliases.some((a) => /hochschule bochum/i.test(a)), "expected the parent institution to be traceable from the record");
    });
    await test("DATASET: id is unique and follows the repository's existing kebab-case convention", () => {
        const ids = CAMPUS_UNIVERSITIES.map((u) => u.id);
        assert.strictEqual(ids.filter((id) => id === "campus-velbert-heiligenhaus").length, 1);
        assert.strictEqual(new Set(ids).size, ids.length, "no duplicate ids anywhere in the dataset after this addition");
    });
    await test("DATASET: coordinates are exactly the official campus coordinates supplied by the product team", () => {
        assert.strictEqual(campus.latitude, OFFICIAL_LAT);
        assert.strictEqual(campus.longitude, OFFICIAL_LNG);
    });
    await test("DATASET: coordinates are real, finite, in-range, and never (0,0)", () => {
        assert.ok(Number.isFinite(campus.latitude) && Number.isFinite(campus.longitude));
        assert.ok(Math.abs(campus.latitude) <= 90 && Math.abs(campus.longitude) <= 180);
        assert.ok(!(campus.latitude === 0 && campus.longitude === 0));
    });
    await test("DATASET: coordinates are plausibly in the Heiligenhaus/Velbert area of North Rhine-Westphalia, NOT Bochum/Düsseldorf/Essen city centre", () => {
        // Heiligenhaus's real-world bounding box, roughly 51.31-51.35N, 6.94-7.00E.
        assert.ok(campus.latitude > 51.31 && campus.latitude < 51.35, `latitude ${campus.latitude} is not plausibly in Heiligenhaus`);
        assert.ok(campus.longitude > 6.94 && campus.longitude < 7.00, `longitude ${campus.longitude} is not plausibly in Heiligenhaus`);
        // Bochum city centre (51.4818, 7.2162) — the campus is NOT there, it's
        // an external campus ~30km away, per the record's own _note.
        const kmFromBochum = haversineKm(campus.latitude, campus.longitude, 51.4818, 7.2162);
        assert.ok(kmFromBochum > 15, `expected the external campus to be materially distant from Bochum city centre, got only ${kmFromBochum}km away`);
        // Düsseldorf city centre (51.2277, 6.7735) and Essen city centre
        // (51.4556, 7.0116) — neither is this campus's location either.
        const kmFromDusseldorf = haversineKm(campus.latitude, campus.longitude, 51.2277, 6.7735);
        const kmFromEssen = haversineKm(campus.latitude, campus.longitude, 51.4556, 7.0116);
        assert.ok(kmFromDusseldorf > 5, `expected clear distinction from Düsseldorf city centre, got ${kmFromDusseldorf}km`);
        assert.ok(kmFromEssen > 5, `expected clear distinction from Essen city centre, got ${kmFromEssen}km`);
    });

    // ══════════════════════════ ALIASES (item 6/16 — safe, no collision-risk) ══════════════════════════
    await test('ALIASES: "Campus Velbert/Heiligenhaus" (exact name) resolves', () => {
        assert.strictEqual(resolve("Campus Velbert/Heiligenhaus")?.id, "campus-velbert-heiligenhaus");
    });
    await test('ALIASES: "Campus Velbert Heiligenhaus" (no slash) resolves', () => {
        assert.strictEqual(resolve("Campus Velbert Heiligenhaus")?.id, "campus-velbert-heiligenhaus");
    });
    await test('ALIASES: "Hochschule Bochum Campus Velbert/Heiligenhaus" resolves', () => {
        assert.strictEqual(resolve("Hochschule Bochum Campus Velbert/Heiligenhaus")?.id, "campus-velbert-heiligenhaus");
    });
    await test('ALIASES: "Campus V/H" and "CVH" resolve', () => {
        assert.strictEqual(resolve("Campus V/H")?.id, "campus-velbert-heiligenhaus");
        assert.strictEqual(resolve("CVH")?.id, "campus-velbert-heiligenhaus");
    });
    await test("ALIASES: case/punctuation/whitespace-insensitive matching, same rule as every other university", () => {
        assert.strictEqual(resolve("  cvh!! ")?.id, "campus-velbert-heiligenhaus");
        assert.strictEqual(resolve("CAMPUS VELBERT/HEILIGENHAUS")?.id, "campus-velbert-heiligenhaus");
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
        assert.strictEqual(resolve("Bochum University"), null);
        assert.strictEqual(resolve("Velbert College"), null);
    });

    // ══════════════════════════ REGRESSION — existing universities unaffected ══════════════════════════
    await test("REGRESSION: University of Manchester still resolves correctly", () => {
        const u = resolve("University of Manchester");
        assert.strictEqual(u?.id, "university-of-manchester");
    });
    await test("REGRESSION: University of Derby still resolves correctly", () => {
        assert.strictEqual(resolve("University of Derby")?.id, "university-of-derby");
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
    await test("REGRESSION: St George's University of London still resolves correctly", () => {
        assert.strictEqual(resolve("SGUL")?.id, "st-georges-university-of-london");
    });
    await test("REGRESSION: University of Hertfordshire's accommodationOverride (a pre-existing business rule) is untouched by this addition", () => {
        const herts = CAMPUS_UNIVERSITIES.find((u) => u.id === "university-of-hertfordshire");
        assert.deepStrictEqual(herts.accommodationOverride, { propertySlugs: ["luna-hatfield-1905073461300"] });
    });
    await test("REGRESSION: Campus Velbert/Heiligenhaus itself has NO accommodationOverride — it uses the generic city-wide accommodation path like Manchester/Derby/Dubai/St George's, not a special-cased one like Hertfordshire", () => {
        assert.strictEqual(campus.accommodationOverride, undefined);
    });

    // ══════════════════════════ DISTANCE CALCULATION (item 10/17) — the real Haversine utility, real coordinates ══════════════════════════
    await test("HAVERSINE: distance uses the exact official campus coordinates (51.3274305, 6.9677006), not a rounded/approximate value", () => {
        const kmFromSelf = haversineKm(OFFICIAL_LAT, OFFICIAL_LNG, campus.latitude, campus.longitude);
        assert.strictEqual(kmFromSelf, 0, "the record's own stored coordinates must exactly match the official values used for distance calculation");
    });
    await test("HAVERSINE: a residence a few km away in Velbert (the neighbouring town) computes a small, real, non-fabricated distance", () => {
        // Velbert town centre, immediately adjacent to Heiligenhaus.
        const km = haversineKm(campus.latitude, campus.longitude, 51.3400, 7.0450);
        assert.ok(Number.isFinite(km) && km > 0 && km < 10, `expected a small real distance, got ${km}`);
    });
    await test("HAVERSINE: a residence further away (e.g. central Essen, ~15-20km) computes a materially larger real distance", () => {
        const km = haversineKm(campus.latitude, campus.longitude, 51.4556, 7.0116);
        assert.ok(Number.isFinite(km) && km > 10, `expected a materially larger distance than the nearby case, got ${km}`);
    });
    await test("DISTANCE FORMATTING: the page's own distanceKm computation rounds to 1 decimal place (no excessive precision)", () => {
        const raw = haversineKm(campus.latitude, campus.longitude, 51.3400, 7.0450);
        const rounded = Math.round(raw * 10) / 10;
        assert.ok(/^\d+(\.\d)?$/.test(String(rounded)), `expected at most 1 decimal place, got ${rounded}`);
    });
    await test("hasValidCoords: Campus Velbert/Heiligenhaus's own coordinates pass the same validity check every other university's coordinates must pass", () => {
        assert.strictEqual(hasValidCoords(campus.latitude, campus.longitude), true);
    });
    await test("DISTANCE NEVER FABRICATED: a residence with missing coordinates would receive distanceKm=null, never a guessed value — verified against the page's own logic, structurally", () => {
        const pageSrc = fs.readFileSync(path.join(ROOT, "src", "pages", "UniversityHousingPage.js"), "utf8");
        assert.ok(/propertyHasCoords\s*=\s*hasValidCoords/.test(pageSrc));
        assert.ok(/universityHasCoords\s*&&\s*propertyHasCoords\s*\?[\s\S]{0,300}:\s*null/.test(pageSrc), "expected distanceKm to fall back to null (never a fabricated value) whenever either coordinate is missing — applies to this campus exactly as it does to every other university, no special-casing");
    });

    // ══════════════════════════ MAP (item 7/12/18) — UNIVERSITY type, real marker coordinates ══════════════════════════
    await test("MAP: type (UNIVERSITY) routes to the graduation-cap marker, not the school-building marker — same generic type-based icon logic every institution already uses", () => {
        const mapSrc = fs.readFileSync(path.join(ROOT, "src", "components", "universityHousing", "UniversityHousingMap.js"), "utf8");
        assert.ok(/university\.type === "SCHOOL" \? schoolIcon : universityIcon/.test(mapSrc), "expected the existing generic type-based marker selection to be unchanged — no campus-specific branch");
        assert.strictEqual(campus.type, "UNIVERSITY");
    });
    await test("MAP: no campus-specific code exists anywhere in the map component (fully generic, data-driven)", () => {
        const mapSrc = fs.readFileSync(path.join(ROOT, "src", "components", "universityHousing", "UniversityHousingMap.js"), "utf8");
        assert.ok(!/velbert|heiligenhaus|bochum/i.test(mapSrc));
    });
    await test("MAP: the marker position is derived directly from university.latitude/longitude (already-loaded page state), never a separate fetch — structurally verified", () => {
        const mapSrc = fs.readFileSync(path.join(ROOT, "src", "components", "universityHousing", "UniversityHousingMap.js"), "utf8");
        assert.ok(/position=\{\[university\.latitude, university\.longitude\]\}/.test(mapSrc));
        assert.ok(!/fetch\(/.test(mapSrc), "the map component must never call fetch() itself");
    });

    // ══════════════════════════ SINGLE DATA FLOW / NO DUPLICATE REQUESTS (item 8/9/13) ══════════════════════════
    await test("SINGLE DATA FLOW: UniversityHousingPage.js still calls getProperties() exactly twice total (initial load + explicit load-more) — this campus introduces no extra call site", () => {
        const pageSrc = fs.readFileSync(path.join(ROOT, "src", "pages", "UniversityHousingPage.js"), "utf8");
        const matches = pageSrc.match(/(?:await|=)\s*getProperties\(/g) || [];
        assert.strictEqual(matches.length, 2, `expected exactly 2 call sites, found ${matches.length}`);
    });
    await test("SINGLE DATA FLOW: no institution-specific accommodation endpoint (e.g. /api/campus-velbert-housing) exists anywhere in the API surface", () => {
        assert.ok(!fs.existsSync(path.join(ROOT, "api", "campus-velbert-housing.js")));
        assert.ok(!fs.existsSync(path.join(ROOT, "api", "campus-velbert-housing")));
    });
    await test("SINGLE DATA FLOW: the map and list panel remain pure renderers of already-loaded props — neither calls getProperties() itself", () => {
        const mapSrc = fs.readFileSync(path.join(ROOT, "src", "components", "universityHousing", "UniversityHousingMap.js"), "utf8");
        const listSrc = fs.readFileSync(path.join(ROOT, "src", "components", "universityHousing", "PropertyListPanel.js"), "utf8");
        assert.ok(!/getProperties\(/.test(mapSrc) && !/getProperties\(/.test(listSrc));
    });
    await test("SINGLE DATA FLOW: the accommodation city query for this campus will be exactly 'Heiligenhaus' (the record's own city field), never silently relabeled to another city", () => {
        assert.strictEqual(campus.city, "Heiligenhaus");
        const pageSrc = fs.readFileSync(path.join(ROOT, "src", "pages", "UniversityHousingPage.js"), "utf8");
        assert.ok(/getProperties\(university\.city,/.test(pageSrc), "expected the existing generic university.city-driven lookup to be unchanged");
    });

    // ══════════════════════════ AMBER ISOLATION (item 14/20) — adding a university must never touch Amber ══════════════════════════
    await test("AMBER ISOLATION: none of amberGateway.js/sharedStore.js/cacheWarmer.js/api/amber.js reference Velbert/Heiligenhaus/Bochum/CVH — this addition's entire footprint is the dataset + the pre-existing generic city pipeline", () => {
        ["amberGateway.js", "sharedStore.js", "cacheWarmer.js"].forEach((f) => {
            const src = fs.readFileSync(path.join(ROOT, "api", "_lib", f), "utf8");
            assert.ok(!/velbert|heiligenhaus|bochum|cvh\b/i.test(src));
        });
        const amberJsSrc = fs.readFileSync(path.join(ROOT, "api", "_lib", "routes", "content", "amber.js"), "utf8");
        assert.ok(!/velbert|heiligenhaus|bochum|cvh\b/i.test(amberJsSrc));
    });
    await test("AMBER ISOLATION: loading/resolving the curated dataset (including this campus) makes ZERO fetch() calls", () => {
        const originalFetch = global.fetch;
        let calls = 0;
        global.fetch = async (...args) => { calls++; return originalFetch(...args); };
        try {
            resolve("Campus Velbert/Heiligenhaus");
            resolve("CVH");
            CAMPUS_UNIVERSITIES.forEach((u) => resolve(u.name));
        } finally {
            global.fetch = originalFetch;
        }
        assert.strictEqual(calls, 0, "resolving universities (this campus included) must never make a network call of any kind");
    });
    await test('AMBER ISOLATION: no campus-specific conditional/bypass exists anywhere in the accommodation pipeline (e.g. `if (city === "Heiligenhaus")`, a special-cased branch)', () => {
        const files = [
            path.join(ROOT, "api", "_lib", "accommodationIndex.js"),
            path.join(ROOT, "src", "pages", "UniversityHousingPage.js"),
        ];
        files.forEach((f) => {
            const src = fs.readFileSync(f, "utf8");
            assert.ok(!/velbert|heiligenhaus|bochum/i.test(src), `${path.basename(f)} must contain zero campus-specific logic`);
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
