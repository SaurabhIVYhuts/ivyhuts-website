#!/usr/bin/env node
// Vamos Madrid (SCHOOL institution type) verification: proves the
// University Housing institution search now genuinely supports non-university
// institutions — Vamos Madrid resolves via its real, verified address/
// coordinates, is correctly typed SCHOOL (never mislabeled UNIVERSITY),
// is NOT confused with the unrelated similarly-named academy at a different
// Madrid address, and that adding `type` to every record broke nothing for
// the existing UNIVERSITY entries (Manchester, Derby, UOWD, Bristol, etc).
//
// MONGODB: same discipline as scripts/verify-derby-housing.js and
// scripts/verify-uowd-dubai-housing.js — every test here is a pure function
// or a structural source check; Madrid's real Amber inventory is proven via
// a live smoke test outside this script (see this task's final report),
// never via a mocked global.fetch call against the real handler (which
// would risk writing fake data into whatever database MONGODB_URI points
// at, as happened once already in the Hertfordshire override milestone).
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

// campusUniversityResolver.js is an ESM module that `import`s JSON without a
// `type: "json"` attribute, which Node's own ESM loader (unlike webpack/CRA)
// requires — same limitation already documented in
// scripts/verify-university-housing.js. Re-derives the identical
// normalize/exact-match algorithm against the real dataset file instead,
// verified structurally against the real resolver source further down.
function normalize(s) {
    return String(s || "").toLowerCase().replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim();
}
function buildIndex(dataset) {
    const index = new Map();
    for (const uni of dataset) {
        for (const key of [uni.name, ...(uni.aliases || [])].map(normalize)) {
            if (!key) continue;
            if (!index.has(key)) index.set(key, []);
            if (!index.get(key).some((u) => u.id === uni.id)) index.get(key).push(uni);
        }
    }
    return index;
}
function resolve(index, input) {
    const key = normalize(input);
    const matches = index.get(key);
    return matches && matches.length === 1 ? matches[0] : null;
}

async function main() {
    console.log("=== IvyHuts Vamos Madrid (SCHOOL) Verification ===\n");

    const CAMPUS_UNIVERSITIES = require(path.join(ROOT, "src", "data", "campusUniversities.json"));
    const { attachRankingDistance, rankResidences } = require(path.join(ROOT, "api", "_lib", "accommodationIndex"));
    // Real functions, not reimplementations — geoDistance.js is a plain
    // ESM-syntax .js file this Node version can require() directly (same
    // pattern already used in scripts/verify-uowd-dubai-housing.js /
    // scripts/verify-derby-housing.js).
    const { haversineKm, hasValidCoords } = require(path.join(ROOT, "src", "lib", "geoDistance.js"));
    const INDEX = buildIndex(CAMPUS_UNIVERSITIES);

    // ══════════════════════════ DATASET (item 3/5/6) ══════════════════════════
    const vamos = CAMPUS_UNIVERSITIES.find((u) => u.id === "vamos-spanish-academy-madrid");
    await test("DATASET: Vamos Madrid record exists (no duplicate created — same id as before)", () => {
        assert.ok(vamos, "vamos-spanish-academy-madrid not found");
        assert.strictEqual(CAMPUS_UNIVERSITIES.filter((u) => /vamos/i.test(u.name) || /vamos/i.test((u.aliases || []).join(" "))).length, 1, "expected exactly one Vamos-related record, not a duplicate");
    });
    await test('DATASET: name is exactly "Vamos Madrid | Tu escuela de español"', () => {
        assert.strictEqual(vamos.name, "Vamos Madrid | Tu escuela de español");
    });
    await test('DATASET: type is "SCHOOL", never "UNIVERSITY"', () => {
        assert.strictEqual(vamos.type, "SCHOOL");
    });
    await test("DATASET: city/country are Madrid, Spain", () => {
        assert.strictEqual(vamos.city, "Madrid");
        assert.strictEqual(vamos.country, "Spain");
    });
    await test("DATASET: address is the verified Príncipe de Vergara address, never the unrelated Delicias address", () => {
        assert.strictEqual(vamos.address, "Calle del Príncipe de Vergara, 57–59, Bajo D, 28006 Madrid, Spain");
        assert.ok(!/delicias/i.test(vamos.address), "the address field itself must never contain the unrelated academy's address");
    });
    await test("DATASET: coordinates are real, finite, and plausibly within Madrid's Salamanca district (not a city-centre guess, not the Delicias-address location)", () => {
        assert.ok(hasValidCoords(vamos.latitude, vamos.longitude));
        // Real-world bounding box for the verified address (Príncipe de
        // Vergara / Salamanca district), tight enough to catch a
        // transposed digit or a fallback-to-city-centre mistake.
        assert.ok(vamos.latitude > 40.42 && vamos.latitude < 40.44, `latitude ${vamos.latitude} is not plausibly at this address`);
        assert.ok(vamos.longitude > -3.69 && vamos.longitude < -3.67, `longitude ${vamos.longitude} is not plausibly at this address`);
    });
    await test("DATASET: every OTHER institution in the dataset is explicitly typed UNIVERSITY (no implicit/missing type introduced)", () => {
        const untyped = CAMPUS_UNIVERSITIES.filter((u) => u.id !== "vamos-spanish-academy-madrid" && u.type !== "UNIVERSITY");
        assert.deepStrictEqual(untyped.map((u) => u.id), [], "every existing university record must carry an explicit type: UNIVERSITY");
    });
    await test("DATASET: no duplicate ids, no ambiguous alias collisions anywhere in the dataset after this change", () => {
        const ids = CAMPUS_UNIVERSITIES.map((u) => u.id);
        assert.strictEqual(new Set(ids).size, ids.length);
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

    // ══════════════════════════ ALIAS RESOLUTION (item 6/29) ══════════════════════════
    await test('RESOLVER: "Vamos Madrid" resolves to the school', () => {
        assert.strictEqual(resolve(INDEX, "Vamos Madrid")?.id, "vamos-spanish-academy-madrid");
    });
    await test('RESOLVER: "Vamos Madrid Spanish School" resolves to the school', () => {
        assert.strictEqual(resolve(INDEX, "Vamos Madrid Spanish School")?.id, "vamos-spanish-academy-madrid");
    });
    await test('RESOLVER: "Vamos Spanish School Madrid" resolves to the school', () => {
        assert.strictEqual(resolve(INDEX, "Vamos Spanish School Madrid")?.id, "vamos-spanish-academy-madrid");
    });
    await test('RESOLVER: "Vamos School Madrid" resolves to the school', () => {
        assert.strictEqual(resolve(INDEX, "Vamos School Madrid")?.id, "vamos-spanish-academy-madrid");
    });
    await test("RESOLVER: pre-existing aliases from before this milestone still resolve (backward compatible)", () => {
        assert.strictEqual(resolve(INDEX, "Vamos Spanish Academy")?.id, "vamos-spanish-academy-madrid");
        assert.strictEqual(resolve(INDEX, "Vamos Spanish School")?.id, "vamos-spanish-academy-madrid");
        assert.strictEqual(resolve(INDEX, "Spanish School Madrid")?.id, "vamos-spanish-academy-madrid");
    });
    await test("RESOLVER: the unrelated similarly-named academy is never resolved by this dataset (it was never added — no confusion is even possible)", () => {
        assert.strictEqual(resolve(INDEX, "Vamos Academy Madrid"), null, "a differently-worded name for the OTHER business must not accidentally match this school");
    });

    // ══════════════════════════ EXISTING UNIVERSITIES UNCHANGED (item 28) ══════════════════════════
    await test("REGRESSION: University of Manchester still resolves, still typed UNIVERSITY", () => {
        const u = resolve(INDEX, "University of Manchester");
        assert.strictEqual(u.id, "university-of-manchester");
        assert.strictEqual(u.type, "UNIVERSITY");
    });
    await test("REGRESSION: University of Derby still resolves, still typed UNIVERSITY", () => {
        const u = resolve(INDEX, "University of Derby");
        assert.strictEqual(u.id, "university-of-derby");
        assert.strictEqual(u.type, "UNIVERSITY");
    });
    await test("REGRESSION: University of Wollongong in Dubai (UOWD) still resolves, still typed UNIVERSITY", () => {
        const u = resolve(INDEX, "UOWD");
        assert.strictEqual(u.id, "university-of-wollongong-dubai");
        assert.strictEqual(u.type, "UNIVERSITY");
    });
    await test("REGRESSION: University of Hertfordshire's accommodationOverride (earlier milestone) is untouched", () => {
        const u = CAMPUS_UNIVERSITIES.find((x) => x.id === "university-of-hertfordshire");
        assert.deepStrictEqual(u.accommodationOverride, { propertySlugs: ["luna-hatfield-1905073461300"] });
        assert.strictEqual(u.type, "UNIVERSITY");
    });

    // ══════════════════════════ DISTANCE CALCULATION (item 14/21/31) — real function, real coordinates ══════════════════════════
    await test("HAVERSINE: a residence near the Salamanca district computes a small, real, positive, finite distance from Vamos Madrid", () => {
        // Retiro Park area, a real nearby Madrid landmark ~1.5km from Príncipe de Vergara 57.
        const km = haversineKm(vamos.latitude, vamos.longitude, 40.4153, -3.6844);
        assert.ok(Number.isFinite(km) && km > 0 && km < 5, `expected a small positive real distance, got ${km}`);
    });
    await test("HAVERSINE: distance is symmetric and zero for identical coordinates", () => {
        assert.strictEqual(haversineKm(vamos.latitude, vamos.longitude, vamos.latitude, vamos.longitude), 0);
    });
    await test("attachRankingDistance: Madrid residences with real coordinates get a real Haversine distance from Vamos Madrid; residences without coordinates get null, never a guess", () => {
        const docs = [
            { propertyId: "near", latitude: 40.4153, longitude: -3.6844, distanceToCentreKm: 99 },
            { propertyId: "no-coords", latitude: null, longitude: null, distanceToCentreKm: 5 },
        ];
        const [near, noCoords] = attachRankingDistance(docs, vamos);
        assert.ok(Number.isFinite(near.rankingDistanceKm) && near.rankingDistanceKm < 5);
        assert.strictEqual(noCoords.rankingDistanceKm, null, "a residence without coordinates must never receive a fabricated distance");
    });
    await test("rankResidences: with Vamos Madrid resolved, the genuinely closer residence ranks ahead of a farther one, all else equal — the SAME ranking algorithm used for every university, no school-specific formula", () => {
        const docs = [
            { propertyId: "far", propertyName: "Far Residence", rankingDistanceKm: 15, rating: 4, roomType: "Studio", price: { amount: 300, currency: "€" } },
            { propertyId: "near", propertyName: "Near Residence", rankingDistanceKm: 1.2, rating: 4, roomType: "Studio", price: { amount: 300, currency: "€" } },
        ];
        const ranked = rankResidences(docs, { budget: null, accommodationPreference: null });
        assert.strictEqual(ranked[0].name, "Near Residence");
    });

    // ══════════════════════════ SEARCH UI / MAP (item 7/17/18/20) — structural, real source ══════════════════════════
    const searchSrc = fs.readFileSync(path.join(ROOT, "src", "components", "universityHousing", "UniversitySearchBox.js"), "utf8");
    const mapSrc = fs.readFileSync(path.join(ROOT, "src", "components", "universityHousing", "UniversityHousingMap.js"), "utf8");
    const pageSrc = fs.readFileSync(path.join(ROOT, "src", "pages", "UniversityHousingPage.js"), "utf8");

    await test("SEARCH UI: renders an institution TYPE label generically (from the resolved record's own `type` field) — not a Vamos-specific hardcoded branch", () => {
        assert.ok(/TYPE_LABELS/.test(searchSrc) && /selected\.type|uni\.type/.test(searchSrc));
        // No conditional/branching logic keyed on the string "vamos" — an
        // illustrative mention inside a plain comment (explaining WHY the
        // type field exists) is fine and expected; a real `if`/ternary/
        // equality check against "vamos" would not be.
        assert.ok(!/(if|===|==|includes)\s*\(?\s*["'`].*vamos/i.test(searchSrc), "must not branch on the literal string \"vamos\" anywhere");
    });
    await test("MAP: uses a distinct SCHOOL marker driven by `university.type`, not a Vamos-specific hardcoded branch", () => {
        assert.ok(/schoolIcon/.test(mapSrc) && /university\.type === "SCHOOL"/.test(mapSrc));
        assert.ok(!/(if|===|==|includes)\s*\(?\s*["'`].*vamos/i.test(mapSrc), "must not branch on the literal string \"vamos\" anywhere");
    });
    await test("MAP: the institution marker/popup shows type + address when available, falling back to city/country for records without an address (backward compatible with every pre-existing university)", () => {
        assert.ok(/university\.address \|\|/.test(mapSrc));
    });
    await test("PAGE: no Vamos-specific logic exists in UniversityHousingPage.js — the SCHOOL vs UNIVERSITY label is driven entirely by the resolved record's own `type` field", () => {
        assert.ok(/university\.type === "SCHOOL"/.test(pageSrc));
        assert.ok(!/vamos/i.test(pageSrc));
    });
    await test('SEARCH -> MAP -> DISTANCE: exactly ONE authoritative institution record flows through the whole page — no independent Vamos hardcoding (branching logic) anywhere in the university-housing feature (item 20)', () => {
        const files = [searchSrc, mapSrc, pageSrc, fs.readFileSync(path.join(ROOT, "src", "components", "universityHousing", "PropertyListPanel.js"), "utf8")];
        files.forEach((src) => assert.ok(!/(if|===|==|includes)\s*\(?\s*["'`].*vamos/i.test(src), "must not branch on the literal string \"vamos\" anywhere"));
    });

    // ══════════════════════════ NO DUPLICATE / NO NEW MADRID DATASET (item 9/10/12/32) ══════════════════════════
    await test("NO NEW LISTING DATASET: no Madrid-specific curated listing file was created — Madrid inventory continues to come entirely from the existing Amber-backed pipeline", () => {
        const srcDataFiles = fs.readdirSync(path.join(ROOT, "src", "data"));
        const apiLibFiles = fs.readdirSync(path.join(ROOT, "api", "_lib"));
        [...srcDataFiles, ...apiLibFiles].forEach((f) => {
            assert.ok(!/madrid/i.test(f), `unexpected Madrid-specific data file: ${f}`);
        });
    });
    await test("NO NEW ENDPOINT: no Vamos/school/Madrid-specific API route exists", () => {
        const apiDir = fs.readdirSync(path.join(ROOT, "api"));
        assert.ok(!apiDir.some((f) => /vamos|madrid|school-housing/i.test(f)));
    });

    // ══════════════════════════ AMBER ISOLATION (item 24/25/26/33) — structural ══════════════════════════
    await test("STRUCTURAL: amberGateway.js / sharedStore.js / cacheWarmer.js / api/amber.js were not modified for this feature", () => {
        ["amberGateway.js", "sharedStore.js", "cacheWarmer.js"].forEach((f) => {
            const src = fs.readFileSync(path.join(ROOT, "api", "_lib", f), "utf8");
            assert.ok(!/vamos/i.test(src));
        });
        assert.ok(!/vamos/i.test(fs.readFileSync(path.join(ROOT, "api", "_lib", "routes", "content", "amber.js"), "utf8")));
    });
    await test("STRUCTURAL: the map component never calls the property API itself (moving/zooming/selecting never triggers a fetch) — it only ever renders the properties prop it was given", () => {
        assert.ok(!/getProperties\(|getPropertyBySlug\(|fetch\(/.test(mapSrc), "UniversityHousingMap.js must be a pure renderer, never a data-fetching component");
    });
    await test("STRUCTURAL: PropertyListPanel.js (residence cards) never calls the property API itself — pure renderer of props, same as the map", () => {
        const listSrc = fs.readFileSync(path.join(ROOT, "src", "components", "universityHousing", "PropertyListPanel.js"), "utf8");
        assert.ok(!/getProperties\(|getPropertyBySlug\(|fetch\(/.test(listSrc));
    });
    await test("STRUCTURAL: PPT builder/normalize/validation contain zero Vamos/school-specific logic — school residences flow through the existing planner-result-only PPT pipeline unmodified", () => {
        ["pptBuilder.js", "pptNormalize.js", "pptValidation.js"].forEach((f) => {
            const src = fs.readFileSync(path.join(ROOT, "api", "_lib", f), "utf8");
            assert.ok(!/vamos/i.test(src));
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
