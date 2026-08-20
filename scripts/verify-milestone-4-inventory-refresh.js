#!/usr/bin/env node
// Milestone 4 (Accommodation Inventory Index Reliability) verification.
// See IVYHUTS_MILESTONE_4_INVENTORY_REFRESH_REPORT.md for the full design.
//
// SAFETY:
//   - Every test that would otherwise reach Amber mocks `global.fetch` with
//     a canned Amber-shaped response — this script can never make a real
//     Amber HTTP call or consume any real Amber rate-budget slot.
//   - Every test that touches the refresh lock/queue forces sharedStore.js's
//     deterministic in-memory fallback (by temporarily unsetting the Redis
//     env vars before each fresh require, same technique
//     scripts/verify-p0-rate-latency-fixes.js already established) — this
//     script never writes to the real production Redis instance.
//   - Tests that need AccommodationIndexMeta/AccommodationResidence state
//     use REAL MongoDB (confirmed reachable from this environment) but ONLY
//     ever touch documents for synthetic city names prefixed
//     "zzz-milestone4-test-" — cleaned up in a try/finally BEFORE and AFTER
//     every test, so a crashed run can never leave stray test data behind
//     and this script can never affect a real city's data. If MongoDB is
//     ever unreachable from a given run, these tests are skipped with a
//     clear message rather than hanging or fabricating a pass.
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
require("dotenv").config({ path: path.join(ROOT, ".env.local") });
require("dotenv").config({ path: path.join(ROOT, ".env") });

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];

async function test(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  PASS  ${name}`);
    } catch (err) {
        if (err && err.__skip) {
            skipped++;
            console.log(`  SKIP  ${name}\n        ${err.message}`);
            return;
        }
        failed++;
        failures.push({ name, message: err.message });
        console.log(`  FAIL  ${name}\n        ${err.stack || err.message}`);
    }
}

function skip(reason) {
    const err = new Error(reason);
    err.__skip = true;
    throw err;
}

// ── Amber mock (same shape as Milestone 3's verify-p0-rate-latency-fixes.js) ──
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
        const items = pages[`${city}:${page}`] || [];
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ message: "success", data: { result: items, meta: { count: items.length } } }) };
    }
    return { fetchMock, calls };
}
function makeAmberFailureMock() {
    const calls = [];
    async function fetchMock(url) {
        calls.push(url);
        return { ok: false, status: 500, headers: { get: () => null }, json: async () => ({}) };
    }
    return { fetchMock, calls };
}

// ── Fresh module loader: forces sharedStore.js's in-memory Redis fallback
// (deterministic lock/queue state, zero real Redis writes) and installs an
// Amber mock, while reusing the SAME real Mongo connection/model registry
// across every test (mongodb.js and the model files are deliberately never
// cleared from require.cache).
const REDIS_ENV_KEYS = ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_URL", "KV_REST_API_TOKEN"];
function freshAccommodationIndex({ pages, failAmber, envOverrides = {} } = {}) {
    const sharedStorePath = path.join(ROOT, "api", "_lib", "sharedStore.js");
    const amberGatewayPath = path.join(ROOT, "api", "_lib", "amberGateway.js");
    const accIndexPath = path.join(ROOT, "api", "_lib", "accommodationIndex.js");
    delete require.cache[require.resolve(sharedStorePath)];
    delete require.cache[require.resolve(amberGatewayPath)];
    delete require.cache[require.resolve(accIndexPath)];

    const prevEnv = {};
    for (const k of REDIS_ENV_KEYS) { prevEnv[k] = process.env[k]; delete process.env[k]; } // force in-memory fallback
    for (const [k, v] of Object.entries(envOverrides)) { prevEnv[k] = prevEnv[k] ?? process.env[k]; process.env[k] = v; }

    const { fetchMock, calls } = failAmber ? makeAmberFailureMock() : makeAmberMock(pages || {});
    global.fetch = fetchMock;

    const accommodationIndex = require(accIndexPath);
    return {
        accommodationIndex,
        calls,
        restoreEnv: () => {
            for (const [k, v] of Object.entries(prevEnv)) {
                if (v === undefined) delete process.env[k];
                else process.env[k] = v;
            }
        },
    };
}

// ── Mongo test-city helpers ──────────────────────────────────────────────
let mongoAvailable = null; // tri-state: null = not yet probed
async function probeMongo() {
    if (mongoAvailable !== null) return mongoAvailable;
    try {
        const { connectToDatabase } = require(path.join(ROOT, "api", "_lib", "mongodb"));
        await Promise.race([
            connectToDatabase(),
            new Promise((_, reject) => setTimeout(() => reject(new Error("probe timeout")), 8000)),
        ]);
        mongoAvailable = true;
    } catch (err) {
        mongoAvailable = false;
    }
    return mongoAvailable;
}

async function requireMongo() {
    const ok = await probeMongo();
    if (!ok) skip("MongoDB is not reachable from this environment — skipping (not fabricating a pass)");
}

async function cleanupTestCity(city) {
    const AccommodationIndexMeta = require(path.join(ROOT, "api", "_lib", "models", "AccommodationIndexMeta"));
    const AccommodationResidence = require(path.join(ROOT, "api", "_lib", "models", "AccommodationResidence"));
    await AccommodationIndexMeta.deleteMany({ city });
    await AccommodationResidence.deleteMany({ city });
}

async function seedMeta(city, fields) {
    const AccommodationIndexMeta = require(path.join(ROOT, "api", "_lib", "models", "AccommodationIndexMeta"));
    await AccommodationIndexMeta.updateOne({ city }, { $set: { city, ...fields } }, { upsert: true });
}

async function seedResidence(city, propertyId) {
    const AccommodationResidence = require(path.join(ROOT, "api", "_lib", "models", "AccommodationResidence"));
    await AccommodationResidence.updateOne(
        { source: "amber", propertyId: String(propertyId) },
        { $set: { source: "amber", propertyId: String(propertyId), slug: null, propertyName: `Seeded ${propertyId}`, city, country: null, latitude: null, longitude: null, price: { amount: 100, currency: "£" }, priceDuration: "week", priceWeekly: 100, image: null, rating: null, roomType: null, distanceToCentreKm: null, nearbyUniversities: [], available: true, amenities: [], badges: [], offerText: null, billsIncluded: false, roomsCount: 0, roomTypes: [], nearbyPlaces: [], socialShortlisted: null } },
        { upsert: true }
    );
}

async function withTestCity(city, fn) {
    await requireMongo();
    await cleanupTestCity(city);
    try {
        await fn();
    } finally {
        await cleanupTestCity(city);
    }
}

async function main() {
    console.log("=== IVYHUTS Milestone 4 — Inventory Refresh Reliability Verification ===\n");

    // ══════════════════════ Pure state-model tests (no I/O) ══════════════════════
    await test("classifyCityState: no meta document -> MISSING", () => {
        const { accommodationIndex } = freshAccommodationIndex({ pages: {} });
        assert.strictEqual(accommodationIndex.classifyCityState(null, Date.now()), "MISSING");
    });
    await test("TEST 1: metadata refreshed moments ago -> FRESH", () => {
        const { accommodationIndex } = freshAccommodationIndex({ pages: {} });
        const now = Date.now();
        const meta = { status: "ok", lastRefreshedAt: new Date(now - 60_000) }; // 1 min ago
        assert.strictEqual(accommodationIndex.classifyCityState(meta, now), "FRESH");
    });
    await test("TEST 2: metadata older than FRESH_AGE_MS but under MAX_AGE_MS -> STALE", () => {
        const { accommodationIndex } = freshAccommodationIndex({ pages: {} });
        const now = Date.now();
        const meta = { status: "ok", lastRefreshedAt: new Date(now - (accommodationIndex.FRESH_AGE_MS + 60_000)) };
        assert.strictEqual(accommodationIndex.classifyCityState(meta, now), "STALE");
    });
    await test("classifyCityState: metadata older than MAX_AGE_MS -> EXPIRED", () => {
        const { accommodationIndex } = freshAccommodationIndex({ pages: {} });
        const now = Date.now();
        const meta = { status: "ok", lastRefreshedAt: new Date(now - (accommodationIndex.MAX_AGE_MS + 60_000)) };
        assert.strictEqual(accommodationIndex.classifyCityState(meta, now), "EXPIRED");
    });
    await test("TEST 5 (state half): a recent failed attempt -> FAILED_COOLDOWN, not immediately eligible again", () => {
        const { accommodationIndex } = freshAccommodationIndex({ pages: {} });
        const now = Date.now();
        const meta = { status: "error", lastAttemptedAt: new Date(now - 60_000), lastRefreshedAt: null };
        assert.strictEqual(accommodationIndex.classifyCityState(meta, now), "FAILED_COOLDOWN");
    });
    await test("classifyCityState: a failed attempt older than the cooldown window -> eligible again (EXPIRED, not permanently blacklisted)", () => {
        const { accommodationIndex } = freshAccommodationIndex({ pages: {} });
        const now = Date.now();
        const meta = { status: "error", lastAttemptedAt: new Date(now - (accommodationIndex.REFRESH_FAILURE_COOLDOWN_MS + 60_000)), lastRefreshedAt: null };
        assert.strictEqual(accommodationIndex.classifyCityState(meta, now), "EXPIRED");
    });

    // ══════════════════════ Refresh queue tests (in-memory Redis fallback) ══════════════════════
    await test("Refresh queue: requestBackgroundRefresh enqueues a city, drainRefreshQueue returns and removes it", async () => {
        const { accommodationIndex } = freshAccommodationIndex({ pages: {} });
        await accommodationIndex.requestBackgroundRefresh("queue-test-city-a");
        await accommodationIndex.requestBackgroundRefresh("queue-test-city-b");
        const batch = await accommodationIndex.drainRefreshQueue(1);
        assert.deepStrictEqual(batch, ["queue-test-city-a"], "should drain in FIFO order, one at a time when maxCities=1");
        const remaining = await accommodationIndex.drainRefreshQueue(10);
        assert.deepStrictEqual(remaining, ["queue-test-city-b"], "the un-drained city must still be queued");
    });
    await test("Refresh queue: enqueueing the same city twice does not duplicate it", async () => {
        const { accommodationIndex } = freshAccommodationIndex({ pages: {} });
        await accommodationIndex.requestBackgroundRefresh("queue-test-dup-city");
        await accommodationIndex.requestBackgroundRefresh("queue-test-dup-city");
        const batch = await accommodationIndex.drainRefreshQueue(10);
        assert.deepStrictEqual(batch, ["queue-test-dup-city"]);
    });

    // ══════════════════════ TEST 4: refresh already running -> no duplicate ══════════════════════
    await test("TEST 4: a second attemptCityRefresh for a city whose lock is already held returns immediately without attempting", async () => {
        const { accommodationIndex, calls } = freshAccommodationIndex({ pages: { "lock-test-city:1": [makeItem(1, "lock-test-city")] } });
        // Simulate an in-flight refresh by holding the lock directly (same
        // primitive attemptCityRefresh itself uses), without needing Mongo.
        const sharedStore = require(path.join(ROOT, "api", "_lib", "sharedStore.js"));
        const token = await sharedStore.acquireLock("accommodation:refreshlock:lock-test-city", 30_000);
        assert.ok(token, "test setup: should have acquired the lock");
        try {
            const outcome = await accommodationIndex.attemptCityRefresh("lock-test-city", "MEDIUM", "test4");
            assert.strictEqual(outcome.attempted, false);
            assert.strictEqual(outcome.reason, "already_in_progress");
            assert.strictEqual(calls.length, 0, "no Amber call should have been made while the lock was held by someone else");
        } finally {
            await sharedStore.releaseLock("accommodation:refreshlock:lock-test-city", token);
        }
    });

    // ══════════════════════ TEST 10: independent per-city locks ══════════════════════
    await test("TEST 10: refreshing two different cities concurrently does not block either — independent per-city locks", async () => {
        const { accommodationIndex, calls } = freshAccommodationIndex({
            pages: { "city-x:1": [makeItem(1, "city-x")], "city-y:1": [makeItem(2, "city-y")] },
        });
        const [a, b] = await Promise.all([
            accommodationIndex.attemptCityRefresh("city-x", "MEDIUM", "test10"),
            accommodationIndex.attemptCityRefresh("city-y", "MEDIUM", "test10"),
        ]);
        assert.strictEqual(a.attempted, true);
        assert.strictEqual(b.attempted, true);
        assert.strictEqual(calls.length, 2, "each independent city should have made its own Amber call");
    });

    // ══════════════════════ Mongo-integration tests ══════════════════════
    await test("TEST 6: a successful refresh persists inventory and updates metadata (lastRefreshedAt, status, residenceCount) only after success", async () => {
        const city = "zzz-milestone4-test-success";
        await withTestCity(city, async () => {
            const { accommodationIndex } = freshAccommodationIndex({ pages: { [`${city}:1`]: [makeItem(1, city), makeItem(2, city)] } });
            const AccommodationIndexMeta = require(path.join(ROOT, "api", "_lib", "models", "AccommodationIndexMeta"));
            const before = await AccommodationIndexMeta.findOne({ city }).lean();
            assert.strictEqual(before, null, "test setup: no pre-existing meta");

            const outcome = await accommodationIndex.attemptCityRefresh(city, "MEDIUM", "test6");
            assert.strictEqual(outcome.refreshed, true);
            assert.strictEqual(outcome.residences.length, 2);

            const after = await AccommodationIndexMeta.findOne({ city }).lean();
            assert.ok(after, "metadata document should now exist");
            assert.strictEqual(after.status, "ok");
            assert.strictEqual(after.residenceCount, 2);
            assert.ok(after.lastRefreshedAt, "lastRefreshedAt must be set on success");
            assert.strictEqual(after.consecutiveFailures, 0);
        });
    });

    await test("TEST 5 / TEST 7: a failed refresh leaves PRE-EXISTING inventory intact, never marks the city fresh, and records the failure for cooldown purposes", async () => {
        const city = "zzz-milestone4-test-failure";
        await withTestCity(city, async () => {
            // Seed real pre-existing inventory + a meta doc that's already EXPIRED,
            // simulating "we have old data, and a refresh attempt is about to fail."
            await seedResidence(city, "seeded-1");
            await seedMeta(city, { status: "ok", lastRefreshedAt: new Date(Date.now() - 25 * 60 * 60 * 1000), residenceCount: 1 });

            const { accommodationIndex } = freshAccommodationIndex({ failAmber: true });
            const outcome = await accommodationIndex.attemptCityRefresh(city, "MEDIUM", "test5");
            assert.strictEqual(outcome.refreshed, false, "a failed Amber call must not be reported as a successful refresh");

            const AccommodationIndexMeta = require(path.join(ROOT, "api", "_lib", "models", "AccommodationIndexMeta"));
            const AccommodationResidence = require(path.join(ROOT, "api", "_lib", "models", "AccommodationResidence"));
            const meta = await AccommodationIndexMeta.findOne({ city }).lean();
            assert.strictEqual(meta.status, "error", "a failed attempt must record status:error, never silently mark the city fresh");
            assert.strictEqual(meta.consecutiveFailures, 1);
            assert.ok(meta.lastError, "a failure reason should be recorded for observability");

            const residences = await AccommodationResidence.find({ city }).lean();
            assert.strictEqual(residences.length, 1, "pre-existing inventory must be preserved, never destroyed by a failed refresh");

            const now = Date.now();
            assert.strictEqual(accommodationIndex.classifyCityState(meta, now), "FAILED_COOLDOWN", "an immediately-following classification must respect the cooldown, not retry instantly");
        });
    });

    await test("TEST 2: getCityListings() for a STALE city with existing data returns that data immediately AND requests exactly one background refresh, without waiting on it", async () => {
        const city = "zzz-milestone4-test-stale-listings";
        await withTestCity(city, async () => {
            await seedResidence(city, "stale-1");
            await seedMeta(city, { status: "ok", lastRefreshedAt: new Date(Date.now() - 45 * 60 * 1000), residenceCount: 1 }); // 45min old -> STALE

            const { accommodationIndex, calls } = freshAccommodationIndex({ pages: { [`${city}:1`]: [makeItem(1, city)] } });
            const startedAt = Date.now();
            const result = await accommodationIndex.getCityListings(city, { priority: "MEDIUM", source: "test2" });
            const durationMs = Date.now() - startedAt;

            assert.strictEqual(result.status, "ready");
            assert.strictEqual(result.residences.length, 1, "existing stale-but-usable data must be returned immediately");
            assert.ok(durationMs < 3000, `a STALE response must not block on a refresh — took ${durationMs}ms`);
            assert.strictEqual(calls.length, 0, "the response itself must not have made an Amber call synchronously");

            const batch = await accommodationIndex.drainRefreshQueue(10);
            assert.deepStrictEqual(batch, [city], "exactly one background refresh should have been requested for this city");
        });
    });

    await test("TEST 8: getCityListings() for a MISSING city with NO existing data attempts one bounded refresh and returns a controlled result (never throws, never a request storm)", async () => {
        const city = "zzz-milestone4-test-missing-nodata";
        await withTestCity(city, async () => {
            const { accommodationIndex, calls } = freshAccommodationIndex({ pages: { [`${city}:1`]: [makeItem(1, city), makeItem(2, city)] } });
            const result = await accommodationIndex.getCityListings(city, { priority: "MEDIUM", source: "test8" });
            assert.strictEqual(result.status, "ready");
            assert.strictEqual(result.residences.length, 2);
            assert.strictEqual(calls.length, 1, "exactly one Amber call for the first-ever look at this city");
        });
    });

    await test("TEST 3: 20 concurrent getCityListings() requests for the same MISSING city produce AT MOST ONE refresh operation", async () => {
        const city = "zzz-milestone4-test-concurrent-storm";
        await withTestCity(city, async () => {
            const { accommodationIndex, calls } = freshAccommodationIndex({ pages: { [`${city}:1`]: [makeItem(1, city)] } });
            const results = await Promise.all(
                Array.from({ length: 20 }, () => accommodationIndex.getCityListings(city, { priority: "MEDIUM", source: "test3" }))
            );
            const amberCalls = calls.filter((u) => new URL(u).searchParams.get("location_place_name") === city).length;
            assert.strictEqual(amberCalls, 1, `expected exactly 1 real Amber call for 20 concurrent requests to a missing city, got ${amberCalls}`);
            const readyCount = results.filter((r) => r.status === "ready").length;
            assert.ok(readyCount > 0, "at least the lock winner (and any waiter who reads Mongo after) should see ready data");
        });
    });

    await test("TEST 9 (P0-8 parity): rate budget exhausted during a refresh fails safely — no inventory destruction, existing data untouched", async () => {
        const city = "zzz-milestone4-test-budget";
        const decoyCity = "zzz-milestone4-test-budget-decoy";
        await requireMongo();
        await cleanupTestCity(city);
        await cleanupTestCity(decoyCity);
        try {
            await seedResidence(city, "budget-seed-1");
            await seedMeta(city, { status: "ok", lastRefreshedAt: new Date(Date.now() - 25 * 60 * 60 * 1000), residenceCount: 1 });

            // AMBER_MAX_REQUESTS_PER_MINUTE=1: `Number(env) || 6` treats "0"
            // as falsy (silently falling back to the default 6), so "1" +
            // pre-consuming that single slot with a decoy call is the correct
            // way to force real exhaustion, not "0". The decoy call succeeds
            // for real, so it writes real Meta/Residence docs for decoyCity
            // too — both test cities are cleaned up below, not just `city`.
            const { accommodationIndex } = freshAccommodationIndex({
                pages: { [`${decoyCity}:1`]: [makeItem(1, decoyCity)] },
                envOverrides: { AMBER_MAX_REQUESTS_PER_MINUTE: "1" },
            });
            const decoy = await accommodationIndex.attemptCityRefresh(decoyCity, "MEDIUM", "test9-decoy");
            assert.strictEqual(decoy.refreshed, true, "test setup: the decoy call should consume the only budget slot");

            const outcome = await accommodationIndex.attemptCityRefresh(city, "MEDIUM", "test9");
            assert.strictEqual(outcome.refreshed, false, "a budget-exhausted refresh must not be reported as successful");

            const AccommodationResidence = require(path.join(ROOT, "api", "_lib", "models", "AccommodationResidence"));
            const residences = await AccommodationResidence.find({ city }).lean();
            assert.strictEqual(residences.length, 1, "existing inventory must survive a budget-exhausted refresh attempt untouched");
        } finally {
            await cleanupTestCity(city);
            await cleanupTestCity(decoyCity);
        }
    });

    await test("TEST 14: getCityListings()'s response contract (status/residences shape) is unchanged for a FRESH city — Find Room's existing behavior is preserved", async () => {
        const city = "zzz-milestone4-test-contract";
        await withTestCity(city, async () => {
            await seedResidence(city, "contract-1");
            await seedMeta(city, { status: "ok", lastRefreshedAt: new Date(), residenceCount: 1 });
            const { accommodationIndex, calls } = freshAccommodationIndex({ pages: {} });
            const result = await accommodationIndex.getCityListings(city, { priority: "MEDIUM", source: "test14" });
            assert.deepStrictEqual(Object.keys(result).sort(), ["residences", "status"]);
            assert.strictEqual(result.status, "ready");
            assert.strictEqual(calls.length, 0, "a fresh city must make zero Amber calls");
        });
    });

    // ══════════════════════ TEST 11/12 — known university/city regression guard ══════════════════════
    const CAMPUS_UNIVERSITIES = JSON.parse(fs.readFileSync(path.join(ROOT, "src", "data", "campusUniversities.json"), "utf8"));
    for (const known of [
        { id: "university-of-manchester", city: "Manchester" },
        { id: "university-of-derby", city: "Derby" },
    ]) {
        await test(`TEST 11/12 REGRESSION: ${known.id} still resolves with city "${known.city}" intact after this milestone's changes`, () => {
            const u = CAMPUS_UNIVERSITIES.find((x) => x.id === known.id);
            assert.ok(u);
            assert.strictEqual(u.city, known.city);
        });
    }
    await test("TEST 13 REGRESSION: University Housing's live-search function (getProperties, backed by /api/amber) is structurally distinct from the accommodationIndex.js-backed getCityListings() Find Room uses — this milestone only changed the latter, so University Housing's 'no unnecessary refresh' behavior (it never goes through AccommodationIndexMeta at all) is unaffected", () => {
        const amberApiSrc = fs.readFileSync(path.join(ROOT, "src", "services", "amberApi.js"), "utf8");
        // getProperties() (University Housing's function, called from
        // UniversityHousingPage.js) must hit /api/amber, not /api/city-listings
        // — the accommodationIndex.js mention elsewhere in this file is a
        // header comment on the SEPARATE getCityListings() helper Find Room
        // uses, not a coupling in University Housing's own code path.
        const getPropertiesMatch = amberApiSrc.match(/export async function getProperties\([^)]*\)\s*\{[\s\S]*?\n\}/);
        assert.ok(getPropertiesMatch, "getProperties() not found in amberApi.js");
        // getProperties() delegates to callGateway(), which builds the
        // /api/amber URL (confirmed at this file's own `return \`/api/amber?...\`;`
        // line) — checked via the call, not a literal string in
        // getProperties' own small body, which doesn't inline the URL itself.
        assert.ok(/callGateway\(/.test(getPropertiesMatch[0]), "getProperties() must call callGateway() (the /api/amber path)");
        assert.ok(!/city-listings/.test(getPropertiesMatch[0]), "getProperties() must not call /api/city-listings (the accommodationIndex.js-backed path)");
        // UniversityHousingPage.js's own property-fetch effect (the actual
        // search path) must call getProperties()/getPropertyBySlug(), not
        // getCityListings() — a legitimate unrelated comment elsewhere in
        // the file (cross-referencing accommodationIndex.js's
        // getOverrideResidences() for a DIFFERENT, override-only path) is
        // expected and not itself a coupling, so this checks the actual
        // fetch effect's calls rather than a blanket "never mentions" scan.
        const uhPageSrc = fs.readFileSync(path.join(ROOT, "src", "pages", "UniversityHousingPage.js"), "utf8");
        assert.ok(/getProperties\(/.test(uhPageSrc) && !/getCityListings\(/.test(uhPageSrc), "UniversityHousingPage.js must call getProperties(), never getCityListings()");
    });

    // ══════════════════════ Structural guards ══════════════════════
    await test("STRUCTURAL: refresh work still goes exclusively through amberGateway.js's fetchListings() — no direct fetch()/Amber URL in accommodationIndex.js or cacheWarmer.js", () => {
        for (const f of ["accommodationIndex.js", "cacheWarmer.js"]) {
            const src = fs.readFileSync(path.join(ROOT, "api", "_lib", f), "utf8");
            assert.ok(!/amberstudent\.com/.test(src), `${f} must never reference Amber's base URL directly`);
            assert.ok(!/\bfetch\(/.test(src), `${f} must never call fetch() itself — only amberGateway.js may`);
        }
    });
    await test("STRUCTURAL: AccommodationIndexMeta schema changes are additive only — all pre-existing fields (city, lastRefreshedAt, status enum values, residenceCount) are still present", () => {
        const src = fs.readFileSync(path.join(ROOT, "api", "_lib", "models", "AccommodationIndexMeta.js"), "utf8");
        assert.ok(/city:\s*{\s*type:\s*String,\s*required:\s*true,\s*unique:\s*true\s*}/.test(src));
        assert.ok(/lastRefreshedAt:\s*{\s*type:\s*Date/.test(src));
        assert.ok(/"ok",\s*"empty",\s*"error"/.test(src), "pre-existing status enum values must not be removed");
        assert.ok(/residenceCount:\s*{\s*type:\s*Number/.test(src));
    });
    await test("STRUCTURAL: no second Amber client, rate limiter, or Redis client was introduced by this milestone", () => {
        const libDir = path.join(ROOT, "api", "_lib");
        const files = fs.readdirSync(libDir);
        const suspicious = files.filter((f) => /amber/i.test(f) && !["amberGateway.js", "accommodationIndex.js"].includes(f));
        assert.deepStrictEqual(suspicious, []);
    });

    console.log(`\n=== ${passed} passed, ${failed} failed, ${skipped} skipped ===`);
    if (failed > 0) {
        console.log("\nFailures:");
        failures.forEach((f) => console.log(`  - ${f.name}: ${f.message}`));
        process.exitCode = 1;
    }
    process.exit(process.exitCode || 0);
}

main().catch((err) => {
    console.error("Verification script crashed:", err);
    process.exitCode = 1;
    process.exit(1);
});
