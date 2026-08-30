#!/usr/bin/env node
// Milestone 23.3 — Find Rooms search orchestration (GET /api/properties/
// search) verification. Same standalone-Node-script convention as every
// other scripts/verify-*.js in this repo (Jest is broken repo-wide for an
// unrelated pre-existing reason — see scripts/verify-auth-backend.js).
//
// REDIS: forced into in-memory fallback (same reasoning as
// scripts/verify-business-api.js) — throwaway test accounts have no
// business touching the real Upstash instance.
//
// MONGODB: uses the real MONGODB_URI from .env.local (needed for real
// requireRole/role authorization), guarded by the same "database name must
// contain 'test'" check as scripts/verify-business-api.js — refuses to run
// against anything that doesn't look like a test database.
//
// Never calls real UHomes/UniAcco/University Living/Gradding Homes, never
// uses real credentials — all four adapters are NOT_CONFIGURED stubs today
// (see api/_lib/providers/accommodation/README.md), so there is nothing
// real to call.
"use strict";

const assert = require("assert");
const path = require("path");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");

require("dotenv").config({ path: path.join(ROOT, ".env.local") });
require("dotenv").config({ path: path.join(ROOT, ".env") });
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

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
        failed++;
        failures.push({ name, message: err.message });
        console.log(`  FAIL  ${name}\n        ${err.message}`);
    }
}
function skip(name, reason) {
    skipped++;
    console.log(`  SKIP  ${name}\n        ${reason}`);
}

function mockReq({ method = "GET", query = {}, cookie, origin } = {}) {
    const headers = {};
    if (cookie) headers.cookie = cookie;
    if (origin) headers.origin = origin;
    return { method, query: { ...query }, headers, socket: { remoteAddress: "127.0.0.1" } };
}
function mockRes() {
    const res = { statusCode: 200, headers: {}, body: undefined };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (body) => { res.body = JSON.parse(JSON.stringify(body)); return res; };
    res.setHeader = (key, value) => { res.headers[key] = value; return res; };
    res.end = () => res;
    return res;
}

function getDbNameFromUri(uri) {
    const match = /\/([^/?]+)(\?|$)/.exec(uri.replace(/^mongodb(\+srv)?:\/\//, "mongodb://").split("@").pop());
    return match ? match[1] : "";
}

function read(relPath) {
    return fs.readFileSync(path.join(ROOT, relPath), "utf8");
}

async function main() {
    console.log("=== IvyHuts Find Rooms Search Verification (Milestone 23.3) ===");
    console.log("Redis: forced in-memory fallback for this run.\n");

    // ══════════════════ STRUCTURAL — no real network calls exist at all ══════════════════
    // (Items 14/15/17's "no arbitrary URL, no credentials, no N+1 network
    // call" are trivially, structurally true right now: nothing in this
    // directory calls fetch() at all. Verified before anything else so a
    // later regression here would fail loudly and early.)
    await test("7/8. STRUCTURAL: provider registry contains exactly the four approved providers, and Amber is not among them", () => {
        const { REGISTRY } = require(path.join(ROOT, "api", "_lib", "providers", "accommodation", "registry"));
        const keys = Object.keys(REGISTRY).sort();
        assert.deepStrictEqual(keys, ["gradding_homes", "uhomes", "uniacco", "university_living"]);
        assert.ok(!keys.includes("amber"), "Amber must never be a registered provider");
    });

    await test("14/15. STRUCTURAL: no provider adapter file calls fetch() — no network access exists to receive a client-supplied credential or URL", () => {
        const dir = path.join(ROOT, "api", "_lib", "providers", "accommodation");
        for (const file of fs.readdirSync(dir)) {
            if (!file.endsWith(".js")) continue;
            const src = fs.readFileSync(path.join(dir, file), "utf8");
            assert.ok(!/\bfetch\(/.test(src), `${file} must not call fetch() — no real provider integration exists yet`);
        }
    });

    await test("14/15. STRUCTURAL: the route handler never reads a provider URL, endpoint, or credential field from the request", () => {
        const src = read(path.join("api", "_lib", "routes", "crm-tools", "properties-search.js"));
        assert.ok(!/query\.(providerUrl|providerEndpoint|apiKey|credential|url)\b/i.test(src), "the route must never accept a client-supplied provider URL/credential");
    });

    // ══════════════════ REGISTRY / STATUS SHAPE (no Mongo needed) ══════════════════
    await test("9. all four providers return NOT_CONFIGURED with zero properties, called directly", async () => {
        const { REGISTRY } = require(path.join(ROOT, "api", "_lib", "providers", "accommodation", "registry"));
        for (const [provider, adapter] of Object.entries(REGISTRY)) {
            const result = await adapter.search({ university: { name: "Test University" }, sharing: 2, budgetMin: 100 });
            assert.strictEqual(result.status, "NOT_CONFIGURED", `${provider} should be NOT_CONFIGURED today`);
            assert.deepStrictEqual(result.properties, [], `${provider} must return zero properties, never fabricated ones`);
            assert.ok(result.reason, `${provider} should explain WHY it's not configured, not just report the status silently`);
        }
    });

    // ══════════════════ ORCHESTRATION — searchProviders() directly (no Mongo, no HTTP) ══════════════════
    const { searchProviders, sanitizeSettledResult } = require(path.join(ROOT, "api", "_lib", "providers", "accommodation", "search"));
    const registryModule = require(path.join(ROOT, "api", "_lib", "providers", "accommodation", "registry"));

    const baseCriteria = {
        university: { id: "test-uni", name: "Test University", city: "Testville", country: "Testland" },
        universityCoordinates: { latitude: 51.5, longitude: -0.12 },
        budgetMin: 150,
        budgetMax: 300,
        sharing: 2,
    };

    await test("10/11. a real orchestrated search returns zero properties and full 4-entry providerCoverage, none silently reported as plain 0-results", async () => {
        const { properties, providerCoverage } = await searchProviders(baseCriteria);
        assert.deepStrictEqual(properties, []);
        assert.strictEqual(providerCoverage.length, 4);
        providerCoverage.forEach((c) => {
            assert.strictEqual(c.status, "NOT_CONFIGURED");
            assert.strictEqual(c.count, 0);
            assert.ok(c.reason, `${c.provider}'s coverage entry must explain why, distinguishing it from a real zero-result search`);
        });
    });

    await test("12. NOT_CONFIGURED and NO_RESULTS are distinguishable through the full orchestration path (not collapsed into the same shape)", async () => {
        const original = registryModule.REGISTRY.uhomes.search;
        registryModule.REGISTRY.uhomes.search = async () => ({ provider: "uhomes", status: "NO_RESULTS", properties: [] });
        try {
            const { providerCoverage } = await searchProviders(baseCriteria);
            const uhomes = providerCoverage.find((c) => c.provider === "uhomes");
            const uniacco = providerCoverage.find((c) => c.provider === "uniacco");
            assert.strictEqual(uhomes.status, "NO_RESULTS");
            assert.strictEqual(uniacco.status, "NOT_CONFIGURED");
            assert.notStrictEqual(uhomes.status, uniacco.status, "a real empty search and an unconfigured provider must never look identical to the caller");
        } finally {
            registryModule.REGISTRY.uhomes.search = original;
        }
    });

    await test("13. a malformed adapter response (bad status, non-array properties) is sanitized to ERROR, never leaked through raw", async () => {
        const malformed1 = sanitizeSettledResult("uhomes", { status: "fulfilled", value: { status: "BOGUS_STATUS", properties: [] } });
        assert.strictEqual(malformed1.status, "ERROR");
        const malformed2 = sanitizeSettledResult("uhomes", { status: "fulfilled", value: { status: "SEARCHED", properties: "not-an-array" } });
        assert.strictEqual(malformed2.status, "ERROR");
        const malformed3 = sanitizeSettledResult("uhomes", { status: "rejected", reason: new Error("boom") });
        assert.strictEqual(malformed3.status, "ERROR");
        assert.strictEqual(malformed3.reason, "boom");
    });

    await test("13b. a provider adapter that THROWS synchronously cannot crash the whole search — it becomes that provider's ERROR only", async () => {
        const original = registryModule.REGISTRY.uniacco.search;
        registryModule.REGISTRY.uniacco.search = () => { throw new Error("synchronous adapter bug"); };
        try {
            const { properties, providerCoverage } = await searchProviders(baseCriteria);
            const uniacco = providerCoverage.find((c) => c.provider === "uniacco");
            assert.strictEqual(uniacco.status, "ERROR");
            assert.strictEqual(uniacco.reason, "synchronous adapter bug");
            // The other three providers must be entirely unaffected.
            const others = providerCoverage.filter((c) => c.provider !== "uniacco");
            others.forEach((c) => assert.strictEqual(c.status, "NOT_CONFIGURED"));
            assert.deepStrictEqual(properties, []);
        } finally {
            registryModule.REGISTRY.uniacco.search = original;
        }
    });

    await test("17. no N+1 provider invocation — each adapter's search() is called exactly once per searchProviders() call", async () => {
        const counts = {};
        const originals = {};
        for (const [provider, adapter] of Object.entries(registryModule.REGISTRY)) {
            originals[provider] = adapter.search;
            counts[provider] = 0;
            adapter.search = async (...args) => {
                counts[provider] += 1;
                return originals[provider].apply(adapter, args);
            };
        }
        try {
            await searchProviders(baseCriteria);
            Object.entries(counts).forEach(([provider, count]) => {
                assert.strictEqual(count, 1, `${provider}.search() should be called exactly once, was called ${count} times`);
            });
        } finally {
            for (const [provider, adapter] of Object.entries(registryModule.REGISTRY)) {
                adapter.search = originals[provider];
            }
        }
    });

    await test("18. university information (id/name/city/country + coordinates) is passed through to every provider's criteria unchanged", async () => {
        let captured;
        const original = registryModule.REGISTRY.university_living.search;
        registryModule.REGISTRY.university_living.search = async (criteria) => {
            captured = criteria;
            return original(criteria);
        };
        try {
            await searchProviders(baseCriteria);
            assert.deepStrictEqual(captured.university, baseCriteria.university);
            assert.deepStrictEqual(captured.universityCoordinates, baseCriteria.universityCoordinates);
        } finally {
            registryModule.REGISTRY.university_living.search = original;
        }
    });

    // ══════════════════ NORMALIZATION (16) — pure functions, no network ══════════════════
    const normalize = require(path.join(ROOT, "api", "_lib", "providers", "accommodation", "normalize"));
    await test("16. CanonicalProperty normalization: a fully-populated raw listing normalizes correctly", () => {
        const result = normalize.normalizeProviderProperty("uhomes", {
            providerPropertyId: "abc123",
            name: "  Sky Gardens  ",
            url: "https://uhomes.com/uk/sky-gardens/?utm_source=x",
            rent: "£1,200",
            currency: "£",
            rentPeriod: "per month",
            roomType: "2 Sharing",
            availability: "available",
        });
        assert.strictEqual(result.status, "ok");
        assert.strictEqual(result.property.propertyId, "uhomes:id:abc123");
        assert.strictEqual(result.property.rent, 1200);
        assert.strictEqual(result.property.currency, "GBP");
        assert.strictEqual(result.property.rentPeriod, "month");
        assert.strictEqual(result.property.sharing, 2);
        assert.ok(Math.abs(result.property.rentPerWeek - (1200 * 12) / 52) < 0.001);
    });
    await test("16. CanonicalProperty normalization: missing optional fields degrade to null, never fabricated", () => {
        const result = normalize.normalizeProviderProperty("uniacco", { providerPropertyId: "x1", name: "Minimal Listing" });
        assert.strictEqual(result.status, "ok");
        assert.strictEqual(result.property.rent, null);
        assert.strictEqual(result.property.rentPerWeek, null);
        assert.strictEqual(result.property.sharing, null);
        assert.strictEqual(result.property.availability, "unknown");
    });
    await test("16. CanonicalProperty normalization: missing identity (no providerPropertyId, no url) fails cleanly", () => {
        const result = normalize.normalizeProviderProperty("uhomes", { name: "Nameless" });
        assert.strictEqual(result.status, "invalid");
    });

    // ══════════════════ VALIDATION (4/5/6) — pure, no Mongo/auth needed ══════════════════
    const searchHandlerForValidation = require(path.join(ROOT, "api", "_lib", "routes", "crm-tools", "properties-search.js"));
    await test("4. missing university -> throws VALIDATION_ERROR (pure parseCriteria)", () => {
        assert.throws(() => searchHandlerForValidation.parseCriteria({ budgetMin: "150", sharing: "2" }), (err) => err.code === "VALIDATION_ERROR");
    });
    await test("5. missing sharing -> throws VALIDATION_ERROR (pure parseCriteria)", () => {
        assert.throws(() => searchHandlerForValidation.parseCriteria({ universityName: "Test University", budgetMin: "150" }), (err) => err.code === "VALIDATION_ERROR");
    });
    await test("6. invalid budget (budgetMin > budgetMax) -> throws VALIDATION_ERROR (pure parseCriteria)", () => {
        assert.throws(() => searchHandlerForValidation.parseCriteria({ universityName: "Test University", budgetMin: "500", budgetMax: "100", sharing: "2" }), (err) => err.code === "VALIDATION_ERROR");
    });
    await test("6b. invalid budget (negative) -> throws VALIDATION_ERROR (pure parseCriteria)", () => {
        assert.throws(() => searchHandlerForValidation.parseCriteria({ universityName: "Test University", budgetMin: "-50", sharing: "2" }), (err) => err.code === "VALIDATION_ERROR");
    });
    await test("VALIDATION: a fully valid query parses cleanly with the university object shaped as expected", () => {
        const criteria = searchHandlerForValidation.parseCriteria({ universityName: "Test University", universityCity: "Testville", budgetMin: "150", budgetMax: "300", sharing: "2" });
        assert.deepStrictEqual(criteria.university, { id: null, name: "Test University", city: "Testville", country: null });
        assert.strictEqual(criteria.sharing, 2);
    });

    // ══════════════════ MONGODB-DEPENDENT: AUTH (1/2/3) via requireRole, + 4/5/6 re-confirmed end-to-end ══════════════════
    // 4/5/6 already have unconditional, Mongo-free coverage above (pure
    // parseCriteria unit tests) — these re-run them through the REAL HTTP
    // path (withErrorHandling + requireRole + parseCriteria together) as an
    // extra end-to-end check when a test database is available, but 1/2/3
    // (real requireRole/Mongo-backed role authorization) have no other
    // coverage and are the reason this block exists.
    const MONGODB_URI = process.env.MONGODB_URI;
    if (!MONGODB_URI) {
        skip("1/2/3. requireRole authorization via the real route handler (4/5/6 already covered above without Mongo)", "MONGODB_URI is not set — set it in .env.local (pointing at a database whose name contains \"test\") to run these.");
    } else {
        const dbName = getDbNameFromUri(MONGODB_URI);
        const looksLikeTestDb = /test/i.test(dbName);
        if (!looksLikeTestDb && process.env.ALLOW_MONGODB_LIVE_TEST !== "true") {
            skip("1/2/3. requireRole authorization via the real route handler (4/5/6 already covered above without Mongo)", `MONGODB_URI points at database "${dbName}", which doesn't look like a test database — refusing to run against it.`);
        } else {
            const { connectToDatabase } = require(path.join(ROOT, "api", "_lib", "mongodb"));
            const userStore = require(path.join(ROOT, "api", "_lib", "userStore"));
            const session = require(path.join(ROOT, "api", "_lib", "session"));
            const { resolveMongoUser } = require(path.join(ROOT, "api", "_lib", "businessAuth"));
            const searchHandler = require(path.join(ROOT, "api", "_lib", "routes", "crm-tools", "properties-search.js"));

            await connectToDatabase();
            console.log("\nMongoDB connection established for live requireRole verification.\n");

            const runId = `verify-props-${Date.now()}`;
            async function createActor(role, tag) {
                const email = `${runId}-${tag}@example.test`;
                const redisUser = await userStore.createUser({ name: `Test ${tag}`, email, password: "TestPassword123!", phone: "9876543210" });
                const sessionId = await session.createSession(redisUser.id);
                const mongoUser = await resolveMongoUser(redisUser);
                if (role !== "USER") {
                    mongoUser.role = role;
                    await mongoUser.save();
                }
                return { cookie: `${session.COOKIE_NAME}=${sessionId}` };
            }

            const agent = await createActor("MARKETING_AGENT", "agent");
            const plainUser = await createActor("USER", "plain");

            const validQuery = { universityName: "Test University", budgetMin: "150", budgetMax: "300", sharing: "2" };

            await test("1. unauthenticated GET /api/properties/search -> 401", async () => {
                const res = mockRes();
                await searchHandler(mockReq({ query: validQuery }), res);
                assert.strictEqual(res.statusCode, 401);
            });
            await test("2. non-internal (plain USER) role -> 403", async () => {
                const res = mockRes();
                await searchHandler(mockReq({ query: validQuery, cookie: plainUser.cookie }), res);
                assert.strictEqual(res.statusCode, 403);
            });
            await test("3. internal role (MARKETING_AGENT) -> 200, well-formed response", async () => {
                const res = mockRes();
                await searchHandler(mockReq({ query: validQuery, cookie: agent.cookie }), res);
                assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
                assert.strictEqual(res.body.success, true);
                assert.deepStrictEqual(res.body.data.properties, []);
                assert.strictEqual(res.body.data.providerCoverage.length, 4);
                assert.ok(res.body.data.searchMetadata.searchedAt);
                assert.ok(!/all available properties/i.test(res.body.data.searchMetadata.disclaimer), "must never overclaim completeness");
            });
            await test("4. missing university -> 400 VALIDATION_ERROR", async () => {
                const res = mockRes();
                await searchHandler(mockReq({ query: { budgetMin: "150", sharing: "2" }, cookie: agent.cookie }), res);
                assert.strictEqual(res.statusCode, 400);
                assert.strictEqual(res.body.error.code, "VALIDATION_ERROR");
            });
            await test("5. missing sharing -> 400 VALIDATION_ERROR", async () => {
                const res = mockRes();
                await searchHandler(mockReq({ query: { universityName: "Test University", budgetMin: "150" }, cookie: agent.cookie }), res);
                assert.strictEqual(res.statusCode, 400);
                assert.strictEqual(res.body.error.code, "VALIDATION_ERROR");
            });
            await test("6. invalid budget (budgetMin > budgetMax) -> 400 VALIDATION_ERROR", async () => {
                const res = mockRes();
                await searchHandler(mockReq({ query: { universityName: "Test University", budgetMin: "500", budgetMax: "100", sharing: "2" }, cookie: agent.cookie }), res);
                assert.strictEqual(res.statusCode, 400);
                assert.strictEqual(res.body.error.code, "VALIDATION_ERROR");
            });
            await test("6b. invalid budget (negative) -> 400 VALIDATION_ERROR", async () => {
                const res = mockRes();
                await searchHandler(mockReq({ query: { universityName: "Test University", budgetMin: "-50", sharing: "2" }, cookie: agent.cookie }), res);
                assert.strictEqual(res.statusCode, 400);
            });
        }
    }

    console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
    if (failed > 0) {
        console.log("\nFailures:");
        failures.forEach((f) => console.log(`  - ${f.name}: ${f.message}`));
        process.exitCode = 1;
    }
}

main().catch((err) => {
    console.error("FATAL:", err);
    process.exitCode = 1;
});
