#!/usr/bin/env node
// University of Hertfordshire accommodation-override verification: proves
// the explicit business rule ("University of Hertfordshire + Hatfield ->
// Luna Hatfield ONLY, never a generic city search") is correctly wired end
// to end, and — just as importantly — that it does NOT leak into the
// ordinary city-search path a student browsing Hatfield without selecting
// this university would still get.
//
// MONGODB: almost every test below exercises ONLY the override path
// (api/_lib/accommodationIndex.js's getOverrideResidences()), which by
// design never calls connectToDatabase()/reads or writes Mongo at all — see
// that function's own header comment. The couple of tests that deliberately
// exercise the GENERIC city-search path (getCityResidences, which DOES touch
// Mongo) for contrast are gated behind the exact same "database name must
// contain 'test'" guard verify-planner-accommodation-index.js already uses,
// and clean up every document they create — calling that path with this
// script's mocked Amber responses would otherwise write fake residence data
// into whatever real database MONGODB_URI happens to point at.
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");

require("dotenv").config({ path: path.join(ROOT, ".env.local") });
require("dotenv").config({ path: path.join(ROOT, ".env") });
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

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

const LUNA_SLUG = "luna-hatfield-1905073461300";

function makeAmberItem(id, name, canonicalName, overrides = {}) {
    return {
        id,
        name,
        canonical_name: canonicalName,
        available: true,
        location: { locality: { long_name: "Hatfield" }, country: { long_name: "United Kingdom" } },
        location_coordinates: { lat: 51.7603394, lng: -0.2447736 },
        pricing: { min_price: 245, currency: "pound", duration: "weekly" },
        meta: { distances: [{ place: "City Centre", distance: "0.8 km" }], unit_types: ["studio"] },
        ...overrides,
    };
}

function amberResponse(items) {
    return { message: "success", data: { result: items, meta: { count: items.length } } };
}

async function main() {
    console.log("=== IvyHuts University of Hertfordshire Accommodation Override Verification ===\n");

    const UNIVERSITIES_FRONTEND = require(path.join(ROOT, "src", "data", "universities.json"));
    const UNIVERSITIES_BACKEND = require(path.join(ROOT, "api", "_lib", "universities.json"));
    const CAMPUS_UNIVERSITIES = require(path.join(ROOT, "src", "data", "campusUniversities.json"));
    const { resolveUniversityById } = require(path.join(ROOT, "api", "_lib", "universityResolver"));
    const { getOverrideResidences } = require(path.join(ROOT, "api", "_lib", "accommodationIndex"));
    const plannerHandler = require(path.join(ROOT, "api", "student-planner"));

    // ── Mocked Amber: distinguishes a "detail" (canonical_name) call from a
    // "listings" (location_place_name) call, unlike the shared mock in
    // verify-planner-accommodation-index.js — needed here specifically to
    // prove the override path only EVER makes detail-type calls, never a
    // listings/city-search call. ──
    let detailCallCount = 0;
    let listingsCallCount = 0;
    const detailCallSlugs = [];
    const originalFetch = global.fetch;
    global.fetch = async (url) => {
        if (typeof url === "string" && url.includes("amberstudent.com")) {
            const u = new URL(url);
            if (u.searchParams.has("canonical_name")) {
                detailCallCount++;
                const slug = u.searchParams.get("canonical_name");
                detailCallSlugs.push(slug);
                if (slug === LUNA_SLUG) {
                    const item = makeAmberItem(144688, "Luna, Hatfield", LUNA_SLUG);
                    return { ok: true, status: 200, json: async () => amberResponse([item]) };
                }
                // An unknown/unmapped slug -> Amber legitimately returns nothing,
                // same as a stale or mistyped canonical_name would in production.
                return { ok: true, status: 200, json: async () => amberResponse([]) };
            }
            // A listings-type (city-search) call — deliberately returns OTHER
            // Hatfield properties, never Luna Hatfield, so any test that sees
            // one of THESE names leak into an override response would fail loudly.
            listingsCallCount++;
            const items = [
                makeAmberItem(9001, "Generic Hatfield House 1", "generic-hatfield-house-1"),
                makeAmberItem(9002, "Generic Hatfield House 2", "generic-hatfield-house-2"),
            ];
            return { ok: true, status: 200, json: async () => amberResponse(items) };
        }
        return originalFetch(url);
    };

    function makeMockRes() {
        return { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    }
    async function runPlannerHandler(query) {
        const res = makeMockRes();
        await plannerHandler({ method: "GET", query }, res);
        return res;
    }

    // ══════════════════════════ DATASET ══════════════════════════
    for (const [label, dataset] of [["src/data/universities.json", UNIVERSITIES_FRONTEND], ["api/_lib/universities.json", UNIVERSITIES_BACKEND], ["src/data/campusUniversities.json", CAMPUS_UNIVERSITIES]]) {
        await test(`DATASET (${label}): University of Hertfordshire has an accommodationOverride restricting it to exactly Luna Hatfield`, () => {
            const u = dataset.find((x) => x.id === "university-of-hertfordshire");
            assert.ok(u, "university-of-hertfordshire not found");
            assert.deepStrictEqual(u.accommodationOverride, { propertySlugs: [LUNA_SLUG] });
        });
        await test(`DATASET (${label}): no other university carries an accommodationOverride (existing records unchanged)`, () => {
            const others = dataset.filter((x) => x.id !== "university-of-hertfordshire" && x.accommodationOverride !== undefined);
            assert.deepStrictEqual(others.map((u) => u.id), [], "no pre-existing university should have gained an override as a side effect");
        });
    }

    // ══════════════════════════ getOverrideResidences() — real function ══════════════════════════
    const herts = { latitude: 51.7515, longitude: -0.2393 };
    await test("OVERRIDE: resolves the real Luna Hatfield property via the SAME Amber detail/canonical_name path PropertyDetailPage.js uses", async () => {
        const before = detailCallCount;
        const result = await getOverrideResidences([LUNA_SLUG], { city: "Hatfield", university: herts, source: "verify-override" });
        assert.strictEqual(result.status, "ready");
        assert.strictEqual(result.residences.length, 1);
        assert.strictEqual(result.residences[0].name, "Luna, Hatfield");
        assert.strictEqual(result.residences[0].id, "144688");
        assert.strictEqual(detailCallCount - before, 1, "expected exactly one detail-type Amber call, for the one configured slug");
        assert.strictEqual(detailCallSlugs[detailCallSlugs.length - 1], LUNA_SLUG);
    });
    await test("OVERRIDE: never makes a listings/city-search Amber call — structurally incapable of pulling in another Hatfield property", async () => {
        const before = listingsCallCount;
        await getOverrideResidences([LUNA_SLUG], { city: "Hatfield", university: herts, source: "verify-override-2" });
        assert.strictEqual(listingsCallCount, before, "getOverrideResidences must never trigger a listings-type Amber call");
    });
    await test("OVERRIDE: computes a real Haversine distance from the university's coordinates (never fabricated, never omitted when both sides have real coordinates)", async () => {
        const result = await getOverrideResidences([LUNA_SLUG], { city: "Hatfield", university: herts, source: "verify-override-distance" });
        assert.ok(Number.isFinite(result.residences[0].distanceKm), "expected a real computed distance");
        assert.ok(result.residences[0].distanceKm < 5, `Luna Hatfield is genuinely close to the university campus, got ${result.residences[0].distanceKm}km`);
    });
    await test("OVERRIDE: an unresolvable/unknown slug degrades to status:building, residences:[], never throws (never fabricates a substitute property)", async () => {
        const result = await getOverrideResidences(["not-a-real-slug-xyz"], { city: "Hatfield", university: herts, source: "verify-override-bad-slug" });
        assert.strictEqual(result.status, "building");
        assert.deepStrictEqual(result.residences, []);
    });
    await test("OVERRIDE: a mixed list (one real, one bad slug) still returns only the real property — never a partial/fake entry for the bad one", async () => {
        const result = await getOverrideResidences([LUNA_SLUG, "not-a-real-slug-xyz"], { city: "Hatfield", university: herts, source: "verify-override-mixed" });
        assert.strictEqual(result.status, "ready");
        assert.strictEqual(result.residences.length, 1);
        assert.strictEqual(result.residences[0].name, "Luna, Hatfield");
    });

    // ══════════════════════════ END-TO-END: api/student-planner.js ══════════════════════════
    await test("END-TO-END: selecting University of Hertfordshire (no city typed) returns Luna Hatfield ONLY — never the generic Hatfield listings", async () => {
        const res = await runPlannerHandler({ universityId: "university-of-hertfordshire" });
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.body.ok, true);
        assert.strictEqual(res.body.status, "ready");
        assert.strictEqual(res.body.residences.length, 1, "must be exactly one property, not a ranked shortlist");
        assert.strictEqual(res.body.residences[0].name, "Luna, Hatfield");
        assert.deepStrictEqual(res.body.comparison, res.body.residences);
        const names = res.body.residences.map((r) => r.name);
        assert.ok(!names.includes("Generic Hatfield House 1") && !names.includes("Generic Hatfield House 2"), "no generic city-search result may leak into the override response");
    });
    await test("END-TO-END: explicitly supplying city=Hatfield alongside the university still returns Luna Hatfield only (university identity wins, not a coincidental city match)", async () => {
        const res = await runPlannerHandler({ universityId: "university-of-hertfordshire", city: "Hatfield" });
        assert.strictEqual(res.body.residences.length, 1);
        assert.strictEqual(res.body.residences[0].name, "Luna, Hatfield");
    });
    // ══════════════════════════ MONGO-DEPENDENT: generic path, for contrast ══════════════════════════
    // Only runs against a database whose name contains "test" (same gate as
    // verify-planner-accommodation-index.js) — getCityResidences() writes to
    // real Mongo collections, and this script's mocked Amber responses must
    // never land in a real/shared database. Every document created here is
    // deleted again before this script exits, success or failure.
    function getDbNameFromUri(uri) {
        const match = /\/([^/?]+)(\?|$)/.exec(uri.replace(/^mongodb(\+srv)?:\/\//, "mongodb://").split("@").pop());
        return match ? match[1] : "";
    }
    const MONGODB_URI = process.env.MONGODB_URI;
    const dbName = MONGODB_URI ? getDbNameFromUri(MONGODB_URI) : "";
    const looksLikeTestDb = /test/i.test(dbName);
    if (!MONGODB_URI || (!looksLikeTestDb && process.env.ALLOW_MONGODB_LIVE_TEST !== "true")) {
        console.log(`\nSkipping the two Mongo-dependent contrast tests (generic-city-search-is-unaffected) — MONGODB_URI is ${MONGODB_URI ? `"${dbName}", which doesn't look like a test database` : "not set"}. Point MONGODB_URI at a database whose name contains \"test\", or set ALLOW_MONGODB_LIVE_TEST=true.`);
    } else {
        const { connectToDatabase, disconnectFromDatabase } = require(path.join(ROOT, "api", "_lib", "mongodb"));
        const AccommodationResidence = require(path.join(ROOT, "api", "_lib", "models", "AccommodationResidence"));
        const AccommodationIndexMeta = require(path.join(ROOT, "api", "_lib", "models", "AccommodationIndexMeta"));
        await connectToDatabase();
        const testCities = ["hatfield-override-verify", "manchester-override-verify"];

        await test("END-TO-END (Mongo): browsing an ordinary city WITHOUT selecting the university is a normal, unrestricted city search (the business rule is university-specific, not a blanket restriction)", async () => {
            const res = await runPlannerHandler({ city: testCities[0] });
            const names = (res.body.residences || []).map((r) => r.name);
            assert.ok(names.includes("Generic Hatfield House 1"), "the generic city search must see the full, unrestricted mocked inventory");
        });
        await test("END-TO-END (Mongo): an unrelated university with no override is completely unaffected — normal city search, Luna Hatfield never appears", async () => {
            const res = await runPlannerHandler({ universityId: "university-of-manchester", city: testCities[1] });
            const names = (res.body.residences || []).map((r) => r.name);
            assert.ok(names.length > 0 && !names.includes("Luna, Hatfield"), "Luna Hatfield must never appear for a university it wasn't configured for");
        });

        await AccommodationResidence.deleteMany({ city: { $in: testCities } });
        await AccommodationIndexMeta.deleteMany({ city: { $in: testCities } });
        const remaining = await AccommodationResidence.countDocuments({ city: { $in: testCities } });
        await test("CLEANUP: Mongo-dependent contrast tests left no residual test documents", () => {
            assert.strictEqual(remaining, 0);
        });
        await disconnectFromDatabase();
    }

    // ══════════════════════════ STRUCTURAL: generic path is untouched ══════════════════════════
    const accommodationIndexSrc = fs.readFileSync(path.join(ROOT, "api", "_lib", "accommodationIndex.js"), "utf8");
    await test("STRUCTURAL: getCityResidences() (the generic city-search path) has zero awareness of accommodationOverride/propertySlugs — the business rule lives entirely in the new, separate getOverrideResidences()", () => {
        const fnStart = accommodationIndexSrc.indexOf("async function getCityResidences");
        const fnBody = accommodationIndexSrc.slice(fnStart, accommodationIndexSrc.indexOf("\nmodule.exports", fnStart));
        assert.ok(fnStart !== -1, "getCityResidences not found");
        assert.ok(!/accommodationOverride|propertySlugs/.test(fnBody), "the generic city-search function must not reference the override concept at all");
    });
    await test("STRUCTURAL: getOverrideResidences() never calls connectToDatabase() — the override path is provably Mongo-free", () => {
        const fnStart = accommodationIndexSrc.indexOf("async function getOverrideResidences");
        const fnBody = accommodationIndexSrc.slice(fnStart, accommodationIndexSrc.indexOf("\n// The planner's one entry point", fnStart));
        assert.ok(fnStart !== -1, "getOverrideResidences not found");
        assert.ok(!/connectToDatabase/.test(fnBody));
    });
    await test("STRUCTURAL: api/student-planner.js trusts the resolved university's own accommodationOverride, never a client-supplied override param", () => {
        const src = fs.readFileSync(path.join(ROOT, "api", "student-planner.js"), "utf8");
        assert.ok(/university\?\.accommodationOverride\?\.propertySlugs/.test(src));
        assert.ok(!req_query_has_override(src), "must never read an override list directly from req.query");
        function req_query_has_override(s) { return /req\.query[^;]*(override|propertySlugs)/i.test(s); }
    });

    // ══════════════════════════ FRONTEND: University Housing page ══════════════════════════
    const pageSrc = fs.readFileSync(path.join(ROOT, "src", "pages", "UniversityHousingPage.js"), "utf8");
    await test("FRONTEND: UniversityHousingPage.js uses getPropertyBySlug() (the existing per-property gateway function) for the override path, never a new fetch mechanism", () => {
        assert.ok(/getPropertyBySlug\(/.test(pageSrc));
        assert.ok(pageSrc.includes('import { getProperties, getPropertyBySlug, getCachedCityStats } from "../services/amberApi"'));
    });
    await test('FRONTEND: "Load more" is disabled when an override is active — a fixed exclusive list has no further pages', () => {
        assert.ok(/hasMore\s*=\s*!hasOverride\s*&&/.test(pageSrc));
        assert.ok(/if \(!university \|\| loadingMore \|\| hasOverride\) return;/.test(pageSrc));
    });

    global.fetch = originalFetch;

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
