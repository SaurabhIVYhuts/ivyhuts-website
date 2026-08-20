#!/usr/bin/env node
// Milestone 3 (P0 rate-limit + latency fixes) verification.
//
// Covers the P0-12 test list from the milestone brief:
//   TEST 1  same city requested twice sequentially -> second uses cache
//   TEST 2  same city requested concurrently -> one logical Amber fetch (coalescing)
//   TEST 3  requested limit smaller than a full page -> no unnecessary extra page
//   TEST 4  requested limit needs multiple pages -> fetches only what's required,
//           never the pre-fix behavior of continuing past a satisfied limit
//   TEST 5  Amber returns an empty page before the target is reached -> safe termination
//   TEST 6  Amber rate budget exhausted -> existing budget/error behavior intact
//   TEST 7/8/9/10 + P0-11 -> structural regression guards (see below)
//
// SAFETY: this script never calls the real Amber API. `global.fetch` is
// replaced with an in-process mock for every functional test below, so
// nothing here can consume any real Amber rate-budget slot or write real
// data anywhere. This mirrors the existing repo convention (plain node
// scripts, `assert`, a `test()` runner) already used by every other
// scripts/verify-*.js file — no new test framework was introduced.
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
        console.log(`  FAIL  ${name}\n        ${err.stack || err.message}`);
    }
}

// ── Deterministic Amber mock ──────────────────────────────────────────────
// Keyed by "<city>:<page>" (lowercased city, as amberGateway.js's own
// normalizeCityName would produce). Each entry is the array of raw items
// that page should return. A missing key means "empty page" (Amber ran out
// of results), matching TEST 5's scenario without any special-casing.
function makeItem(id, cityName) {
    return { id, name: `Property ${id}`, location: { locality: { long_name: cityName } } };
}

function makeAmberMock(pages) {
    const calls = [];
    async function fetchMock(url) {
        calls.push(url);
        const u = new URL(url);
        const page = Number(u.searchParams.get("p")) || 1;
        const city = (u.searchParams.get("location_place_name") || "").toLowerCase();
        const key = `${city}:${page}`;
        const items = pages[key] || [];
        return {
            ok: true,
            status: 200,
            headers: { get: () => null },
            json: async () => ({ message: "success", data: { result: items, meta: { count: items.length } } }),
        };
    }
    return { fetchMock, calls };
}

// Loads a FRESH copy of amberGateway.js (and its sharedStore.js dependency)
// with its own isolated in-memory cache/lock/budget state and its own
// `global.fetch` mock — required so TEST 6 (budget exhaustion) can use a
// small, deliberately-controlled AMBER_MAX_REQUESTS_PER_MINUTE without any
// of the other tests' cache entries or budget usage leaking in, and so nne
// test's mock fetch doesn't answer another test's request.
function freshGateway(pages, envOverrides = {}) {
    const sharedStorePath = path.join(ROOT, "api", "_lib", "sharedStore.js");
    const amberGatewayPath = path.join(ROOT, "api", "_lib", "amberGateway.js");
    delete require.cache[require.resolve(sharedStorePath)];
    delete require.cache[require.resolve(amberGatewayPath)];
    const prevEnv = {};
    for (const [k, v] of Object.entries(envOverrides)) {
        prevEnv[k] = process.env[k];
        process.env[k] = v;
    }
    const { fetchMock, calls } = makeAmberMock(pages);
    global.fetch = fetchMock;
    const gateway = require(amberGatewayPath);
    return {
        gateway,
        calls,
        restoreEnv: () => {
            for (const [k, v] of Object.entries(prevEnv)) {
                if (v === undefined) delete process.env[k];
                else process.env[k] = v;
            }
        },
    };
}

async function main() {
    console.log("=== IVYHUTS Milestone 3 — P0 Rate-Limit + Latency Fix Verification ===\n");

    // ══════════════════════ TEST 1 — cache reuse on sequential identical requests ══════════════════════
    await test("TEST 1: same city requested twice sequentially -> second request is a cache HIT, zero extra Amber calls", async () => {
        const city = "pagination-test-cache-city";
        const { gateway, calls } = freshGateway({
            [`${city}:1`]: [makeItem(1, city), makeItem(2, city)],
        });
        const first = await gateway.fetchListings({ city, page: 1, limit: 50 }, "MEDIUM", "test1");
        assert.strictEqual(first.cacheStatus, "MISS");
        assert.strictEqual(calls.length, 1, "first request should hit Amber exactly once");

        const second = await gateway.fetchListings({ city, page: 1, limit: 50 }, "MEDIUM", "test1");
        assert.strictEqual(second.cacheStatus, "HIT", "second identical request must be served from cache");
        assert.strictEqual(calls.length, 1, "second request must NOT make any additional Amber call");
    });

    // ══════════════════════ TEST 2 — concurrent identical requests coalesce ══════════════════════
    await test("TEST 2: three concurrent identical requests for the same city coalesce into ONE upstream Amber call", async () => {
        const city = "pagination-test-coalesce-city";
        const sharedStorePath = path.join(ROOT, "api", "_lib", "sharedStore.js");
        const amberGatewayPath = path.join(ROOT, "api", "_lib", "amberGateway.js");
        delete require.cache[require.resolve(sharedStorePath)];
        delete require.cache[require.resolve(amberGatewayPath)];
        const calls = [];
        global.fetch = async (url) => {
            calls.push(url);
            // Simulate real Amber latency so the two "losing" callers are
            // still mid-poll when the winner's write lands — proves the
            // lock+poll path is what's coalescing them, not luck/ordering.
            await new Promise((resolve) => setTimeout(resolve, 100));
            const u = new URL(url);
            const items = [makeItem(1, city), makeItem(2, city)];
            return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ message: "success", data: { result: items, meta: { count: items.length } } }) };
        };
        const gateway = require(amberGatewayPath);
        const params = { type: "listings", params: { city, page: 1, limit: 50 }, priority: "MEDIUM", source: "test2" };
        const [a, b, c] = await Promise.all([
            gateway.fetchAmber(params),
            gateway.fetchAmber(params),
            gateway.fetchAmber(params),
        ]);
        assert.strictEqual(calls.length, 1, `expected exactly one real Amber call for 3 concurrent identical requests, got ${calls.length}`);
        const statuses = [a.cacheStatus, b.cacheStatus, c.cacheStatus].sort();
        // Exactly one caller is the lock winner (MISS); the other two must
        // have waited for and reused that result, never called Amber themselves.
        assert.strictEqual(statuses.filter((s) => s === "MISS").length, 1, "exactly one caller should be the lock winner");
        assert.strictEqual(statuses.filter((s) => s === "HIT_AFTER_WAIT").length, 2, "the other two callers must reuse the winner's result, not call Amber");
    });

    // ══════════════════════ TEST 3 — requested limit smaller than a full page ══════════════════════
    await test("TEST 3: requested limit already satisfied by page 1 -> no second page is fetched", async () => {
        const city = "pagination-test-small-limit-city";
        const { gateway, calls } = freshGateway({
            [`${city}:1`]: Array.from({ length: 10 }, (_, i) => makeItem(i + 1, city)),
            // A page-2 handler exists specifically so the assertion below can
            // prove it was never touched, not just that no error occurred.
            [`${city}:2`]: Array.from({ length: 10 }, (_, i) => makeItem(100 + i, city)),
        });
        const result = await gateway.fetchListings({ city, page: 1, limit: 10 }, "MEDIUM", "test3");
        const items = result.data.data.result;
        assert.strictEqual(items.length, 10);
        assert.strictEqual(calls.length, 1, "must not fetch page 2 once the requested limit is already met");
        assert.ok(!calls.some((u) => new URL(u).searchParams.get("p") === "2"), "page 2 must never have been requested");
    });

    // ══════════════════════ TEST 4 — requested limit needs multiple pages, but stops once met ══════════════════════
    await test("TEST 4 (P0-1 core regression): a large city needing 2 pages to satisfy the requested limit fetches exactly 2 pages, never a 3rd — this is the exact pagination-amplification bug the audit found", async () => {
        const city = "pagination-test-multipage-city";
        // Page 1: 50 raw items, but only 30 genuinely match this city (the
        // rest are Amber location-filter noise) -> trustworthy (30 >= the
        // suspicious-match threshold) but short of the 50-item target, so a
        // second page is legitimately needed (preserves completeness).
        const page1 = [
            ...Array.from({ length: 30 }, (_, i) => makeItem(i + 1, city)),
            ...Array.from({ length: 20 }, (_, i) => makeItem(1000 + i, "some-other-city")),
        ];
        // Page 2: a full 50-item page, ALL matching this city. Merged total
        // after page 2 is 30 + 50 = 80, comfortably over the 50 requested.
        // Pre-fix, the loop only looked at "was page 2 full?" (yes) and would
        // have gone on to fetch page 3, 4, ... up to the 12-page cap. Post-fix
        // it must stop here because the requested limit is already satisfied.
        const page2 = Array.from({ length: 50 }, (_, i) => makeItem(2000 + i, city));
        const page3 = Array.from({ length: 50 }, (_, i) => makeItem(3000 + i, city)); // must never be fetched
        const { gateway, calls } = freshGateway({
            [`${city}:1`]: page1,
            [`${city}:2`]: page2,
            [`${city}:3`]: page3,
        });
        const result = await gateway.fetchListings({ city, page: 1, limit: 50 }, "MEDIUM", "test4");
        const items = result.data.data.result;
        assert.strictEqual(calls.length, 2, `expected exactly 2 Amber calls (page 1 + page 2), got ${calls.length} — pagination did not stop once the requested limit was satisfied`);
        assert.ok(!calls.some((u) => new URL(u).searchParams.get("p") === "3"), "page 3 must never have been requested once 50+ genuine matches were already collected");
        assert.strictEqual(items.length, 80, "all genuinely-matched items collected across the 2 necessary pages must still be returned (completeness preserved)");
    });

    // ══════════════════════ TEST 5 — empty page before target reached -> safe termination ══════════════════════
    await test("TEST 5: Amber returns an empty page before the requested limit is reached -> terminates safely, returns whatever was genuinely collected", async () => {
        const city = "pagination-test-emptypage-city";
        const page1 = [
            ...Array.from({ length: 20 }, (_, i) => makeItem(i + 1, city)),
            ...Array.from({ length: 30 }, (_, i) => makeItem(4000 + i, "some-other-city")),
        ];
        // No `${city}:2` entry registered at all -> the mock's default
        // (empty array) simulates Amber genuinely running out of pages.
        const { gateway, calls } = freshGateway({ [`${city}:1`]: page1 });
        const result = await gateway.fetchListings({ city, page: 1, limit: 50 }, "MEDIUM", "test5");
        const items = result.data.data.result;
        assert.strictEqual(calls.length, 2, "should attempt exactly one follow-up page before discovering it's empty");
        assert.strictEqual(items.length, 20, "the 20 genuine page-1 matches must still be returned, never discarded because a later page came back empty");
    });

    // ══════════════════════ TEST 6 — rate budget exhaustion is unchanged ══════════════════════
    await test("TEST 6 (P0-8): the existing per-minute Amber budget still caps real upstream calls, and a caller past the cap gets the existing budget_exceeded error — this fix never raises the budget", async () => {
        const { gateway, calls, restoreEnv } = freshGateway(
            {
                "budget-city-a:1": [makeItem(1, "budget-city-a")],
                "budget-city-b:1": [makeItem(2, "budget-city-b")],
                "budget-city-c:1": [makeItem(3, "budget-city-c")],
            },
            { AMBER_MAX_REQUESTS_PER_MINUTE: "2" }
        );
        try {
            assert.strictEqual(gateway.RATE_BUDGET_PER_MINUTE, 2, "budget constant must reflect the configured value, not a value this fix silently raised");
            const a = await gateway.fetchListings({ city: "budget-city-a", page: 1, limit: 50 }, "MEDIUM", "test6");
            const b = await gateway.fetchListings({ city: "budget-city-b", page: 1, limit: 50 }, "MEDIUM", "test6");
            assert.strictEqual(a.cacheStatus, "MISS");
            assert.strictEqual(b.cacheStatus, "MISS");
            assert.strictEqual(calls.length, 2, "the first 2 distinct-city requests should consume the full 2-slot budget");

            await assert.rejects(
                () => gateway.fetchListings({ city: "budget-city-c", page: 1, limit: 50 }, "MEDIUM", "test6"),
                (err) => {
                    assert.strictEqual(err.code, "budget_exceeded");
                    assert.strictEqual(err.status, 429);
                    return true;
                },
                "a 3rd distinct-city request past the 2-slot budget must still be rejected exactly as before this fix"
            );
            assert.strictEqual(calls.length, 2, "the rejected request must not have consumed a real Amber call");
        } finally {
            restoreEnv();
        }
    });

    // ══════════════════════ TEST 7/8 + P0-11 — known university regression guard ══════════════════════
    const CAMPUS_UNIVERSITIES = JSON.parse(fs.readFileSync(path.join(ROOT, "src", "data", "campusUniversities.json"), "utf8"));
    const KNOWN_UNIVERSITIES = [
        { id: "university-of-manchester", city: "Manchester" },
        { id: "university-of-derby", city: "Derby" },
        { id: "university-of-wollongong-dubai", city: "Dubai" },
        { id: "st-georges-university-of-london" },
        { id: "vamos-spanish-academy-madrid", city: "Madrid" },
        { id: "campus-velbert-heiligenhaus" },
    ];
    for (const known of KNOWN_UNIVERSITIES) {
        await test(`TEST 7/8/P0-11 REGRESSION: ${known.id} still exists in campusUniversities.json with its city/id intact after this milestone's changes`, () => {
            const u = CAMPUS_UNIVERSITIES.find((x) => x.id === known.id);
            assert.ok(u, `${known.id} not found — a known university record was removed or renamed`);
            if (known.city) assert.strictEqual(u.city, known.city);
        });
    }
    await test("P0-11 REGRESSION: neither amberGateway.js nor accommodationIndex.js contains any city-specific CONDITIONAL branch (this fix is generic, not special-cased per city) — pre-existing historical-incident comments (e.g. the documented Derby mistagging investigation) are expected and untouched", () => {
        for (const f of ["amberGateway.js", "accommodationIndex.js"]) {
            const src = fs.readFileSync(path.join(ROOT, "api", "_lib", f), "utf8");
            for (const city of ["manchester", "derby", "wollongong", "madrid", "velbert"]) {
                // Only flag an actual conditional/branch on the city name
                // (e.g. `city === "derby"`, `if (city == 'Manchester')`) —
                // not the file's own pre-existing prose comments describing
                // a past real-world incident involving that city.
                const branchPattern = new RegExp(`(if\\s*\\(|===|==|\\.includes\\()\\s*["'\`][^"'\`]*${city}`, "i");
                assert.ok(!branchPattern.test(src), `${f} must not contain a city-specific conditional branch for "${city}"`);
            }
        }
    });

    // ══════════════════════ TEST 9 — frontend stale-response guard still present ══════════════════════
    await test("TEST 9 (P0-6): UniversityHousingPage.js's property-fetch effect still discards a stale in-flight response when the university changes mid-flight (Manchester -> Derby cannot overwrite Derby's own result)", () => {
        const src = fs.readFileSync(path.join(ROOT, "src", "pages", "UniversityHousingPage.js"), "utf8");
        // The effect must declare a `cancelled` flag, set it true in its
        // cleanup function, and check it before applying the fetch result —
        // this is what makes a stale response for the PREVIOUS university a
        // no-op once the effect has re-run for a new one.
        assert.ok(/let cancelled = false;/.test(src), "expected a `cancelled` guard flag in the property-fetch effect");
        assert.ok(/return \(\) => \{ cancelled = true; \};/.test(src), "expected the effect's cleanup to set cancelled = true");
        assert.ok(/if \(cancelled\) return;/.test(src), "expected the async fetch body to bail out once cancelled");
    });

    // ══════════════════════ TEST 10 — map never fetches ══════════════════════
    await test("TEST 10 (P0-5): UniversityHousingMap.js issues zero network requests — it only renders already-loaded `properties`", () => {
        const src = fs.readFileSync(path.join(ROOT, "src", "components", "universityHousing", "UniversityHousingMap.js"), "utf8");
        assert.ok(!/\bfetch\(/.test(src), "UniversityHousingMap.js must never call fetch()");
        assert.ok(!/axios/i.test(src), "UniversityHousingMap.js must never call axios");
    });

    // ══════════════════════ P0-14 structural guard — no duplicate infrastructure introduced ══════════════════════
    await test("P0-14 STRUCTURAL: this milestone introduced no second Amber client/gateway and no second Amber-specific rate limiter (pre-existing, unrelated authRateLimit.js/businessRateLimit.js are expected and untouched)", () => {
        const libDir = path.join(ROOT, "api", "_lib");
        const files = fs.readdirSync(libDir);
        const suspicious = files.filter((f) => /amber/i.test(f) && f !== "amberGateway.js" && f !== "accommodationIndex.js");
        assert.deepStrictEqual(suspicious, [], `unexpected new Amber-related file(s) that look like duplicate infrastructure: ${suspicious.join(", ")}`);
        const amberGatewaySrc = fs.readFileSync(path.join(libDir, "amberGateway.js"), "utf8");
        const baseUrlRefs = (amberGatewaySrc.match(/amberstudent\.com/g) || []).length;
        assert.strictEqual(baseUrlRefs, 1, `exactly one Amber base URL reference must remain in amberGateway.js, found ${baseUrlRefs}`);
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
