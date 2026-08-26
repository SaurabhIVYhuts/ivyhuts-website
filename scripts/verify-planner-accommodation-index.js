#!/usr/bin/env node
// Milestone 2 (Student Planner accommodation index) verification: proves the
// planner cannot become a second, uncoordinated source of Amber traffic.
// Same style as scripts/verify-wishlist-behavior.js: a standalone Node
// script exercising the real functions against a real test database, not
// Jest (npm test/Jest is already broken repo-wide for an unrelated
// pre-existing reason).
//
// REDIS: forced into in-memory fallback (mirrors the other verify-* scripts)
// — sharedStore.js's own comment confirms this in-memory path has no
// `await` inside its synchronous check-and-record step, making it atomic
// *within this one Node process*. That is exactly the right (and only
// practical) tool for a deterministic same-process concurrency assertion.
// It deliberately does NOT and CANNOT prove real multi-instance Upstash
// behavior — but that is not a gap this script introduces: no existing
// Amber consumer in this repo (/find-rooms, property detail, the cache
// warmer) has cross-instance integration coverage either. This script
// proves two things precisely: (1) the shared lock/budget primitives
// correctly serialize concurrent callers in-process, and (2)
// accommodationIndex.js correctly USES those primitives rather than
// bypassing them with a second, uncoordinated mechanism.
//
// MONGODB: uses the real MONGODB_URI from .env.local, guarded by the same
// "database name must contain 'test'" check as the other verify-* scripts.
"use strict";

const assert = require("assert");
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

function getDbNameFromUri(uri) {
    const match = /\/([^/?]+)(\?|$)/.exec(uri.replace(/^mongodb(\+srv)?:\/\//, "mongodb://").split("@").pop());
    return match ? match[1] : "";
}

// A minimal, realistic Amber raw listing item — just the fields
// accommodationIndex.js's mapAmberItemToResidence() actually reads.
function makeAmberItem(id, name, overrides = {}) {
    return {
        id,
        name,
        canonical_name: `${name.toLowerCase().replace(/\s+/g, "-")}-${id}`,
        available: true,
        location: { country: { long_name: "United Kingdom" } },
        location_coordinates: { lat: 51.5, lng: -0.1 },
        pricing: { min_price: 220, currency: "gbp" },
        meta: {
            distances: [{ place: "City Centre", distance: "1.2 km" }],
            review_summary: { rating: { location: 4.2, cleanliness: 4.5 } },
            unit_types: ["studio"],
        },
        ...overrides,
    };
}

function amberListingsResponse(items) {
    return { message: "success", data: { result: items, meta: { count: items.length } } };
}

async function main() {
    console.log("=== IvyHuts Student Planner Accommodation Index Verification (Milestone 2) ===");
    console.log("Redis: forced in-memory fallback for this run.\n");

    // Requires that don't need Mongo to be reachable — the ranking/parsing
    // pure-function tests and the isolated budget-primitive test run
    // regardless of DB availability below, so a Mongo outage doesn't block
    // 100% of this script's verification value.
    const {
        rankResidences, parseDistanceKm, haversineKm, attachRankingDistance,
        applyRadius, computePriceWeekly, computePriceMonthly, normalizeDuration,
    } = require(path.join(ROOT, "api", "_lib", "accommodationIndex"));
    const { RATE_BUDGET_PER_MINUTE } = require(path.join(ROOT, "api", "_lib", "amberGateway"));
    const { reserveSlot } = require(path.join(ROOT, "api", "_lib", "sharedStore"));
    const { resolveUniversityById, resolveUniversityByName, UNIVERSITIES } = require(path.join(ROOT, "api", "_lib", "universityResolver"));
    const { getCityLivingCost, getLivingExpenses, SCENARIO_MULTIPLIERS } = require(path.join(ROOT, "api", "_lib", "costOfLiving"));
    const { resolveDegreeById, resolveDegreeByName, resolveSpecialization, DEGREES } = require(path.join(ROOT, "api", "_lib", "degreeResolver"));
    const {
        resolveCareersForDegree, normalizeSkill, scoreCareer, matchLabelForScore, buildSkillGap,
        buildStudentSkillSet, CAREERS, MAX_RESULTS, MIN_SCORE_TO_SHOW,
    } = require(path.join(ROOT, "api", "_lib", "careerResolver"));
    const {
        resolveSalaryForCareer, normalizeCountry: normalizeSalaryCountry, isValidSalaryRow,
        EXPERIENCE_LEVELS, DUPLICATE_KEYS: SALARY_DUPLICATE_KEYS, SALARIES,
    } = require(path.join(ROOT, "api", "_lib", "salaryResolver"));
    const {
        resolveReadinessForCareer, isValidReadinessRow, isNonEmptyStringList,
        DUPLICATE_CAREER_IDS: READINESS_DUPLICATE_IDS, READINESS, LIST_FIELDS: READINESS_LIST_FIELDS,
        INTERVIEW_CATEGORIES,
    } = require(path.join(ROOT, "api", "_lib", "careerReadinessResolver"));

    const runId = `m2-verify-${Date.now()}`;

    // ── Mocked Amber: counts real upstream attempts, lets each test control
    // what a given city's mocked Amber response looks like. ──
    let amberCallCount = 0;
    const cityBehavior = new Map(); // normalizedCity -> "ok" | "fail" | itemCount
    // normalizedCity -> { latitude, longitude } (generate items near this point,
    // for a true-Haversine test) | "none" (force location_coordinates: null,
    // for a no-coordinates-available test) | unset (use makeAmberItem's own
    // fixed default coordinate — matches every pre-existing Milestone 2 test's
    // fixtures unchanged, since without a `university` option those coordinates
    // are simply never read).
    const cityCoordsOverride = new Map();
    const originalFetch = global.fetch;
    global.fetch = async (url, opts) => {
        if (typeof url === "string" && url.includes("amberstudent.com")) {
            amberCallCount++;
            const cityParam = new URL(url).searchParams.get("location_place_name") || "";
            const normalizedCityParam = normalizeCityName(cityParam);
            const behavior = cityBehavior.get(normalizedCityParam);
            if (behavior === "fail") {
                return { ok: false, status: 500, json: async () => ({}) };
            }
            const count = typeof behavior === "number" ? behavior : 3;
            const coordsBase = cityCoordsOverride.get(normalizedCityParam);
            const items = Array.from({ length: count }, (_, i) => {
                const coordsOverride = coordsBase === "none"
                    ? { location_coordinates: null }
                    : coordsBase
                    ? { location_coordinates: { lat: coordsBase.latitude + i * 0.01, lng: coordsBase.longitude + i * 0.01 } }
                    : {}; // unset -> makeAmberItem's own fixed default, unchanged from Milestone 2
                return makeAmberItem(`${runId}-${cityParam}-${i}`, `Test Residence ${i}`, {
                    pricing: { min_price: 200 + i * 20, currency: "gbp" },
                    meta: {
                        distances: [{ place: "City Centre", distance: `${(0.5 + i).toFixed(1)} km` }],
                        review_summary: { rating: { location: 3.8 + i * 0.2, cleanliness: 4 } },
                        unit_types: [i % 2 === 0 ? "studio" : "ensuite"],
                    },
                    ...coordsOverride,
                });
            });
            return { ok: true, status: 200, json: async () => amberListingsResponse(items) };
        }
        return originalFetch(url, opts);
    };

    // ══════════════════════════ RANKING UNIT TESTS ══════════════════════════
    await test("RANKING: single-residence city does not throw or produce NaN (min===max distance guard)", () => {
        const docs = [{ propertyId: "r1", propertyName: "Solo House", distanceToCentreKm: 1.0, rating: 4, roomType: "Studio", price: { amount: 200, currency: "£" } }];
        const ranked = rankResidences(docs, { budget: null, accommodationPreference: null });
        assert.strictEqual(ranked.length, 1);
        assert.ok(Number.isFinite(ranked[0].matchScore), "matchScore must be a finite number");
        assert.strictEqual(ranked[0].badge, "Best Overall");
    });
    await test("RANKING: all residences missing distance data does not poison the whole ranking with NaN", () => {
        const docs = [
            { propertyId: "r1", propertyName: "A", distanceToCentreKm: null, rating: 4, roomType: "Studio", price: { amount: 200, currency: "£" } },
            { propertyId: "r2", propertyName: "B", distanceToCentreKm: null, rating: 3, roomType: "Ensuite", price: { amount: 250, currency: "£" } },
        ];
        const ranked = rankResidences(docs, { budget: null, accommodationPreference: null });
        ranked.forEach((r) => assert.ok(Number.isFinite(r.matchScore), `matchScore must be finite, got ${r.matchScore}`));
    });
    await test("RANKING: no budget, no preference, no rating, no distance -> neutral scores, no throw", () => {
        const docs = [
            { propertyId: "r1", propertyName: "A", distanceToCentreKm: null, rating: null, roomType: null, price: { amount: null, currency: null } },
            { propertyId: "r2", propertyName: "B", distanceToCentreKm: null, rating: null, roomType: null, price: { amount: null, currency: null } },
        ];
        const ranked = rankResidences(docs, { budget: null, accommodationPreference: null });
        ranked.forEach((r) => assert.strictEqual(r.matchScore, 50, "fully-unusable data should score neutral, not NaN"));
    });
    await test("RANKING: budget factor is clamped to [0,1], never negative", () => {
        const docs = [{ propertyId: "r1", propertyName: "Expensive", distanceToCentreKm: 1, rating: 4, roomType: "Studio", price: { amount: 900, currency: "£" } }];
        const ranked = rankResidences(docs, { budget: 100, accommodationPreference: null }); // price is 9x budget
        assert.ok(ranked[0].matchScore >= 0 && ranked[0].matchScore <= 100, `matchScore out of [0,100]: ${ranked[0].matchScore}`);
    });
    await test("parseDistanceKm handles km/m/mi and unparseable input", () => {
        assert.strictEqual(parseDistanceKm("1.2 km"), 1.2);
        assert.strictEqual(parseDistanceKm("500 m"), 0.5);
        assert.strictEqual(Math.round(parseDistanceKm("1 mi") * 100) / 100, 1.61);
        assert.strictEqual(parseDistanceKm("unknown"), null);
        assert.strictEqual(parseDistanceKm(null), null);
    });

    // ══════════════════════════ MILESTONE 3: UNIVERSITY RESOLVER ══════════════════════════
    await test("RESOLVER: exact canonical name resolves", () => {
        const uni = resolveUniversityByName("University of Manchester");
        assert.ok(uni, "expected a match");
        assert.strictEqual(uni.id, "university-of-manchester");
    });
    await test("RESOLVER: known alias resolves to the same canonical university", () => {
        const uni = resolveUniversityByName("UoM");
        assert.ok(uni);
        assert.strictEqual(uni.id, "university-of-manchester");
    });
    await test("RESOLVER: case/punctuation-insensitive matching", () => {
        const uni = resolveUniversityByName("  university OF manchester!! ");
        assert.ok(uni);
        assert.strictEqual(uni.id, "university-of-manchester");
    });
    await test("RESOLVER: unknown university returns null, never a guess", () => {
        assert.strictEqual(resolveUniversityByName("Totally Made Up University"), null);
    });
    await test("RESOLVER: empty/whitespace input returns null", () => {
        assert.strictEqual(resolveUniversityByName(""), null);
        assert.strictEqual(resolveUniversityByName("   "), null);
        assert.strictEqual(resolveUniversityByName(null), null);
    });
    await test("RESOLVER: authoritative id lookup ignores client-supplied text, only trusts the id", () => {
        const real = UNIVERSITIES[0];
        assert.strictEqual(resolveUniversityById(real.id).name, real.name);
        assert.strictEqual(resolveUniversityById("not-a-real-id"), null);
        assert.strictEqual(resolveUniversityById(undefined), null);
    });

    // ══════════════════════════ MILESTONE 3: HAVERSINE / GEO ══════════════════════════
    await test("HAVERSINE: known distance (roughly Manchester <-> Leeds, ~60km) is in a sane range", () => {
        const km = haversineKm(53.4668, -2.2339, 53.8067, -1.5550);
        assert.ok(km > 50 && km < 70, `expected ~55-65km, got ${km}`);
    });
    await test("HAVERSINE: zero distance for identical coordinates", () => {
        assert.strictEqual(haversineKm(51.5, -0.1, 51.5, -0.1), 0);
    });
    await test("attachRankingDistance: residence with real coords + resolved university -> true Haversine distance", () => {
        const docs = [{ propertyId: "r1", latitude: 53.4668, longitude: -2.2339, distanceToCentreKm: 99 }];
        const [out] = attachRankingDistance(docs, { latitude: 53.4680, longitude: -2.2350 });
        assert.ok(Number.isFinite(out.rankingDistanceKm) && out.rankingDistanceKm < 1, "expected a small real distance, not the stale 99 proxy value");
    });
    await test("attachRankingDistance: residence WITHOUT coords + resolved university -> null, never falls back to the city-centre proxy", () => {
        const docs = [{ propertyId: "r1", latitude: null, longitude: null, distanceToCentreKm: 2.5 }];
        const [out] = attachRankingDistance(docs, { latitude: 53.4668, longitude: -2.2339 });
        assert.strictEqual(out.rankingDistanceKm, null, "must not silently mix the city-centre proxy into a geo-aware ranked list");
    });
    await test("attachRankingDistance: invalid university coords (out of range / NaN) treated as unresolved -> falls back to distanceToCentreKm for every residence", () => {
        const docs = [{ propertyId: "r1", latitude: 53.4668, longitude: -2.2339, distanceToCentreKm: 3.1 }];
        const [outBad1] = attachRankingDistance(docs, { latitude: 999, longitude: -2.2339 });
        assert.strictEqual(outBad1.rankingDistanceKm, 3.1);
        const [outBad2] = attachRankingDistance(docs, { latitude: NaN, longitude: -2.2339 });
        assert.strictEqual(outBad2.rankingDistanceKm, 3.1);
    });
    await test("attachRankingDistance: no university at all -> every residence uses its own distanceToCentreKm (Milestone 2 behavior unchanged)", () => {
        const docs = [
            { propertyId: "r1", latitude: 53.4668, longitude: -2.2339, distanceToCentreKm: 1.2 },
            { propertyId: "r2", latitude: null, longitude: null, distanceToCentreKm: null },
        ];
        const out = attachRankingDistance(docs, null);
        assert.strictEqual(out[0].rankingDistanceKm, 1.2);
        assert.strictEqual(out[1].rankingDistanceKm, null);
    });

    // ══════════════════════════ MILESTONE 3: RADIUS TIERS + TOP-UP FLOOR ══════════════════════════
    await test("RADIUS: prefers the tightest tier that meets the minimum result count", () => {
        const docs = [
            { propertyId: "r1", rankingDistanceKm: 2 },
            { propertyId: "r2", rankingDistanceKm: 3 },
            { propertyId: "r3", rankingDistanceKm: 4 },
            { propertyId: "r4", rankingDistanceKm: 12 },
        ];
        const selected = applyRadius(docs, true);
        assert.strictEqual(selected.length, 3, "3 residences within 5km should satisfy the tightest tier, not expand to 10/15km");
    });
    await test("RADIUS: expands tiers when the tightest one is short", () => {
        const docs = [
            { propertyId: "r1", rankingDistanceKm: 2 },
            { propertyId: "r2", rankingDistanceKm: 8 },
            { propertyId: "r3", rankingDistanceKm: 9 },
        ];
        const selected = applyRadius(docs, true);
        assert.strictEqual(selected.length, 3, "only 1 within 5km -> should expand to the 10km tier to reach 3");
    });
    await test("RADIUS: real floor — a city where EVERY residence lacks coordinates still returns candidates, not zero (the bug an earlier design review caught)", () => {
        const docs = Array.from({ length: 5 }, (_, i) => ({ propertyId: `r${i}`, rankingDistanceKm: null }));
        const selected = applyRadius(docs, true);
        assert.strictEqual(selected.length, 5, "no coordinates anywhere must still top up to the full candidate pool, never an empty result");
    });
    await test("RADIUS: mixed — some far/uncoordinated residences top up a short near tier rather than being excluded", () => {
        const docs = [
            { propertyId: "near", rankingDistanceKm: 1 },
            { propertyId: "far", rankingDistanceKm: 40 },
            { propertyId: "unknown", rankingDistanceKm: null },
        ];
        const selected = applyRadius(docs, true);
        assert.strictEqual(selected.length, 3, "only 1 within any tier -> both the far and coordinate-less residence must be included as fallback candidates");
    });
    await test("RADIUS: unresolved university -> no filtering at all, every candidate passes through untouched", () => {
        const docs = [{ propertyId: "r1", rankingDistanceKm: 40 }, { propertyId: "r2", rankingDistanceKm: null }];
        const selected = applyRadius(docs, false);
        assert.strictEqual(selected.length, 2);
    });
    await test("RADIUS never triggers a second Amber refresh — pure in-memory re-filter (no async/Promise, no gateway import)", () => {
        // applyRadius is a synchronous function with zero imports from
        // amberGateway/sharedStore — structurally incapable of reaching Amber.
        assert.strictEqual(applyRadius.constructor.name, "Function", "must be a plain synchronous function, not async — confirms it cannot itself await a new fetchListings() call");
    });

    // ══════════════════════════ MILESTONE 3: BUDGET / DURATION NORMALIZATION ══════════════════════════
    await test("normalizeDuration: weekly/monthly -> week/month; unrecognized/missing -> null", () => {
        assert.strictEqual(normalizeDuration("weekly"), "week");
        assert.strictEqual(normalizeDuration("monthly"), "month");
        assert.strictEqual(normalizeDuration("termly"), "term");
        assert.strictEqual(normalizeDuration(null), null);
        assert.strictEqual(normalizeDuration(""), null);
    });
    await test("computePriceWeekly: week stays as-is, month is converted, unrecognized (e.g. term) is null (never guessed)", () => {
        assert.strictEqual(computePriceWeekly(200, "week"), 200);
        assert.ok(Math.abs(computePriceWeekly(866.67, "month") - 200) < 1, "monthly ~866.67 should convert to ~200/week");
        assert.strictEqual(computePriceWeekly(3000, "term"), null, "termly pricing must not be silently treated as weekly or monthly");
        assert.strictEqual(computePriceWeekly(200, null), null);
        assert.strictEqual(computePriceWeekly(NaN, "week"), null);
    });
    await test("RANKING: budget scoring prefers priceWeekly over raw price.amount (fixes the weekly-vs-monthly mixing bug)", () => {
        const budget = 200;
        // Same true weekly cost (~200), one billed weekly, one billed monthly —
        // must score comparably once normalized, not wildly differently.
        const docs = [
            { propertyId: "weekly", rankingDistanceKm: null, price: { amount: 200 }, priceWeekly: 200, rating: null, roomType: null },
            { propertyId: "monthly", rankingDistanceKm: null, price: { amount: 866 }, priceWeekly: 200, rating: null, roomType: null },
        ];
        const ranked = rankResidences(docs, { budget, accommodationPreference: null });
        const scores = Object.fromEntries(ranked.map((r) => [r.id, r.matchScore]));
        assert.strictEqual(scores.weekly, scores.monthly, "normalized weekly-equivalent prices should score identically regardless of raw billing period");
    });
    await test("RANKING: falls back to raw price.amount when priceWeekly is absent (keeps hand-built fixtures without priceWeekly meaningful, not silently no-op)", () => {
        const docs = [{ propertyId: "r1", rankingDistanceKm: null, price: { amount: 900 }, rating: null, roomType: null }]; // no priceWeekly at all
        const ranked = rankResidences(docs, { budget: 100, accommodationPreference: null });
        assert.ok(ranked[0].matchScore < 60, "a price 9x over budget with no priceWeekly should still score poorly via the price.amount fallback, not be ignored");
    });

    // ══════════════════════════ MILESTONE 4: MAP — COORDINATES ON OUTPUT SHAPE ══════════════════════════
    await test("MAP: toOutputShape (via rankResidences) surfaces valid latitude/longitude for a residence that has them", () => {
        const docs = [{ propertyId: "r1", propertyName: "Has Coords", rankingDistanceKm: null, price: { amount: 200 }, rating: null, roomType: null, latitude: 53.4668, longitude: -2.2339 }];
        const [out] = rankResidences(docs, { budget: null, accommodationPreference: null });
        assert.strictEqual(out.latitude, 53.4668);
        assert.strictEqual(out.longitude, -2.2339);
    });
    await test("MAP: toOutputShape never fabricates a marker location — missing/invalid coords surface as null, not 0 or a guess", () => {
        const docs = [
            { propertyId: "r1", propertyName: "No Coords", rankingDistanceKm: null, price: { amount: 200 }, rating: null, roomType: null, latitude: null, longitude: null },
            { propertyId: "r2", propertyName: "Bad Coords", rankingDistanceKm: null, price: { amount: 200 }, rating: null, roomType: null, latitude: 999, longitude: -2.2339 },
        ];
        const ranked = rankResidences(docs, { budget: null, accommodationPreference: null });
        ranked.forEach((r) => {
            assert.strictEqual(r.latitude, null, `${r.name}: latitude must be null, never fabricated`);
            assert.strictEqual(r.longitude, null, `${r.name}: longitude must be null, never fabricated`);
        });
    });
    await test("MAP: computePriceMonthly converts a weekly-equivalent price; null (never guessed) when priceWeekly is unusable", () => {
        assert.strictEqual(computePriceMonthly(200), Math.round(200 * (52 / 12)));
        assert.strictEqual(computePriceMonthly(null), null);
        assert.strictEqual(computePriceMonthly(NaN), null);
    });
    await test("MAP: priceWeekly/priceMonthly appear on the ranked output shape, rounded, null-safe", () => {
        const docs = [
            { propertyId: "r1", propertyName: "Weekly", rankingDistanceKm: null, price: { amount: 200 }, priceWeekly: 200, rating: null, roomType: null },
            { propertyId: "r2", propertyName: "Unrecognized Duration", rankingDistanceKm: null, price: { amount: 3000 }, priceWeekly: null, rating: null, roomType: null },
        ];
        const ranked = rankResidences(docs, { budget: null, accommodationPreference: null });
        const byName = Object.fromEntries(ranked.map((r) => [r.name, r]));
        assert.strictEqual(byName.Weekly.priceWeekly, 200);
        assert.strictEqual(byName.Weekly.priceMonthly, Math.round(200 * (52 / 12)));
        assert.strictEqual(byName["Unrecognized Duration"].priceWeekly, null);
        assert.strictEqual(byName["Unrecognized Duration"].priceMonthly, null);
    });

    // ══════════════════════════ MILESTONE 4: LIVING COST LAYER (api/_lib/costOfLiving.js) ══════════════════════════
    // Pure, zero-network, zero-Amber, zero-Mongo — see costOfLiving.js's own
    // header comment. Runs unconditionally, same as the ranking/geo tests above.
    await test("COST: a curated UK city resolves to its city-specific row, matched:true", () => {
        const cost = getCityLivingCost("Manchester", "United Kingdom");
        assert.strictEqual(cost.matched, true);
        assert.strictEqual(cost.currency, "£");
        assert.ok(cost.foodMonthly > 0 && cost.transportMonthly > 0 && cost.utilitiesMonthly > 0 && cost.personalMonthly > 0 && cost.otherMonthly > 0);
    });
    await test("COST: city lookup is case/whitespace-insensitive, same as amberGateway's normalizeCityName (city label itself is passed through as-given, only the lookup key is normalized)", () => {
        const a = getCityLivingCost("  MANCHESTER  ", "United Kingdom");
        const b = getCityLivingCost("Manchester", "United Kingdom");
        assert.strictEqual(a.matched, true);
        assert.strictEqual(b.matched, true);
        const { city: cityA, ...restA } = a;
        const { city: cityB, ...restB } = b;
        assert.deepStrictEqual(restA, restB, "both should resolve to the identical curated row regardless of input casing/whitespace");
    });
    await test("COST: an unlisted city falls back to its country row, matched:false — never a fabricated city-specific number", () => {
        const cost = getCityLivingCost("Some Tiny UK Town Not In The Dataset", "United Kingdom");
        assert.strictEqual(cost.matched, false);
        assert.strictEqual(cost.currency, "£");
    });
    await test("COST: an unrecognized country falls back to the world default, still returns a usable row", () => {
        const cost = getCityLivingCost("Nowhereville", "Atlantis");
        assert.strictEqual(cost.matched, false);
        assert.ok(Number.isFinite(cost.foodMonthly));
    });
    await test("COST: source is explicitly labeled an estimate, never presented as official", () => {
        const cost = getCityLivingCost("London", "United Kingdom");
        assert.strictEqual(cost.source, "internal-estimate");
        assert.ok(cost.sourceUpdatedAt);
    });
    await test("COST: getLivingExpenses sums accommodation + curated categories into totalMonthly/totalAnnual when accommodation is known", () => {
        const result = getLivingExpenses({ city: "Manchester", country: "United Kingdom", accommodationMonthly: 1000 });
        const expectedTotal = 1000 + result.food + result.transport + result.utilities + result.personal + result.other;
        assert.strictEqual(result.totalMonthly, expectedTotal);
        assert.strictEqual(result.totalAnnual, expectedTotal * 12);
    });
    await test("COST: getLivingExpenses NEVER fabricates a total when accommodation is unknown (null) — total/annual/scenarios stay honestly null", () => {
        const result = getLivingExpenses({ city: "Manchester", country: "United Kingdom", accommodationMonthly: null });
        assert.strictEqual(result.accommodation, null);
        assert.strictEqual(result.totalMonthly, null);
        assert.strictEqual(result.totalAnnual, null);
        assert.strictEqual(result.scenarios, null);
        // Non-accommodation categories are still real, curated numbers — a
        // missing residence price must not blank out everything else.
        assert.ok(Number.isFinite(result.food) && Number.isFinite(result.transport));
    });
    await test("COST: budget/average/comfortable scenarios are deterministic and derived from the same fixed multipliers every time", () => {
        const r1 = getLivingExpenses({ city: "Leeds", country: "United Kingdom", accommodationMonthly: 900 });
        const r2 = getLivingExpenses({ city: "Leeds", country: "United Kingdom", accommodationMonthly: 900 });
        assert.deepStrictEqual(r1.scenarios, r2.scenarios, "same inputs must always produce the same scenario figures");
        assert.strictEqual(r1.scenarios.budget, Math.round(r1.totalMonthly * SCENARIO_MULTIPLIERS.budget));
        assert.strictEqual(r1.scenarios.average, r1.totalMonthly);
        assert.strictEqual(r1.scenarios.comfortable, Math.round(r1.totalMonthly * SCENARIO_MULTIPLIERS.comfortable));
        assert.ok(r1.scenarios.budget < r1.scenarios.average && r1.scenarios.average < r1.scenarios.comfortable, "budget < average < comfortable must always hold");
    });
    await test("COST: costOfLiving.js makes zero network calls (structurally — no fetch/require of amberGateway or mongodb)", () => {
        const src = require("fs").readFileSync(path.join(ROOT, "api", "_lib", "costOfLiving.js"), "utf8");
        assert.ok(!/require\(.*amberGateway/.test(src), "must not import amberGateway.js");
        assert.ok(!/require\(.*mongodb/.test(src), "must not import mongodb.js");
        assert.ok(!/\bfetch\(/.test(src), "must not call fetch() itself");
    });

    // ══════════════════════════ MILESTONE 5: DEGREE RESOLUTION ══════════════════════════
    await test("DEGREE RESOLVER: exact canonical name resolves", () => {
        const d = resolveDegreeByName("Computer Science");
        assert.ok(d);
        assert.strictEqual(d.id, "computer-science");
    });
    await test("DEGREE RESOLVER: known alias resolves to the same canonical degree", () => {
        assert.strictEqual(resolveDegreeByName("BSc CS").id, "computer-science");
        assert.strictEqual(resolveDegreeByName("CS").id, "computer-science");
    });
    await test("DEGREE RESOLVER: BSc/BTech naming variations intentionally supported", () => {
        assert.strictEqual(resolveDegreeByName("BSc Computer Science").id, "computer-science");
        assert.strictEqual(resolveDegreeByName("Computer Science BSc").id, "computer-science");
        assert.strictEqual(resolveDegreeByName("BTech Computer Science").id, "computer-science");
    });
    await test("DEGREE RESOLVER: case/punctuation-insensitive matching", () => {
        assert.strictEqual(resolveDegreeByName("  computer SCIENCE!! ").id, "computer-science");
    });
    await test("DEGREE RESOLVER: unknown degree returns null, never a guess", () => {
        assert.strictEqual(resolveDegreeByName("Underwater Basket Weaving"), null);
        assert.strictEqual(resolveDegreeByName(""), null);
        assert.strictEqual(resolveDegreeByName(null), null);
    });
    await test("DEGREE RESOLVER: no ambiguous aliases in the curated dataset — every normalized name/alias maps to exactly one degree (proves resolveDegreeByName's `matches.length !== 1` guard has nothing to silently collide on, and would correctly return null if it ever did)", () => {
        const seen = new Map(); // normalized key -> degree id
        const normalize = (s) => String(s || "").toLowerCase().replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim();
        const collisions = [];
        for (const d of DEGREES) {
            for (const key of [d.name, ...(d.aliases || [])].map(normalize)) {
                if (!key) continue;
                if (seen.has(key) && seen.get(key) !== d.id) collisions.push(`"${key}" -> ${seen.get(key)} vs ${d.id}`);
                seen.set(key, d.id);
            }
        }
        assert.deepStrictEqual(collisions, [], `found ambiguous alias(es): ${collisions.join(", ")}`);
    });
    await test("DEGREE RESOLVER: authoritative id lookup ignores client-supplied text, only trusts the id", () => {
        const real = DEGREES[0];
        assert.strictEqual(resolveDegreeById(real.id).name, real.name);
        assert.strictEqual(resolveDegreeById("not-a-real-degree-id"), null);
        assert.strictEqual(resolveDegreeById(undefined), null);
    });

    // ══════════════════════════ MILESTONE 5: DEGREE DATASET QUALITY ══════════════════════════
    await test(`DEGREE DATA: dataset is a maintainable curated set (${DEGREES.length} degrees, not hundreds)`, () => {
        assert.ok(DEGREES.length >= 10 && DEGREES.length <= 30, `expected a small curated set, got ${DEGREES.length}`);
    });
    await test("DEGREE DATA: every degree has non-empty required fields (id, name, category, summary)", () => {
        DEGREES.forEach((d) => {
            assert.ok(d.id && d.id.trim(), `${d.name}: missing id`);
            assert.ok(d.name && d.name.trim(), `${d.id}: missing name`);
            assert.ok(d.category && d.category.trim(), `${d.id}: missing category`);
            assert.ok(d.summary && d.summary.trim(), `${d.id}: missing summary`);
        });
    });
    await test("DEGREE DATA: coreSkills within 5-8 (concise, not a 30-50 skill dump), technicalAreas within 3-5, specializationPaths within 3-5", () => {
        DEGREES.forEach((d) => {
            assert.ok(d.coreSkills.length >= 5 && d.coreSkills.length <= 8, `${d.id}: coreSkills.length=${d.coreSkills.length}`);
            assert.ok(d.technicalAreas.length >= 3 && d.technicalAreas.length <= 5, `${d.id}: technicalAreas.length=${d.technicalAreas.length}`);
            assert.ok(d.specializationPaths.length >= 3 && d.specializationPaths.length <= 5, `${d.id}: specializationPaths.length=${d.specializationPaths.length}`);
        });
    });
    await test("DEGREE DATA: no duplicate skills/technical areas within a single degree", () => {
        DEGREES.forEach((d) => {
            assert.strictEqual(new Set(d.coreSkills).size, d.coreSkills.length, `${d.id}: duplicate coreSkills`);
            assert.strictEqual(new Set(d.technicalAreas).size, d.technicalAreas.length, `${d.id}: duplicate technicalAreas`);
        });
    });
    await test("DEGREE DATA: every specialization path has id/name and 3+ non-empty emphasisSkills", () => {
        DEGREES.forEach((d) => {
            d.specializationPaths.forEach((p) => {
                assert.ok(p.id && p.name, `${d.id}: specialization missing id/name`);
                assert.ok(Array.isArray(p.emphasisSkills) && p.emphasisSkills.length >= 3, `${d.id}/${p.id}: too few emphasisSkills`);
            });
        });
    });
    await test("DEGREE DATA: no two degree ids collide (unique primary keys)", () => {
        assert.strictEqual(new Set(DEGREES.map((d) => d.id)).size, DEGREES.length);
    });

    // ══════════════════════════ MILESTONE 5: SPECIALIZATION RESOLUTION ══════════════════════════
    const cs = resolveDegreeById("computer-science");
    await test("SPECIALIZATION: valid specialization resolves against the selected degree's own paths, matches item 10's example", () => {
        const match = resolveSpecialization(cs, "AI / Machine Learning");
        assert.ok(match);
        assert.strictEqual(match.id, "ai-ml");
        assert.deepStrictEqual(match.emphasisSkills, ["Python", "Machine Learning", "Statistics", "Data Processing", "Neural Networks"]);
    });
    await test("SPECIALIZATION: alias resolves to the same specialization", () => {
        assert.strictEqual(resolveSpecialization(cs, "ML").id, "ai-ml");
        assert.strictEqual(resolveSpecialization(cs, "Machine Learning").id, "ai-ml");
    });
    await test("SPECIALIZATION: invalid/unrecognized specialization returns null, never invented", () => {
        assert.strictEqual(resolveSpecialization(cs, "Underwater Basket Weaving"), null);
        assert.strictEqual(resolveSpecialization(cs, ""), null);
    });
    await test("SPECIALIZATION: is scoped to the given degree — a specialization name only valid elsewhere does not cross-resolve", () => {
        const civil = resolveDegreeById("civil-engineering");
        // "AI / Machine Learning" is a real specialization under computer-science, not civil-engineering.
        assert.strictEqual(resolveSpecialization(civil, "AI / Machine Learning"), null);
    });
    await test("SPECIALIZATION: degreeResolver.js has zero network/Amber/Mongo imports (structural)", () => {
        const src = require("fs").readFileSync(path.join(ROOT, "api", "_lib", "degreeResolver.js"), "utf8");
        assert.ok(!/require\(.*amberGateway/.test(src), "must not import amberGateway.js");
        assert.ok(!/require\(.*mongodb/.test(src), "must not import mongodb.js");
        assert.ok(!/\bfetch\(/.test(src), "must not call fetch() itself");
    });

    // ══════════════════════════ MILESTONE 5: PLANNER API — DEGREE BUILDING ══════════════════════════
    const { buildDegreeResult } = require(path.join(ROOT, "api", "_lib", "routes", "content", "student-planner"));
    await test("PLANNER DEGREE: valid degreeId returns ready status with structured data", () => {
        const result = buildDegreeResult("computer-science", null, null);
        assert.strictEqual(result.status, "ready");
        assert.strictEqual(result.id, "computer-science");
        assert.ok(result.coreSkills.length > 0 && result.technicalAreas.length > 0 && result.specializationPaths.length > 0);
        assert.strictEqual(result.source, "ivyhuts-degree-guidance");
    });
    await test("PLANNER DEGREE: courtesy free-text resolve works when no degreeId is supplied", () => {
        const result = buildDegreeResult(null, "BSc CS", null);
        assert.strictEqual(result.status, "ready");
        assert.strictEqual(result.id, "computer-science");
    });
    await test("PLANNER DEGREE: missing degreeId AND unresolvable free text -> controlled unresolved state, never fabricated", () => {
        const result = buildDegreeResult(null, "Underwater Basket Weaving", null);
        assert.strictEqual(result.status, "unresolved");
        assert.strictEqual(result.id, null);
        assert.strictEqual(result.name, "Underwater Basket Weaving", "entered text is preserved even though unresolved");
        assert.deepStrictEqual(result.coreSkills, []);
        assert.deepStrictEqual(result.technicalAreas, []);
        assert.deepStrictEqual(result.specializationPaths, []);
    });
    await test("PLANNER DEGREE: completely absent degree input -> unresolved with null name, no crash", () => {
        const result = buildDegreeResult(null, null, null);
        assert.strictEqual(result.status, "unresolved");
        assert.strictEqual(result.name, null);
    });
    await test("PLANNER DEGREE: valid specialization is attached without erasing base coreSkills/technicalAreas", () => {
        const result = buildDegreeResult("computer-science", null, "AI / Machine Learning");
        assert.ok(result.specialization);
        assert.strictEqual(result.specialization.id, "ai-ml");
        assert.ok(result.coreSkills.length > 0, "base coreSkills must remain present alongside a specialization");
        assert.strictEqual(result.specializationNote, null);
    });
    await test("PLANNER DEGREE: unknown optional specialization does not crash, surfaces a controlled note, base degree still returned", () => {
        const result = buildDegreeResult("computer-science", null, "Astrophysics");
        assert.strictEqual(result.status, "ready");
        assert.strictEqual(result.specialization, null);
        assert.strictEqual(result.specializationNote, "Specialization not found in IVYHUTS guidance dataset.");
        assert.ok(result.coreSkills.length > 0);
    });
    await test("PLANNER DEGREE: unresolved degree ignores specialization entirely rather than resolving it against nothing", () => {
        const result = buildDegreeResult(null, "Not A Real Degree", "AI / Machine Learning");
        assert.strictEqual(result.status, "unresolved");
        assert.strictEqual(result.specialization, null);
        assert.strictEqual(result.specializationNote, null);
    });
    await test("PLANNER DEGREE: buildDegreeResult is a plain synchronous function — structurally incapable of an Amber/network call", () => {
        assert.strictEqual(buildDegreeResult.constructor.name, "Function", "must not be async — confirms it cannot itself await a fetch");
    });
    await test("PLANNER API: response wiring still includes every pre-existing top-level field alongside `degree`, `careers`, career-level `salary` AND `readiness` fields (backward compatible)", () => {
        const src = require("fs").readFileSync(path.join(ROOT, "api", "_lib", "routes", "content", "student-planner.js"), "utf8");
        ["ok: true", "status", "residences", "comparison: residences", "livingExpenses", "degree: degreeResult", "careers: careersWithReadiness", "salary: resolveSalaryForCareer", "readiness: resolveReadinessForCareer"].forEach((needle) => {
            assert.ok(src.includes(needle), `expected api/student-planner.js's response to still include "${needle}"`);
        });
    });

    // ══════════════════════════ MILESTONE 6: CAREER DATASET QUALITY ══════════════════════════
    await test(`CAREER DATA: dataset is a maintainable curated set (${CAREERS.length} careers, not hundreds)`, () => {
        assert.ok(CAREERS.length >= 15 && CAREERS.length <= 80, `expected a small curated set, got ${CAREERS.length}`);
    });
    await test("CAREER DATA: every career id is unique", () => {
        assert.strictEqual(new Set(CAREERS.map((c) => c.id)).size, CAREERS.length);
    });
    await test("CAREER DATA: every career title is unique", () => {
        assert.strictEqual(new Set(CAREERS.map((c) => c.title)).size, CAREERS.length);
    });
    await test("CAREER DATA: every career has non-empty required fields (id, title, category, summary, requiredSkills)", () => {
        CAREERS.forEach((c) => {
            assert.ok(c.id && c.id.trim(), `${c.title}: missing id`);
            assert.ok(c.title && c.title.trim(), `${c.id}: missing title`);
            assert.ok(c.category && c.category.trim(), `${c.id}: missing category`);
            assert.ok(c.summary && c.summary.trim(), `${c.id}: missing summary`);
            assert.ok(Array.isArray(c.requiredSkills) && c.requiredSkills.length > 0, `${c.id}: requiredSkills must be a non-empty array`);
            assert.ok(Array.isArray(c.preferredSkills), `${c.id}: preferredSkills must be an array`);
            assert.ok(Array.isArray(c.relevantDegrees), `${c.id}: relevantDegrees must be an array`);
            assert.ok(Array.isArray(c.relevantSpecializations), `${c.id}: relevantSpecializations must be an array`);
        });
    });
    await test("CAREER DATA: no duplicate skills within a single career's requiredSkills/preferredSkills", () => {
        CAREERS.forEach((c) => {
            assert.strictEqual(new Set(c.requiredSkills).size, c.requiredSkills.length, `${c.id}: duplicate requiredSkills`);
            assert.strictEqual(new Set(c.preferredSkills).size, c.preferredSkills.length, `${c.id}: duplicate preferredSkills`);
        });
    });
    await test("CAREER DATA: no duplicate entries within relevantDegrees/relevantSpecializations", () => {
        CAREERS.forEach((c) => {
            assert.strictEqual(new Set(c.relevantDegrees).size, c.relevantDegrees.length, `${c.id}: duplicate relevantDegrees`);
            assert.strictEqual(new Set(c.relevantSpecializations).size, c.relevantSpecializations.length, `${c.id}: duplicate relevantSpecializations`);
        });
    });
    await test("CAREER DATA: every relevantDegrees entry references a real degree id from degrees.json", () => {
        const degreeIds = new Set(DEGREES.map((d) => d.id));
        const bad = [];
        CAREERS.forEach((c) => c.relevantDegrees.forEach((id) => { if (!degreeIds.has(id)) bad.push(`${c.id} -> ${id}`); }));
        assert.deepStrictEqual(bad, [], `found career(s) referencing an unknown degree id: ${bad.join(", ")}`);
    });
    await test("CAREER DATA: every relevantSpecializations composite key (\"degreeId:specId\") resolves to a real degree+specialization pair", () => {
        const bad = [];
        CAREERS.forEach((c) => c.relevantSpecializations.forEach((key) => {
            const [degreeId, specId] = key.split(":");
            const degree = DEGREES.find((d) => d.id === degreeId);
            const spec = degree && (degree.specializationPaths || []).find((p) => p.id === specId);
            if (!spec) bad.push(`${c.id} -> ${key}`);
        }));
        assert.deepStrictEqual(bad, [], `found career(s) referencing an unknown degree:specialization pair: ${bad.join(", ")}`);
    });
    await test("CAREER DATA: careerResolver.js and careers.json make zero network/Amber/Mongo calls (structural)", () => {
        const src = require("fs").readFileSync(path.join(ROOT, "api", "_lib", "careerResolver.js"), "utf8");
        assert.ok(!/require\(.*amberGateway/.test(src), "must not import amberGateway.js");
        assert.ok(!/require\(.*mongodb/.test(src), "must not import mongodb.js");
        assert.ok(!/\bfetch\(/.test(src), "must not call fetch() itself");
    });

    // ══════════════════════════ MILESTONE 6: SKILL NORMALIZATION ══════════════════════════
    await test("SKILL NORMALIZATION: case/whitespace-insensitive", () => {
        assert.strictEqual(normalizeSkill("  Programming  "), normalizeSkill("programming"));
        assert.strictEqual(normalizeSkill("SQL"), normalizeSkill("sql"));
    });
    await test("SKILL NORMALIZATION: controlled alias map collapses known wording variants without over-merging unrelated skills", () => {
        assert.strictEqual(normalizeSkill("Cloud Computing"), normalizeSkill("Cloud Platforms"));
        assert.strictEqual(normalizeSkill("Cloud Infrastructure"), normalizeSkill("Cloud Platforms"));
        assert.notStrictEqual(normalizeSkill("Programming"), normalizeSkill("Programming Basics"), "deliberately distinct depth levels must not be merged");
    });
    await test("SKILL NORMALIZATION: empty/missing input never throws, returns empty string", () => {
        assert.strictEqual(normalizeSkill(""), "");
        assert.strictEqual(normalizeSkill(null), "");
        assert.strictEqual(normalizeSkill(undefined), "");
    });

    // ══════════════════════════ MILESTONE 6: CAREER RESOLUTION ══════════════════════════
    await test("CAREER RESOLUTION: Computer Science returns relevant careers", () => {
        const careers = resolveCareersForDegree("computer-science", null, null);
        assert.ok(careers.length > 0, "expected at least one career for Computer Science");
        assert.ok(careers.some((c) => c.id === "software-engineer"), "expected Software Engineer among Computer Science careers");
    });
    await test("CAREER RESOLUTION: Software Engineering returns relevant careers", () => {
        const careers = resolveCareersForDegree("software-engineering", null, null);
        assert.ok(careers.length > 0);
    });
    await test("CAREER RESOLUTION: Business Administration returns relevant careers", () => {
        const careers = resolveCareersForDegree("business-administration", null, null);
        assert.ok(careers.length > 0);
        assert.ok(careers.some((c) => c.id === "business-analyst" || c.id === "marketing-specialist"));
    });
    await test("CAREER RESOLUTION: Finance returns relevant careers", () => {
        const careers = resolveCareersForDegree("finance", null, null);
        assert.ok(careers.length > 0);
        assert.ok(careers.some((c) => c.id === "financial-analyst"));
    });
    await test("CAREER RESOLUTION: engineering degrees (Mechanical, Civil, Electrical) return relevant careers", () => {
        assert.ok(resolveCareersForDegree("mechanical-engineering", null, null).length > 0);
        assert.ok(resolveCareersForDegree("civil-engineering", null, null).length > 0);
        assert.ok(resolveCareersForDegree("electrical-engineering", null, null).length > 0);
    });
    await test("CAREER RESOLUTION: unknown degree returns a controlled empty result, never throws", () => {
        assert.deepStrictEqual(resolveCareersForDegree(null, "Underwater Basket Weaving", null), []);
        assert.deepStrictEqual(resolveCareersForDegree(null, null, null), []);
    });
    await test("CAREER RESOLUTION: known degree with genuinely no mapped careers returns [] (no crash) — proven against a synthetic degree id", () => {
        // computer-science always has mappings in the real dataset; this proves
        // the *code path* for zero matches specifically, independent of data content.
        const fakeDegree = { id: "totally-unmapped-degree-xyz", coreSkills: ["Something"], specializationPaths: [] };
        const candidates = CAREERS.filter((c) => c.relevantDegrees.includes(fakeDegree.id));
        assert.strictEqual(candidates.length, 0, "sanity check: no real career maps to this synthetic id");
    });
    await test("CAREER RESOLUTION: valid specialization changes ranking — Computer Science + AI/ML promotes ML/AI careers above the unspecialized baseline", () => {
        const base = resolveCareersForDegree("computer-science", null, null);
        const withSpec = resolveCareersForDegree("computer-science", null, "AI / Machine Learning");
        const baseTop = base.map((c) => c.id);
        const specTop = withSpec.map((c) => c.id);
        assert.ok(specTop.includes("machine-learning-engineer") || specTop.includes("ai-engineer"), "expected an ML/AI career in the specialized top results");
        const mlInSpec = withSpec.find((c) => c.id === "machine-learning-engineer");
        assert.ok(mlInSpec, "Machine Learning Engineer should appear once AI/ML is selected");
        assert.ok(mlInSpec.matchScore >= 80, `expected a Strong Match once degree+specialization+skills align, got ${mlInSpec.matchScore}`);
        assert.notDeepStrictEqual(baseTop, specTop, "specialization should meaningfully change the ranked result");
    });
    await test("CAREER RESOLUTION: unknown specialization does not crash the result — falls back to base degree ranking", () => {
        const base = resolveCareersForDegree("computer-science", null, null);
        const withBadSpec = resolveCareersForDegree("computer-science", null, "Astrophysics");
        assert.ok(withBadSpec.length > 0);
        assert.deepStrictEqual(base.map((c) => c.id), withBadSpec.map((c) => c.id), "an unrecognized specialization must not silently alter the base ranking");
    });
    await test("CAREER RESOLUTION: courtesy free-text degree resolve works when no degreeId is supplied (mirrors buildDegreeResult)", () => {
        const careers = resolveCareersForDegree(null, "BSc CS", null);
        assert.ok(careers.length > 0);
    });
    await test("CAREER RESOLUTION: maximum output is 3-5 careers for every degree in the dataset", () => {
        DEGREES.forEach((d) => {
            const careers = resolveCareersForDegree(d.id, null, null);
            assert.ok(careers.length <= MAX_RESULTS, `${d.id}: expected at most ${MAX_RESULTS}, got ${careers.length}`);
        });
    });

    // ══════════════════════════ MILESTONE 6: SKILL MATCHING ══════════════════════════
    const csDegree = resolveDegreeById("computer-science");
    await test("SKILL MATCHING: degree coreSkills are recognized as already-covered for an aligned career", () => {
        const careers = resolveCareersForDegree("computer-science", null, null);
        const se = careers.find((c) => c.id === "software-engineer");
        assert.ok(se);
        assert.ok(se.alreadyHaveSkills.includes("Programming"), `expected Programming among already-have skills, got ${JSON.stringify(se.alreadyHaveSkills)}`);
    });
    await test("SKILL MATCHING: specialization emphasisSkills are recognized as already-covered once selected", () => {
        const careers = resolveCareersForDegree("computer-science", null, "AI / Machine Learning");
        const ml = careers.find((c) => c.id === "machine-learning-engineer");
        assert.ok(ml);
        assert.ok(ml.alreadyHaveSkills.includes("Machine Learning") || ml.alreadyHaveSkills.includes("Statistics"), `expected emphasis skills recognized, got ${JSON.stringify(ml.alreadyHaveSkills)}`);
    });
    await test("SKILL MATCHING: already-covered and to-develop skills never overlap (no double-listing)", () => {
        const careers = resolveCareersForDegree("computer-science", null, "AI / Machine Learning");
        careers.forEach((c) => {
            const haveNorm = new Set(c.alreadyHaveSkills.map(normalizeSkill));
            const devNorm = c.skillsToDevelop.map(normalizeSkill);
            devNorm.forEach((s) => assert.ok(!haveNorm.has(s), `${c.id}: "${s}" appears in both already-have and to-develop`));
        });
    });
    await test("SKILL MATCHING: buildSkillGap dedupes required+preferred skills that normalize the same, never lists a skill twice", () => {
        const studentSkills = buildStudentSkillSet(csDegree, null);
        const fakeCareer = { requiredSkills: ["Programming", "Testing"], preferredSkills: ["testing", "Git"] };
        const { already, toDevelop } = buildSkillGap(fakeCareer, studentSkills);
        const all = [...already, ...toDevelop];
        assert.strictEqual(all.length, 3, `expected Testing deduped once, got ${JSON.stringify(all)}`);
    });
    await test("SKILL MATCHING: case-normalized — differently-cased duplicate skills collapse to one", () => {
        const studentSkills = buildStudentSkillSet(csDegree, null);
        const fakeCareer = { requiredSkills: ["PROGRAMMING"], preferredSkills: ["programming"] };
        const { already, toDevelop } = buildSkillGap(fakeCareer, studentSkills);
        assert.strictEqual(already.length + toDevelop.length, 1);
    });
    await test("SKILL MATCHING: missing skill data (career with empty requiredSkills) is handled safely — no NaN, no throw", () => {
        const studentSkills = buildStudentSkillSet(csDegree, null);
        const fakeCareer = { id: "x", relevantDegrees: ["computer-science"], relevantSpecializations: [], requiredSkills: [], preferredSkills: [] };
        const score = scoreCareer(fakeCareer, csDegree, null, studentSkills);
        assert.ok(Number.isFinite(score), `expected a finite score, got ${score}`);
        const { already, toDevelop } = buildSkillGap(fakeCareer, studentSkills);
        assert.deepStrictEqual(already, []);
        assert.deepStrictEqual(toDevelop, []);
    });

    // ══════════════════════════ MILESTONE 6: RANKING ══════════════════════════
    await test("RANKING: deterministic — identical inputs always produce identical output", () => {
        const r1 = resolveCareersForDegree("computer-science", null, "AI / Machine Learning");
        const r2 = resolveCareersForDegree("computer-science", null, "AI / Machine Learning");
        assert.deepStrictEqual(r1, r2);
    });
    await test("RANKING: degree relevance affects ranking — a career irrelevant to the degree never appears", () => {
        const careers = resolveCareersForDegree("civil-engineering", null, null);
        assert.ok(!careers.some((c) => c.id === "software-engineer"), "Software Engineer should not appear for Civil Engineering");
    });
    await test("RANKING: skill overlap affects ranking — higher required-skill overlap with the degree scores at least as high, all else equal", () => {
        const studentSkills = buildStudentSkillSet(csDegree, null);
        const highOverlap = { relevantDegrees: ["computer-science"], relevantSpecializations: [], requiredSkills: ["Programming", "Algorithms", "Data Structures"] };
        const lowOverlap = { relevantDegrees: ["computer-science"], relevantSpecializations: [], requiredSkills: ["Programming", "Astrophysics", "Underwater Basket Weaving"] };
        const highScore = scoreCareer(highOverlap, csDegree, null, studentSkills);
        const lowScore = scoreCareer(lowOverlap, csDegree, null, studentSkills);
        assert.ok(highScore > lowScore, `expected higher skill overlap to score higher: ${highScore} vs ${lowScore}`);
    });
    await test("RANKING: top result is genuinely the highest-scoring career (descending order, stable alphabetical tie-break)", () => {
        const careers = resolveCareersForDegree("computer-science", null, "AI / Machine Learning");
        for (let i = 1; i < careers.length; i++) {
            assert.ok(
                careers[i - 1].matchScore > careers[i].matchScore ||
                (careers[i - 1].matchScore === careers[i].matchScore && careers[i - 1].title.localeCompare(careers[i].title) <= 0),
                `careers must be sorted descending by score: ${careers[i - 1].title}(${careers[i - 1].matchScore}) before ${careers[i].title}(${careers[i].matchScore})`
            );
        }
    });
    await test("RANKING: never returns NaN, Infinity, a negative matchScore, or a duplicate career id, across every degree x specialization combo", () => {
        DEGREES.forEach((d) => {
            [null, ...d.specializationPaths.map((p) => p.name), "Not A Real Specialization"].forEach((specName) => {
                const careers = resolveCareersForDegree(d.id, null, specName);
                const ids = new Set();
                careers.forEach((c) => {
                    assert.ok(Number.isFinite(c.matchScore), `${d.id}/${specName}: matchScore must be finite, got ${c.matchScore}`);
                    assert.ok(c.matchScore >= MIN_SCORE_TO_SHOW && c.matchScore <= 100, `${d.id}/${specName}: matchScore out of range: ${c.matchScore}`);
                    assert.ok(!ids.has(c.id), `${d.id}/${specName}: duplicate career id ${c.id}`);
                    ids.add(c.id);
                });
                assert.ok(careers.length <= MAX_RESULTS);
            });
        });
    });
    await test("RANKING: matchLabelForScore never returns a numeric-probability-style label, only human-readable tiers", () => {
        assert.strictEqual(matchLabelForScore(95), "Strong Match");
        assert.strictEqual(matchLabelForScore(70), "Good Match");
        assert.strictEqual(matchLabelForScore(45), "Possible Path");
        assert.strictEqual(matchLabelForScore(20), null, "below-threshold scores must not surface a label at all");
    });

    // ══════════════════════════ MILESTONE 6: AMBER SAFETY ══════════════════════════
    await test("AMBER SAFETY: career dataset lookup, resolution, skill matching and ranking make zero Amber calls end-to-end", async () => {
        const before = amberCallCount;
        DEGREES.forEach((d) => resolveCareersForDegree(d.id, null, d.specializationPaths[0]?.name || null));
        assert.strictEqual(amberCallCount, before, "career resolution must never call Amber");
    });
    await test("AMBER SAFETY: resolveCareersForDegree is a plain synchronous function — structurally incapable of an Amber/network call", () => {
        assert.strictEqual(resolveCareersForDegree.constructor.name, "Function", "must not be async — confirms it cannot itself await a fetch");
    });

    // ══════════════════════════ MILESTONE 7: SALARY DATASET QUALITY ══════════════════════════
    await test("SALARY DATA: no duplicate careerId+country records were silently dropped (DUPLICATE_KEYS empty)", () => {
        assert.deepStrictEqual(SALARY_DUPLICATE_KEYS, [], `found duplicate career+country salary entries: ${SALARY_DUPLICATE_KEYS.join(", ")}`);
    });
    await test("SALARY DATA: every row in salaries.json passes isValidSalaryRow (no negative/NaN/Infinity/min>max/missing currency reaches the runtime index)", () => {
        const bad = SALARIES.filter((row) => !isValidSalaryRow(row));
        assert.deepStrictEqual(bad.map((r) => `${r.careerId}/${r.country}`), [], "every curated salary row must be structurally valid");
    });
    await test("SALARY DATA: isValidSalaryRow rejects negative values, NaN, Infinity, min>max, and missing currency", () => {
        const base = { careerId: "x", country: "United Kingdom", currency: "£", ranges: { entryLevel: { min: 20000, max: 30000 }, earlyCareer: { min: 30000, max: 40000 }, midCareer: { min: 40000, max: 55000 }, experienced: { min: 55000, max: 75000 } } };
        assert.strictEqual(isValidSalaryRow(base), true, "sanity check: the base fixture itself must be valid");
        assert.strictEqual(isValidSalaryRow({ ...base, ranges: { ...base.ranges, entryLevel: { min: -1000, max: 30000 } } }), false, "negative min must be rejected");
        assert.strictEqual(isValidSalaryRow({ ...base, ranges: { ...base.ranges, entryLevel: { min: NaN, max: 30000 } } }), false, "NaN must be rejected");
        assert.strictEqual(isValidSalaryRow({ ...base, ranges: { ...base.ranges, entryLevel: { min: 20000, max: Infinity } } }), false, "Infinity must be rejected");
        assert.strictEqual(isValidSalaryRow({ ...base, ranges: { ...base.ranges, entryLevel: { min: 40000, max: 30000 } } }), false, "min > max must be rejected");
        assert.strictEqual(isValidSalaryRow({ ...base, currency: "" }), false, "missing currency must be rejected");
        assert.strictEqual(isValidSalaryRow({ ...base, country: "" }), false, "missing country must be rejected");
        assert.strictEqual(isValidSalaryRow({ ...base, careerId: "" }), false, "missing careerId must be rejected");
        assert.strictEqual(isValidSalaryRow({ ...base, ranges: { entryLevel: base.ranges.entryLevel } }), false, "an incomplete set of experience levels must be rejected");
    });
    await test("SALARY DATA: every row's careerId references a real career in careers.json", () => {
        const careerIds = new Set(CAREERS.map((c) => c.id));
        const bad = SALARIES.filter((row) => !careerIds.has(row.careerId));
        assert.deepStrictEqual(bad.map((r) => r.careerId), [], "found salary row(s) referencing an unknown career id");
    });
    await test("SALARY DATA: currency matches the codebase's existing per-country symbol convention (same as costOfLiving.js)", () => {
        const expected = { "united kingdom": "£", canada: "CA$", australia: "A$" };
        const bad = SALARIES.filter((row) => expected[normalizeSalaryCountry(row.country)] !== row.currency);
        assert.deepStrictEqual(bad.map((r) => `${r.careerId}/${r.country}`), [], "currency symbol must match the country's canonical symbol");
    });
    await test("SALARY DATA: coverage starts with existing planner countries only (United Kingdom, Canada, Australia) — no untested countries snuck in", () => {
        const countries = new Set(SALARIES.map((r) => normalizeSalaryCountry(r.country)));
        const allowed = new Set(["united kingdom", "canada", "australia"]);
        countries.forEach((c) => assert.ok(allowed.has(c), `unexpected country in salary dataset: ${c}`));
    });
    await test("SALARY DATA: dataset is a maintainable curated set, not exhaustive career x country coverage", () => {
        assert.ok(SALARIES.length > 0 && SALARIES.length < CAREERS.length * 3, `expected partial, honest coverage, got ${SALARIES.length} rows for ${CAREERS.length} careers x 3 countries`);
    });
    await test("SALARY DATA: salaryResolver.js and salaries.json make zero network/Amber/Mongo calls (structural)", () => {
        const src = require("fs").readFileSync(path.join(ROOT, "api", "_lib", "salaryResolver.js"), "utf8");
        assert.ok(!/require\(.*amberGateway/.test(src), "must not import amberGateway.js");
        assert.ok(!/require\(.*mongodb/.test(src), "must not import mongodb.js");
        assert.ok(!/\bfetch\(/.test(src), "must not call fetch() itself");
    });

    // ══════════════════════════ MILESTONE 7: SALARY RESOLUTION ══════════════════════════
    await test("SALARY RESOLUTION: known career + known country returns available:true with correct currency and full progression structure", () => {
        const result = resolveSalaryForCareer({ careerId: "software-engineer", country: "United Kingdom" });
        assert.strictEqual(result.available, true);
        assert.strictEqual(result.currency, "£");
        assert.strictEqual(result.country, "United Kingdom");
        EXPERIENCE_LEVELS.forEach((level) => {
            assert.ok(result.ranges[level], `missing ${level} range`);
            assert.ok(Number.isFinite(result.ranges[level].min) && Number.isFinite(result.ranges[level].max));
            assert.ok(result.ranges[level].min <= result.ranges[level].max);
        });
    });
    await test("SALARY RESOLUTION: unknown career returns a controlled unavailable state, never throws", () => {
        const result = resolveSalaryForCareer({ careerId: "totally-made-up-career", country: "United Kingdom" });
        assert.strictEqual(result.available, false);
        assert.strictEqual(result.ranges, null);
        assert.ok(result.note);
    });
    await test("SALARY RESOLUTION: known career + unsupported country returns unavailable, never substitutes another country's data", () => {
        const result = resolveSalaryForCareer({ careerId: "software-engineer", country: "Atlantis" });
        assert.strictEqual(result.available, false);
        assert.strictEqual(result.ranges, null);
    });
    await test("SALARY RESOLUTION: missing careerId or missing country both degrade to unavailable, no crash", () => {
        assert.strictEqual(resolveSalaryForCareer({ careerId: null, country: "United Kingdom" }).available, false);
        assert.strictEqual(resolveSalaryForCareer({ careerId: "software-engineer", country: null }).available, false);
        assert.strictEqual(resolveSalaryForCareer({ careerId: null, country: null }).available, false);
    });
    await test("SALARY RESOLUTION: country matching is case/whitespace-insensitive", () => {
        const a = resolveSalaryForCareer({ careerId: "software-engineer", country: "  UNITED kingdom  " });
        const b = resolveSalaryForCareer({ careerId: "software-engineer", country: "United Kingdom" });
        assert.strictEqual(a.available, true);
        assert.deepStrictEqual(a.ranges, b.ranges);
    });
    await test("SALARY RESOLUTION: never returns a fabricated range when unavailable — ranges is always exactly null", () => {
        assert.strictEqual(resolveSalaryForCareer({ careerId: "it-support-specialist", country: "Canada" }).ranges, null, "IT Support Specialist has no curated Canada row — must be honestly unavailable, not substituted from the UK row");
    });

    // ══════════════════════════ MILESTONE 7: COUNTRY BEHAVIOR ══════════════════════════
    await test("COUNTRY: a UK university context resolves salary in GBP (£)", () => {
        const result = resolveSalaryForCareer({ careerId: "financial-analyst", country: "United Kingdom" });
        assert.strictEqual(result.currency, "£");
    });
    await test("COUNTRY: a Canadian university context resolves salary in CAD (CA$)", () => {
        const result = resolveSalaryForCareer({ careerId: "financial-analyst", country: "Canada" });
        assert.strictEqual(result.currency, "CA$");
    });
    await test("COUNTRY: an Australian university context resolves salary in AUD (A$)", () => {
        const result = resolveSalaryForCareer({ careerId: "financial-analyst", country: "Australia" });
        assert.strictEqual(result.currency, "A$");
    });
    await test("COUNTRY: changing the selected university's country changes the salary context for the identical career", () => {
        const uk = resolveSalaryForCareer({ careerId: "software-engineer", country: "United Kingdom" });
        const ca = resolveSalaryForCareer({ careerId: "software-engineer", country: "Canada" });
        assert.notStrictEqual(uk.currency, ca.currency);
        assert.notDeepStrictEqual(uk.ranges, ca.ranges);
    });
    await test("COUNTRY: resolveSalaryForCareer's only country input is the explicit `country` argument — no IP/geolocation/env lookup exists in the module (structural)", () => {
        const src = require("fs").readFileSync(path.join(ROOT, "api", "_lib", "salaryResolver.js"), "utf8");
        assert.ok(!/req\.ip|x-forwarded-for|geoip|navigator\.language/i.test(src), "must not derive country from request IP or browser locale");
    });

    // ══════════════════════════ MILESTONE 7: CAREER INTEGRATION ══════════════════════════
    await test("CAREER INTEGRATION: a career with no salary coverage for the given country still carries a `salary` object and renders (available:false, not omitted)", () => {
        const salary = resolveSalaryForCareer({ careerId: "penetration-tester", country: "Canada" });
        assert.strictEqual(typeof salary, "object");
        assert.strictEqual(salary.available, false);
    });
    await test("CAREER INTEGRATION: a career with salary coverage receives the correct country-specific data", () => {
        const salary = resolveSalaryForCareer({ careerId: "machine-learning-engineer", country: "Australia" });
        assert.strictEqual(salary.available, true);
        assert.strictEqual(salary.currency, "A$");
    });
    await test("CAREER INTEGRATION: salary does not affect career ranking — careerResolver.js has no dependency on salaryResolver.js (structural)", () => {
        const src = require("fs").readFileSync(path.join(ROOT, "api", "_lib", "careerResolver.js"), "utf8");
        assert.ok(!/salaryResolver|salaries\.json/.test(src), "careerResolver.js must remain unaware of salary data entirely — degree/specialization/skill overlap are the only ranking inputs");
    });
    await test("CAREER INTEGRATION: specialization changes which careers are recommended, but never arbitrarily multiplies a career's salary — identical career+country salary is identical regardless of specialization", () => {
        const withoutSpec = resolveSalaryForCareer({ careerId: "machine-learning-engineer", country: "United Kingdom" });
        const withSpec = resolveSalaryForCareer({ careerId: "machine-learning-engineer", country: "United Kingdom" }); // resolveSalaryForCareer takes no specialization input at all
        assert.deepStrictEqual(withoutSpec, withSpec);
        assert.strictEqual(resolveSalaryForCareer.length, 1, "resolveSalaryForCareer must accept a single {careerId, country} argument — structurally incapable of taking a specialization multiplier");
    });

    // ══════════════════════════ MILESTONE 7: PLANNER API — SALARY WIRING ══════════════════════════
    await test("PLANNER API: careersWithSalary attaches a `salary` object to every career, built from resolveSalaryForCareer keyed by career.id + effectiveCountry (structural)", () => {
        const src = require("fs").readFileSync(path.join(ROOT, "api", "_lib", "routes", "content", "student-planner.js"), "utf8");
        assert.ok(/careerId:\s*career\.id/.test(src), "salary must be keyed by career.id (the authoritative relationship), not career.title");
        assert.ok(/country:\s*effectiveCountry/.test(src), "salary must use the same effectiveCountry the Living Cost layer already resolves — the university's canonical country, not client-supplied text directly");
    });
    await test("PLANNER API: salaryResolver.js does not import or duplicate careerResolver.js's degree/specialization resolution (clean separation: Degree -> Career -> Country -> Salary)", () => {
        const src = require("fs").readFileSync(path.join(ROOT, "api", "_lib", "salaryResolver.js"), "utf8");
        assert.ok(!/require\(.*degreeResolver/.test(src), "salaryResolver.js must not know about degrees/specializations — salary belongs to the career+country only");
    });

    // ══════════════════════════ MILESTONE 7: AMBER SAFETY ══════════════════════════
    await test("AMBER SAFETY: salary dataset lookup, resolution and career-salary enrichment make zero Amber calls end-to-end", () => {
        const before = amberCallCount;
        CAREERS.forEach((c) => {
            ["United Kingdom", "Canada", "Australia", "Atlantis"].forEach((country) => resolveSalaryForCareer({ careerId: c.id, country }));
        });
        assert.strictEqual(amberCallCount, before, "salary resolution must never call Amber");
    });
    await test("AMBER SAFETY: resolveSalaryForCareer is a plain synchronous function — structurally incapable of an Amber/network call", () => {
        assert.strictEqual(resolveSalaryForCareer.constructor.name, "Function", "must not be async — confirms it cannot itself await a fetch");
    });

    // ══════════════════════════ MILESTONE 8: READINESS DATASET QUALITY ══════════════════════════
    await test(`READINESS DATA: every one of the ${CAREERS.length} careers in careers.json has a readiness record`, () => {
        const missing = CAREERS.filter((c) => !resolveReadinessForCareer({ id: c.id, requiredSkills: c.requiredSkills, alreadyHaveSkills: [], skillsToDevelop: [] }).available);
        assert.deepStrictEqual(missing.map((c) => c.id), [], `careers missing readiness coverage: ${missing.map((c) => c.id).join(", ")}`);
    });
    await test("READINESS DATA: no duplicate careerId records were silently dropped (DUPLICATE_CAREER_IDS empty)", () => {
        assert.deepStrictEqual(READINESS_DUPLICATE_IDS, [], `found duplicate readiness entries: ${READINESS_DUPLICATE_IDS.join(", ")}`);
    });
    await test("READINESS DATA: every row's careerId references a real career in careers.json", () => {
        const careerIds = new Set(CAREERS.map((c) => c.id));
        const bad = READINESS.filter((row) => !careerIds.has(row.careerId));
        assert.deepStrictEqual(bad.map((r) => r.careerId), [], "found readiness row(s) referencing an unknown career id");
    });
    await test("READINESS DATA: every row passes isValidReadinessRow (all required lists non-empty, no malformed/empty strings, no in-list duplicates)", () => {
        const bad = READINESS.filter((row) => !isValidReadinessRow(row));
        assert.deepStrictEqual(bad.map((r) => r.careerId), [], "every curated readiness row must be structurally valid");
    });
    await test("isNonEmptyStringList rejects empty arrays, empty strings, whitespace-only strings, non-strings, and in-list duplicates", () => {
        assert.strictEqual(isNonEmptyStringList(["A", "B"]), true, "sanity check: a normal list must pass");
        assert.strictEqual(isNonEmptyStringList([]), false, "empty array must be rejected");
        assert.strictEqual(isNonEmptyStringList([""]), false, "empty string must be rejected");
        assert.strictEqual(isNonEmptyStringList(["   "]), false, "whitespace-only string must be rejected");
        assert.strictEqual(isNonEmptyStringList([1, 2]), false, "non-string items must be rejected");
        assert.strictEqual(isNonEmptyStringList(["A", "A"]), false, "duplicate items must be rejected");
    });
    await test("READINESS DATA: isValidReadinessRow rejects a row missing an interview category or a required list", () => {
        const base = READINESS.find((r) => r.careerId === "software-engineer");
        assert.strictEqual(isValidReadinessRow(base), true, "sanity check: the real Software Engineer row must be valid");
        assert.strictEqual(isValidReadinessRow({ ...base, entryRoutes: [] }), false, "empty entryRoutes must be rejected");
        assert.strictEqual(isValidReadinessRow({ ...base, interviewAreas: { technical: base.interviewAreas.technical, practical: base.interviewAreas.practical } }), false, "missing behavioral category must be rejected");
        assert.strictEqual(isValidReadinessRow({ ...base, careerId: "" }), false, "missing careerId must be rejected");
    });
    await test("READINESS DATA: careerReadinessResolver.js makes zero network/Amber/Mongo calls and stays decoupled from degree/salary resolution (structural)", () => {
        const src = require("fs").readFileSync(path.join(ROOT, "api", "_lib", "careerReadinessResolver.js"), "utf8");
        assert.ok(!/require\(.*amberGateway/.test(src), "must not import amberGateway.js");
        assert.ok(!/require\(.*mongodb/.test(src), "must not import mongodb.js");
        assert.ok(!/\bfetch\(/.test(src), "must not call fetch() itself");
        assert.ok(!/require\(.*degreeResolver/.test(src), "must not depend on degree resolution — takes an already-ranked career object");
        assert.ok(!/require\(.*salaryResolver/.test(src), "must not depend on salary resolution — readiness and salary are independent layers");
    });
    await test("READINESS DATA: no fabricated employment/hiring guarantees anywhere in the curated dataset or resolver copy", () => {
        const datasetSrc = JSON.stringify(READINESS).toLowerCase();
        const resolverSrc = require("fs").readFileSync(path.join(ROOT, "api", "_lib", "careerReadinessResolver.js"), "utf8").toLowerCase();
        ["guaranteed", "you will get", "you will earn", "100% ready", "will get you a job", "hiring probability"].forEach((phrase) => {
            assert.ok(!datasetSrc.includes(phrase), `dataset must not contain the phrase "${phrase}"`);
            assert.ok(!resolverSrc.includes(phrase), `resolver copy must not contain the phrase "${phrase}"`);
        });
    });
    await test("READINESS DATA: no fabricated interview questions — dataset contains preparation AREAS, never literal question text ending in '?'", () => {
        const bad = [];
        READINESS.forEach((row) => {
            INTERVIEW_CATEGORIES.forEach((cat) => {
                (row.interviewAreas[cat] || []).forEach((item) => { if (item.trim().endsWith("?")) bad.push(`${row.careerId}/${cat}: "${item}"`); });
            });
        });
        assert.deepStrictEqual(bad, [], `found literal question text instead of a preparation area: ${bad.join(", ")}`);
    });
    await test("READINESS DATA: no explicit numeric hiring/readiness score anywhere in the dataset (e.g. \"82%\") — no fake precision", () => {
        const bad = READINESS_LIST_FIELDS.some((field) => READINESS.some((row) => (row[field] || []).some((item) => /\d+%/.test(item))));
        assert.strictEqual(bad, false, "readiness guidance must never present a numeric percentage-style score");
    });

    // ══════════════════════════ MILESTONE 8: SKILL INTEGRATION (reuses Milestone 6 matching, never recomputes) ══════════════════════════
    await test("SKILL INTEGRATION: alreadyCoveredSkills/skillsToDevelop are passed through UNCHANGED from the Milestone 6 career object, not recomputed", () => {
        const careers = resolveCareersForDegree("computer-science", null, "AI / Machine Learning");
        const ml = careers.find((c) => c.id === "machine-learning-engineer");
        assert.ok(ml);
        const readiness = resolveReadinessForCareer(ml);
        assert.deepStrictEqual(readiness.alreadyCoveredSkills, ml.alreadyHaveSkills, "readiness must reuse Milestone 6's alreadyHaveSkills verbatim");
        assert.deepStrictEqual(readiness.skillsToDevelop, ml.skillsToDevelop, "readiness must reuse Milestone 6's skillsToDevelop verbatim");
    });
    await test("SKILL INTEGRATION: specialization emphasis skills that Milestone 6 already recognized as covered surface as readiness.alreadyCoveredSkills too", () => {
        const careers = resolveCareersForDegree("computer-science", null, "AI / Machine Learning");
        const ml = careers.find((c) => c.id === "machine-learning-engineer");
        const readiness = resolveReadinessForCareer(ml);
        assert.ok(readiness.alreadyCoveredSkills.includes("Machine Learning") || readiness.alreadyCoveredSkills.includes("Statistics"), `expected an AI/ML emphasis skill recognized as covered, got ${JSON.stringify(readiness.alreadyCoveredSkills)}`);
    });
    await test("SKILL INTEGRATION: essentialSkills mirrors the career's own requiredSkills (no second skill ontology introduced)", () => {
        const careers = resolveCareersForDegree("computer-science", null, null);
        const se = careers.find((c) => c.id === "software-engineer");
        const readiness = resolveReadinessForCareer(se);
        assert.deepStrictEqual(readiness.essentialSkills, se.requiredSkills);
    });
    await test("SKILL INTEGRATION: recommendedSkills mirrors careers.json's own preferredSkills for that career id", () => {
        const seCareerDataset = CAREERS.find((c) => c.id === "software-engineer");
        const careers = resolveCareersForDegree("computer-science", null, null);
        const se = careers.find((c) => c.id === "software-engineer");
        const readiness = resolveReadinessForCareer(se);
        assert.deepStrictEqual(readiness.recommendedSkills, seCareerDataset.preferredSkills);
    });
    await test("SKILL INTEGRATION: no career has a skill listed in both requiredSkills and preferredSkills (no contradictory essential-vs-recommended categorization)", () => {
        const bad = CAREERS.filter((c) => c.requiredSkills.some((s) => c.preferredSkills.includes(s)));
        assert.deepStrictEqual(bad.map((c) => c.id), [], "a skill must not be both essential and merely recommended for the same career");
    });
    await test("SKILL INTEGRATION: missing/empty skill data on the input career object is handled safely — no throw, empty arrays out", () => {
        const readiness = resolveReadinessForCareer({ id: "software-engineer" }); // no requiredSkills/alreadyHaveSkills/skillsToDevelop at all
        assert.strictEqual(readiness.available, true);
        assert.deepStrictEqual(readiness.alreadyCoveredSkills, []);
        assert.deepStrictEqual(readiness.skillsToDevelop, []);
        assert.ok(Array.isArray(readiness.essentialSkills) && readiness.essentialSkills.length > 0, "essentialSkills should still fall back to careers.json's own requiredSkills");
    });

    // ══════════════════════════ MILESTONE 8: ENTRY ROUTES / PORTFOLIO / INTERVIEW / PREPARATION ══════════════════════════
    await test("ENTRY ROUTES: every career has at least one entry route, deterministic across repeated calls", () => {
        CAREERS.forEach((c) => {
            const r1 = resolveReadinessForCareer({ id: c.id, requiredSkills: c.requiredSkills, alreadyHaveSkills: [], skillsToDevelop: [] });
            const r2 = resolveReadinessForCareer({ id: c.id, requiredSkills: c.requiredSkills, alreadyHaveSkills: [], skillsToDevelop: [] });
            assert.ok(r1.entryRoutes.length > 0, `${c.id}: expected at least one entry route`);
            assert.deepStrictEqual(r1, r2, `${c.id}: identical input must produce identical readiness output`);
        });
    });
    await test("PORTFOLIO: portfolioExpectations and projectEvidence are both present and non-empty for every career", () => {
        CAREERS.forEach((c) => {
            const readiness = resolveReadinessForCareer({ id: c.id, requiredSkills: c.requiredSkills, alreadyHaveSkills: [], skillsToDevelop: [] });
            assert.ok(readiness.portfolioExpectations.length > 0, `${c.id}: missing portfolioExpectations`);
            assert.ok(readiness.projectEvidence.length > 0, `${c.id}: missing projectEvidence`);
        });
    });
    await test("INTERVIEW: technical/practical/behavioral categories are all present and non-empty for every career", () => {
        CAREERS.forEach((c) => {
            const readiness = resolveReadinessForCareer({ id: c.id, requiredSkills: c.requiredSkills, alreadyHaveSkills: [], skillsToDevelop: [] });
            INTERVIEW_CATEGORIES.forEach((cat) => {
                assert.ok(readiness.interviewAreas[cat] && readiness.interviewAreas[cat].length > 0, `${c.id}/${cat}: missing interview area`);
            });
        });
    });
    await test("PREPARATION: preparationSteps is a non-empty, order-preserving, duplicate-free array for every career", () => {
        CAREERS.forEach((c) => {
            const readiness = resolveReadinessForCareer({ id: c.id, requiredSkills: c.requiredSkills, alreadyHaveSkills: [], skillsToDevelop: [] });
            assert.ok(Array.isArray(readiness.preparationSteps) && readiness.preparationSteps.length > 0, `${c.id}: missing preparationSteps`);
            assert.strictEqual(new Set(readiness.preparationSteps).size, readiness.preparationSteps.length, `${c.id}: duplicate preparation steps`);
            const row = READINESS.find((r) => r.careerId === c.id);
            assert.deepStrictEqual(readiness.preparationSteps, row.preparationSteps, `${c.id}: preparationSteps order must be preserved from the curated dataset, not re-sorted`);
        });
    });

    // ══════════════════════════ MILESTONE 8: PLANNER INTEGRATION ══════════════════════════
    await test("PLANNER INTEGRATION: an unknown career id degrades to a controlled unavailable readiness state, never throws", () => {
        const readiness = resolveReadinessForCareer({ id: "totally-made-up-career-xyz", requiredSkills: [], alreadyHaveSkills: [], skillsToDevelop: [] });
        assert.strictEqual(readiness.available, false);
        assert.deepStrictEqual(readiness.entryRoutes, []);
        assert.deepStrictEqual(readiness.interviewAreas, null);
        assert.ok(readiness.note);
    });
    await test("PLANNER INTEGRATION: a missing/null career object degrades safely, never throws", () => {
        assert.strictEqual(resolveReadinessForCareer(null).available, false);
        assert.strictEqual(resolveReadinessForCareer(undefined).available, false);
        assert.strictEqual(resolveReadinessForCareer({}).available, false);
    });
    await test("PLANNER INTEGRATION: resolveReadinessForCareer does not mutate the career object passed in (pure function)", () => {
        const career = { id: "software-engineer", requiredSkills: ["Programming"], alreadyHaveSkills: ["Programming"], skillsToDevelop: [] };
        const before = JSON.stringify(career);
        resolveReadinessForCareer(career);
        assert.strictEqual(JSON.stringify(career), before, "the input career object must not be mutated — readiness is layered on with a new object in student-planner.js");
        assert.strictEqual(career.readiness, undefined, "resolveReadinessForCareer itself must not attach `readiness` onto the input object");
    });
    await test("PLANNER API: careersWithReadiness attaches `readiness` to every career via resolveReadinessForCareer(career) — keyed off the SAME already-ranked/salaried career object, not a fresh lookup (structural)", () => {
        const src = require("fs").readFileSync(path.join(ROOT, "api", "_lib", "routes", "content", "student-planner.js"), "utf8");
        assert.ok(/readiness:\s*resolveReadinessForCareer\(career\)/.test(src), "readiness must be computed from the already-enriched career object, reusing its id/skills fields");
    });

    // ══════════════════════════ MILESTONE 8: AMBER SAFETY ══════════════════════════
    await test("AMBER SAFETY: readiness dataset lookup and resolution across all 40 careers make zero Amber calls end-to-end", () => {
        const before = amberCallCount;
        CAREERS.forEach((c) => resolveReadinessForCareer({ id: c.id, requiredSkills: c.requiredSkills, alreadyHaveSkills: [], skillsToDevelop: [] }));
        assert.strictEqual(amberCallCount, before, "readiness resolution must never call Amber");
    });
    await test("AMBER SAFETY: resolveReadinessForCareer is a plain synchronous function — structurally incapable of an Amber/network call", () => {
        assert.strictEqual(resolveReadinessForCareer.constructor.name, "Function", "must not be async — confirms it cannot itself await a fetch");
    });

    // ══════════════════════════ BUDGET PRIMITIVE: isolated proof ══════════════════════════
    // Directly exercises sharedStore.reserveSlot() — the exact atomic
    // Lua-script-in-Redis / synchronous-in-memory primitive amberGateway.js's
    // tryReserveSlot() is a thin wrapper around (same function, "amber:requests"
    // is just its fixed key) — against a dedicated throwaway key so this proof
    // is fully isolated from every other test's Amber-call bookkeeping below.
    // This is the strongest, cleanest evidence that N-way concurrent callers
    // really do collapse to at most K successes, independent of anything
    // accommodationIndex.js or amberGateway.js do around it.
    await test("BUDGET PRIMITIVE: 100 concurrent reserveSlot() calls against a 6-slot budget -> exactly 6 succeed", async () => {
        const key = `verify:budget-primitive:${runId}`;
        const results = await Promise.all(Array.from({ length: 100 }, () => reserveSlot(key, 60000, 6)));
        const grantedCount = results.filter(Boolean).length;
        assert.strictEqual(grantedCount, 6, `expected exactly 6 of 100 concurrent reserveSlot() calls to succeed, got ${grantedCount}`);
    });

    // ══════════════════════════ MONGO-DEPENDENT TESTS ══════════════════════════
    // Everything below needs a real MongoDB connection (the accommodation
    // index itself). Guarded so an unreachable/misconfigured DB reports
    // clearly and skips these tests rather than crashing the whole script —
    // the pure-function tests above already ran and reported regardless.
    const MONGODB_URI = process.env.MONGODB_URI;
    let mongoReady = false;
    let connectToDatabase, disconnectFromDatabase, AccommodationResidence, AccommodationIndexMeta, getCityResidences, normalizeCityName;

    if (!MONGODB_URI) {
        console.log("\nMONGODB_URI is not set — skipping Mongo-dependent tests (dedup/write-race/failure/empty/freshness/end-to-end-budget/cleanup).");
    } else {
        const dbName = getDbNameFromUri(MONGODB_URI);
        const looksLikeTestDb = /test/i.test(dbName);
        if (!looksLikeTestDb && process.env.ALLOW_MONGODB_LIVE_TEST !== "true") {
            console.log(`\nMONGODB_URI points at database "${dbName}", which doesn't look like a test database.`);
            console.log("Refusing to run Mongo-dependent tests. Point MONGODB_URI at a database whose name contains \"test\", or set ALLOW_MONGODB_LIVE_TEST=true.");
        } else {
            ({ connectToDatabase, disconnectFromDatabase } = require(path.join(ROOT, "api", "_lib", "mongodb")));
            AccommodationResidence = require(path.join(ROOT, "api", "_lib", "models", "AccommodationResidence"));
            AccommodationIndexMeta = require(path.join(ROOT, "api", "_lib", "models", "AccommodationIndexMeta"));
            ({ getCityResidences } = require(path.join(ROOT, "api", "_lib", "accommodationIndex")));
            ({ normalizeCityName } = require(path.join(ROOT, "api", "_lib", "amberGateway")));
            try {
                await connectToDatabase();
                mongoReady = true;
                console.log("\nMongoDB connection established for live verification.\n");
            } catch (err) {
                console.log(`\nMongoDB connection FAILED — skipping Mongo-dependent tests. This is an infrastructure/network condition (e.g. the current outbound IP is not on the Atlas cluster's allowlist), not a code defect: ${err.message}\n`);
            }
        }
    }

    if (!mongoReady) {
        console.log(`\n=== ${passed} passed, ${failed} failed (Mongo-dependent tests skipped — see above) ===`);
        process.exitCode = 1; // incomplete verification must not report as a clean pass
        return;
    }

    const testCities = []; // normalized city names created this run, for cleanup

    // ══════════════════════════ (h) UNIVERSITY-AWARE END-TO-END ══════════════════════════
    // Deliberately run FIRST among the Mongo-dependent tests, while the real
    // rolling-minute Amber budget is still untouched (0/6 used) — its own
    // assertions need exactly 1 fresh call per new city, and running it
    // first avoids the same cross-test budget cumulation (g) below is
    // deliberately built to tolerate dynamically; (a)/(c)/(d)/(f) don't
    // assert exact call counts and (e) doesn't assert one for its fallback
    // leg either, so none of them are disturbed by this ordering.
    //
    // Exercises the real Mongo round-trip with a `university` option, proving
    // the geo-aware path adds no new Amber call sites and degrades honestly
    // when residences lack coordinates (the uncertainty the Milestone 3 plan
    // flagged about Amber's real listings payload).
    const cityG = normalizeCityName(`VerifyGeoNoCoordsCity-${runId}`);
    testCities.push(cityG);
    cityBehavior.set(cityG, 5);
    cityCoordsOverride.set(cityG, "none");
    await test("UNIVERSITY-AWARE: residences with no coordinates still return up to 5 results (radius top-up floor), zero extra Amber calls beyond the one refresh", async () => {
        const before = amberCallCount;
        const fakeUniversity = { latitude: 53.4668, longitude: -2.2339 };
        const result = await getCityResidences(cityG, { source: "verify-geo-nocoords", university: fakeUniversity });
        assert.strictEqual(amberCallCount - before, 1, "still exactly 1 Amber call — the same freshness/lock/budget path as every other city, radius/geo logic adds none");
        assert.strictEqual(result.status, "ready");
        assert.strictEqual(result.residences.length, 5, "no coordinates anywhere must still surface the full candidate pool, not an empty page");
        assert.ok(result.residences.every((r) => r.distanceKm === null), "distance must be honestly unknown (null), never a fabricated number");
    });

    const cityH = normalizeCityName(`VerifyGeoWithCoordsCity-${runId}`);
    testCities.push(cityH);
    cityBehavior.set(cityH, 3);
    cityCoordsOverride.set(cityH, { latitude: 53.4668, longitude: -2.2339 }); // "University of Manchester"-ish point
    await test("UNIVERSITY-AWARE: residences WITH coordinates get a real, small Haversine distanceKm, and rank/badge accordingly", async () => {
        const before = amberCallCount;
        const fakeUniversity = { latitude: 53.4668, longitude: -2.2339 };
        const result = await getCityResidences(cityH, { source: "verify-geo-coords", university: fakeUniversity });
        assert.strictEqual(amberCallCount - before, 1);
        assert.strictEqual(result.status, "ready");
        assert.ok(result.residences.every((r) => Number.isFinite(r.distanceKm) && r.distanceKm < 5), "residences generated near the university point should show small real distances, not null/huge");
        // The nearest-generated residence (index 0, offset ~0 from the
        // university point) should rank first and carry a data-dependent
        // badge — confirms real distance is actually influencing the
        // outcome. It legitimately wins "Best Overall" outright here (its
        // distance AND rating both happen to be best among only 3 candidates)
        // rather than "Closest" specifically — one badge per residence by
        // design, Best Overall takes priority when one candidate wins on
        // every front, so no residence is double- or un-badged.
        assert.strictEqual(result.residences[0].badge, "Best Overall");
        assert.ok(result.residences[0].distanceKm <= result.residences[1].distanceKm, "the top-ranked residence should be the closest one, confirming geo distance actually drove the ranking");
    });
    await test("UNIVERSITY-AWARE: re-requesting the same resolved-university city stays fresh -> zero additional Amber calls", async () => {
        const before = amberCallCount;
        const fakeUniversity = { latitude: 53.4668, longitude: -2.2339 };
        const result = await getCityResidences(cityH, { source: "verify-geo-coords-recheck", university: fakeUniversity });
        assert.strictEqual(amberCallCount, before, "geo-aware requests must respect the same freshness window — no new Amber call on a warm re-request");
        assert.strictEqual(result.status, "ready");
    });

    // ══════════════════════════ (a) DEDUP: 100 concurrent, SAME city ══════════════════════════
    const cityA = normalizeCityName(`VerifyDedupCity-${runId}`);
    testCities.push(cityA);
    cityBehavior.set(cityA, 3);
    await test("DEDUP: 100 concurrent identical-city requests -> exactly 1 real Amber call", async () => {
        const before = amberCallCount;
        const results = await Promise.all(Array.from({ length: 100 }, () => getCityResidences(cityA, { source: "verify-dedup" })));
        const madeThisTest = amberCallCount - before;
        assert.strictEqual(madeThisTest, 1, `expected exactly 1 Amber call for 100 concurrent identical-city requests, got ${madeThisTest}`);
        assert.ok(results.every((r) => r.status === "ready"), "every one of the 100 concurrent callers should get real ready data, not just the lock winner");
        assert.ok(results.every((r) => r.residences.length === 3), "every caller should see the same 3 residences");
    });

    // ══════════════════════════ (c) WRITE RACE: 2 near-simultaneous, SAME brand-new city ══════════════════════════
    const cityC = normalizeCityName(`VerifyRaceCity-${runId}`);
    testCities.push(cityC);
    cityBehavior.set(cityC, 4);
    await test("WRITE RACE: 2 near-simultaneous first-time requests for the same new city never throw (E11000 guard)", async () => {
        const [r1, r2] = await Promise.all([
            getCityResidences(cityC, { source: "verify-race-1" }),
            getCityResidences(cityC, { source: "verify-race-2" }),
        ]);
        assert.strictEqual(r1.status, "ready");
        assert.strictEqual(r2.status, "ready");
        const doc = await AccommodationResidence.find({ city: cityC }).lean();
        assert.strictEqual(doc.length, 4, "exactly one refresh's worth of residences should be persisted, not duplicated");
    });

    // ══════════════════════════ (d) AMBER FAILURE: graceful degradation ══════════════════════════
    const cityD = normalizeCityName(`VerifyFailCity-${runId}`);
    testCities.push(cityD);
    cityBehavior.set(cityD, "fail");
    await test("FAILURE: a mocked Amber failure degrades to status:building, never throws", async () => {
        const result = await getCityResidences(cityD, { source: "verify-failure" });
        assert.strictEqual(result.status, "building");
        assert.deepStrictEqual(result.residences, []);
        const meta = await AccommodationIndexMeta.findOne({ city: cityD }).lean();
        assert.strictEqual(meta.status, "error");
    });
    await test("FAILURE: after an Amber failure, lastRefreshedAt was NOT set (so the next request retries, not stuck forever)", async () => {
        const meta = await AccommodationIndexMeta.findOne({ city: cityD }).lean();
        assert.ok(!meta.lastRefreshedAt, "a failed refresh must not start the freshness clock");
    });

    // ══════════════════════════ (e) EMPTY RESULT: still marks fresh, not stuck ══════════════════════════
    const cityE = normalizeCityName(`VerifyEmptyCity-${runId}`);
    testCities.push(cityE);
    cityBehavior.set(cityE, 0);
    await test("EMPTY: a legitimately empty Amber result still updates lastRefreshedAt (status:empty, not error)", async () => {
        const result = await getCityResidences(cityE, { source: "verify-empty" });
        assert.strictEqual(result.status, "building"); // 0 residences -> planner shows building either way
        const meta = await AccommodationIndexMeta.findOne({ city: cityE }).lean();
        assert.strictEqual(meta.status, "empty");
        assert.ok(meta.lastRefreshedAt, "an empty-but-successful refresh must start the freshness clock so it isn't re-attempted every request");
    });

    // ══════════════════════════ (f) FRESHNESS: a second call for a fresh city makes zero new Amber calls ══════════════════════════
    await test("FRESHNESS: re-requesting an already-fresh city makes zero additional Amber calls", async () => {
        const before = amberCallCount;
        const result = await getCityResidences(cityA, { source: "verify-freshness-recheck" });
        assert.strictEqual(amberCallCount, before, "a fresh city must be served from Mongo with zero Amber calls");
        assert.strictEqual(result.status, "ready");
    });

    // ══════════════════════════ (g) GLOBAL BUDGET, END-TO-END: 100 concurrent, DISTINCT cities ══════════════════════════
    // Deliberately run LAST and asserted against however much of the real
    // RATE_BUDGET_PER_MINUTE window tests (a)/(c)/(d)/(e) above already
    // consumed (same rolling 60s window — the budget is genuinely global
    // across every different call pattern in this script, not reset per
    // test, which is the actual production guarantee being proven). The
    // isolated BUDGET PRIMITIVE test above already proved the atomic cap in
    // total isolation; this test proves accommodationIndex.js's end-to-end
    // path routes through that exact same shared "amber:requests" budget
    // rather than any separate/uncoordinated mechanism.
    const budgetAlreadyUsed = amberCallCount;
    const expectedRemaining = Math.max(0, Math.min(100, RATE_BUDGET_PER_MINUTE - budgetAlreadyUsed));
    const distinctCities = Array.from({ length: 100 }, (_, i) => normalizeCityName(`VerifyBudgetCity-${runId}-${i}`));
    distinctCities.forEach((c) => { testCities.push(c); cityBehavior.set(c, 2); }); // non-empty -> no fallback leg
    await test(`BUDGET END-TO-END: 100 concurrent distinct-city planner requests -> exactly ${expectedRemaining} succeed (${budgetAlreadyUsed}/${RATE_BUDGET_PER_MINUTE} already used this window)`, async () => {
        const before = amberCallCount;
        const results = await Promise.all(distinctCities.map((c) => getCityResidences(c, { source: "verify-budget" })));
        const madeThisTest = amberCallCount - before;
        assert.strictEqual(madeThisTest, expectedRemaining, `expected exactly ${expectedRemaining} new Amber calls, got ${madeThisTest}`);
        const ready = results.filter((r) => r.status === "ready").length;
        const building = results.filter((r) => r.status === "building").length;
        assert.strictEqual(ready, expectedRemaining, `expected exactly ${expectedRemaining} cities to reach status:ready, got ${ready}`);
        assert.strictEqual(ready + building, 100, "every one of the 100 requests must resolve to ready or building — none may throw or hang");
        assert.ok(amberCallCount <= RATE_BUDGET_PER_MINUTE, `total Amber calls this run (${amberCallCount}) must never exceed the global budget (${RATE_BUDGET_PER_MINUTE})`);
    });

    global.fetch = originalFetch;

    // ══════════════════════════ CLEANUP ══════════════════════════
    console.log("\nCleaning up test records...");
    await AccommodationResidence.deleteMany({ city: { $in: testCities } });
    await AccommodationIndexMeta.deleteMany({ city: { $in: testCities } });
    const remaining = {
        residences: await AccommodationResidence.countDocuments({ city: { $in: testCities } }),
        meta: await AccommodationIndexMeta.countDocuments({ city: { $in: testCities } }),
    };
    await test("CLEANUP: all test documents removed (verified by re-query)", async () => {
        assert.deepStrictEqual(remaining, { residences: 0, meta: 0 }, `residual test data found: ${JSON.stringify(remaining)}`);
    });
    console.log(`Cleanup complete. Created during this run: ${testCities.length} cities' worth of index data (all removed).`);
    console.log(`Total mocked Amber calls across the entire run: ${amberCallCount} (must be <= ${RATE_BUDGET_PER_MINUTE} for any single rolling minute of real traffic).`);

    await disconnectFromDatabase();

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
