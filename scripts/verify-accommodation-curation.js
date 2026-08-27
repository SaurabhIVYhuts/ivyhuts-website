#!/usr/bin/env node
// Milestone 23.6 — persistent Lead Accommodation Curation verification.
// Same standalone-Node-script convention as every other scripts/verify-*.js
// in this repo (Jest is broken repo-wide for an unrelated pre-existing
// reason — see scripts/verify-auth-backend.js).
//
// REDIS: forced into in-memory fallback (same reasoning as
// scripts/verify-business-api.js) — throwaway test accounts/sessions have
// no business touching the real Upstash instance.
//
// MONGODB: uses the real MONGODB_URI from .env.local for the Auth/CRUD/
// Security/Data-integrity sections (these need a real requireRole+Mongo
// round-trip), guarded by the same "database name must contain 'test'"
// check as scripts/verify-business-api.js — refuses to run those sections
// against anything that doesn't look like a test database. The Validation
// section needs no database at all (pure functions, always runs).
//
// Never calls real UHomes/UniAcco/University Living/Gradding Homes, never
// touches Amber, never uses real credentials.
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

function mockReq({ method = "GET", body, cookie, query = {} } = {}) {
    return { method, body, query: { ...query }, headers: cookie ? { cookie } : {}, socket: { remoteAddress: "127.0.0.1" } };
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

function validProperty(overrides = {}) {
    return {
        provider: "uhomes",
        providerPropertyId: "abc123",
        propertyId: "uhomes:id:abc123",
        name: "Luna Hatfield",
        url: "https://uhomes.com/p/abc123",
        city: "Hatfield",
        country: "United Kingdom",
        rent: 190,
        rentPerWeek: 190,
        currency: "GBP",
        rentPeriod: "week",
        roomType: "Ensuite",
        sharing: 2,
        availability: "available",
        amenities: ["wifi"],
        distanceFromUniversityKm: 0.8,
        ...overrides,
    };
}

function validCriteriaSnapshot(overrides = {}) {
    return {
        university: { id: "university-of-hertfordshire", name: "University of Hertfordshire", city: "Hatfield", country: "United Kingdom", latitude: 51.7636, longitude: -0.2405 },
        budgetMin: 150,
        budgetMax: 250,
        sharing: 2,
        amenities: [],
        ...overrides,
    };
}

async function main() {
    console.log("=== IvyHuts Accommodation Curation Verification (Milestone 23.6) ===");
    console.log("Redis: forced in-memory fallback for this run.\n");

    const handler = require(path.join(ROOT, "api", "_lib", "routes", "leads", "[id]", "accommodation-curation.js"));

    // ══════════════════════ STRUCTURAL ══════════════════════
    await test("STRUCTURAL: no reference to Amber anywhere in the model or route (comments excluded — the header comments explain why Amber is excluded, which itself contains the word)", () => {
        const fs = require("fs");
        const stripComments = (src) => src.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
        const modelSrc = stripComments(fs.readFileSync(path.join(ROOT, "api", "_lib", "models", "AccommodationCuration.js"), "utf8"));
        const routeSrc = stripComments(fs.readFileSync(path.join(ROOT, "api", "_lib", "routes", "leads", "[id]", "accommodation-curation.js"), "utf8"));
        assert.ok(!/\bamber\b/i.test(modelSrc), "AccommodationCuration.js must not reference Amber outside comments");
        assert.ok(!/\bamber\b/i.test(routeSrc), "accommodation-curation.js route must not reference Amber outside comments");
    });

    await test("STRUCTURAL: provider enum is exactly the four approved providers", () => {
        const AccommodationCuration = require(path.join(ROOT, "api", "_lib", "models", "AccommodationCuration"));
        assert.deepStrictEqual([...AccommodationCuration.PROVIDERS].sort(), ["gradding_homes", "uhomes", "uniacco", "university_living"]);
    });

    // ══════════════════ VALIDATION (pure — no Mongo needed) ══════════════════
    await test("VALIDATION: a fully valid payload parses cleanly", () => {
        const fields = handler.buildCurationFields({
            criteriaSnapshot: validCriteriaSnapshot(),
            properties: [validProperty()],
            recommendedPropertyId: "uhomes:id:abc123",
            recommendationReason: "Closest to campus",
            notes: "Agent note",
        });
        assert.strictEqual(fields.properties.length, 1);
        assert.strictEqual(fields.recommendedPropertyId, "uhomes:id:abc123");
    });

    await test("VALIDATION: empty properties array is valid (an agent can save a cleared shortlist)", () => {
        const fields = handler.buildCurationFields({ properties: [] });
        assert.deepStrictEqual(fields.properties, []);
        assert.strictEqual(fields.recommendedPropertyId, null);
    });

    await test("VALIDATION: properties is required and must be an array", () => {
        assert.throws(() => handler.buildCurationFields({}), (err) => err.code === "VALIDATION_ERROR");
        assert.throws(() => handler.buildCurationFields({ properties: "not-an-array" }), (err) => err.code === "VALIDATION_ERROR");
    });

    await test("VALIDATION: invalid property identity — missing provider is rejected", () => {
        assert.throws(
            () => handler.buildCurationFields({ properties: [validProperty({ provider: undefined })] }),
            (err) => err.code === "VALIDATION_ERROR"
        );
    });

    await test("VALIDATION: invalid property identity — provider outside the approved four is rejected", () => {
        assert.throws(
            () => handler.buildCurationFields({ properties: [validProperty({ provider: "amber" })] }),
            (err) => err.code === "VALIDATION_ERROR"
        );
    });

    await test("VALIDATION: invalid property identity — missing propertyId is rejected", () => {
        assert.throws(
            () => handler.buildCurationFields({ properties: [validProperty({ propertyId: undefined })] }),
            (err) => err.code === "VALIDATION_ERROR"
        );
    });

    await test("VALIDATION: duplicate propertyId across two entries is rejected", () => {
        assert.throws(
            () => handler.buildCurationFields({ properties: [validProperty(), validProperty()] }),
            (err) => err.code === "VALIDATION_ERROR"
        );
    });

    await test("VALIDATION: recommendedPropertyId not present in the shortlist is rejected", () => {
        assert.throws(
            () => handler.buildCurationFields({ properties: [validProperty()], recommendedPropertyId: "uhomes:id:someone-else" }),
            (err) => err.code === "VALIDATION_ERROR" && /recommendedPropertyId/.test(err.message)
        );
    });

    await test("VALIDATION: malformed criteria — sharing missing/non-positive is rejected", () => {
        assert.throws(
            () => handler.buildCurationFields({ properties: [], criteriaSnapshot: validCriteriaSnapshot({ sharing: 0 }) }),
            (err) => err.code === "VALIDATION_ERROR"
        );
        assert.throws(
            () => handler.buildCurationFields({ properties: [], criteriaSnapshot: { university: { name: "X" } } }),
            (err) => err.code === "VALIDATION_ERROR"
        );
    });

    await test("VALIDATION: malformed criteria — university missing a name is rejected", () => {
        assert.throws(
            () => handler.buildCurationFields({ properties: [], criteriaSnapshot: validCriteriaSnapshot({ university: { city: "Hatfield" } }) }),
            (err) => err.code === "VALIDATION_ERROR"
        );
    });

    await test("VALIDATION: oversized payload is rejected by the byte-size guard", () => {
        assert.strictEqual(handler.MAX_PAYLOAD_BYTES, 100_000);
        const hugeString = "x".repeat(handler.MAX_PAYLOAD_BYTES + 1);
        assert.ok(Buffer.byteLength(hugeString, "utf8") > handler.MAX_PAYLOAD_BYTES);
    });

    await test("VALIDATION: client-supplied createdBy/updatedBy are never read by buildCurationFields", () => {
        const fields = handler.buildCurationFields({ properties: [], createdBy: "attacker-id", updatedBy: "attacker-id" });
        assert.ok(!("createdBy" in fields));
        assert.ok(!("updatedBy" in fields));
    });

    // ══════════════════ MONGODB-DEPENDENT: AUTH / CRUD / SECURITY / DATA INTEGRITY ══════════════════
    const MONGODB_URI = process.env.MONGODB_URI;
    const dbName = MONGODB_URI ? getDbNameFromUri(MONGODB_URI) : "";
    const looksLikeTestDb = /test/i.test(dbName);

    if (!MONGODB_URI) {
        skip("AUTH/CRUD/SECURITY/DATA INTEGRITY (see below)", "MONGODB_URI is not set — set it in .env.local (pointing at a database whose name contains \"test\") to run these.");
    } else if (!looksLikeTestDb && process.env.ALLOW_MONGODB_LIVE_TEST !== "true") {
        skip("AUTH/CRUD/SECURITY/DATA INTEGRITY (see below)", `MONGODB_URI points at database "${dbName}", which doesn't look like a test database — refusing to run against it.`);
    } else {
        const { connectToDatabase } = require(path.join(ROOT, "api", "_lib", "mongodb"));
        const userStore = require(path.join(ROOT, "api", "_lib", "userStore"));
        const session = require(path.join(ROOT, "api", "_lib", "session"));
        const { resolveMongoUser } = require(path.join(ROOT, "api", "_lib", "businessAuth"));
        const Lead = require(path.join(ROOT, "api", "_lib", "models", "Lead"));
        const User = require(path.join(ROOT, "api", "_lib", "models", "User"));
        const AccommodationCuration = require(path.join(ROOT, "api", "_lib", "models", "AccommodationCuration"));

        await connectToDatabase();
        console.log("\nMongoDB connection established for live verification.\n");

        const runId = `verify-curation-${Date.now()}`;
        const createdUserIds = [];
        const createdLeadIds = [];

        async function createActor(role, tag) {
            const email = `${runId}-${tag}@example.test`;
            const redisUser = await userStore.createUser({ name: `Test ${tag}`, email, password: "TestPassword123!", phone: "9876543210" });
            const sessionId = await session.createSession(redisUser.id);
            const mongoUser = await resolveMongoUser(redisUser);
            if (role !== "USER") {
                mongoUser.role = role;
                await mongoUser.save();
            }
            createdUserIds.push(mongoUser._id);
            return { mongoUser, cookie: `${session.COOKIE_NAME}=${sessionId}` };
        }

        async function createLead(tag) {
            const lead = await Lead.create({ contact: { name: `Test Lead ${tag}`, email: `${runId}-lead-${tag}@example.test` }, source: "verify-script" });
            createdLeadIds.push(lead._id);
            return lead;
        }

        const agent = await createActor("MARKETING_AGENT", "agent");
        const manager = await createActor("MARKETING_MANAGER", "manager");
        const admin = await createActor("ADMIN", "admin");
        const plainUser = await createActor("USER", "plain");

        const leadA = await createLead("a");
        const leadB = await createLead("b");

        const validBody = { criteriaSnapshot: validCriteriaSnapshot(), properties: [validProperty()], recommendedPropertyId: "uhomes:id:abc123", recommendationReason: "Closest to campus" };

        // ── AUTH ──
        await test("AUTH: unauthenticated GET -> 401", async () => {
            const res = mockRes();
            await handler(mockReq({ method: "GET", query: { id: String(leadA._id) } }), res);
            assert.strictEqual(res.statusCode, 401);
        });
        await test("AUTH: unauthenticated PUT -> 401", async () => {
            const res = mockRes();
            await handler(mockReq({ method: "PUT", query: { id: String(leadA._id) }, body: validBody }), res);
            assert.strictEqual(res.statusCode, 401);
        });
        await test("AUTH: plain USER -> 403", async () => {
            const res = mockRes();
            await handler(mockReq({ method: "GET", query: { id: String(leadA._id) }, cookie: plainUser.cookie }), res);
            assert.strictEqual(res.statusCode, 403);
        });
        await test("AUTH: MARKETING_AGENT -> allowed", async () => {
            const res = mockRes();
            await handler(mockReq({ method: "GET", query: { id: String(leadA._id) }, cookie: agent.cookie }), res);
            assert.strictEqual(res.statusCode, 200);
        });
        await test("AUTH: MARKETING_MANAGER -> allowed", async () => {
            const res = mockRes();
            await handler(mockReq({ method: "GET", query: { id: String(leadA._id) }, cookie: manager.cookie }), res);
            assert.strictEqual(res.statusCode, 200);
        });
        await test("AUTH: ADMIN -> allowed", async () => {
            const res = mockRes();
            await handler(mockReq({ method: "GET", query: { id: String(leadA._id) }, cookie: admin.cookie }), res);
            assert.strictEqual(res.statusCode, 200);
        });

        // ── CRUD ──
        await test("CRUD: GET with no saved curation returns {data: null}", async () => {
            const res = mockRes();
            await handler(mockReq({ method: "GET", query: { id: String(leadA._id) }, cookie: agent.cookie }), res);
            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.body.data, null);
        });

        await test("CRUD: PUT creates a new curation", async () => {
            const res = mockRes();
            await handler(mockReq({ method: "PUT", query: { id: String(leadA._id) }, cookie: agent.cookie, body: validBody }), res);
            assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
            assert.strictEqual(res.body.data.properties.length, 1);
            assert.strictEqual(res.body.data.recommendedPropertyId, "uhomes:id:abc123");
        });

        await test("CRUD: GET now returns the saved curation", async () => {
            const res = mockRes();
            await handler(mockReq({ method: "GET", query: { id: String(leadA._id) }, cookie: agent.cookie }), res);
            assert.strictEqual(res.statusCode, 200);
            assert.ok(res.body.data);
            assert.strictEqual(res.body.data.properties[0].propertyId, "uhomes:id:abc123");
        });

        await test("CRUD: PUT updates the existing curation (add a second property, change recommendation)", async () => {
            const updated = {
                ...validBody,
                properties: [validProperty(), validProperty({ providerPropertyId: "xyz789", propertyId: "uniacco:id:xyz789", provider: "uniacco", name: "Property B" })],
                recommendedPropertyId: "uniacco:id:xyz789",
                recommendationReason: "Cheaper and still close",
            };
            const res = mockRes();
            await handler(mockReq({ method: "PUT", query: { id: String(leadA._id) }, cookie: agent.cookie, body: updated }), res);
            assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
            assert.strictEqual(res.body.data.properties.length, 2);
            assert.strictEqual(res.body.data.recommendedPropertyId, "uniacco:id:xyz789");
        });

        await test("CRUD: repeated identical PUT is idempotent (same document, no duplicate created)", async () => {
            const res1 = mockRes();
            await handler(mockReq({ method: "PUT", query: { id: String(leadA._id) }, cookie: agent.cookie, body: validBody }), res1);
            const res2 = mockRes();
            await handler(mockReq({ method: "PUT", query: { id: String(leadA._id) }, cookie: agent.cookie, body: validBody }), res2);
            assert.strictEqual(res1.body.data.id, res2.body.data.id);
            const count = await AccommodationCuration.countDocuments({ leadId: leadA._id });
            assert.strictEqual(count, 1);
        });

        // ── VALIDATION (end-to-end through the real route) ──
        await test("VALIDATION (e2e): recommendation not in shortlist -> 400", async () => {
            const res = mockRes();
            await handler(
                mockReq({ method: "PUT", query: { id: String(leadA._id) }, cookie: agent.cookie, body: { properties: [validProperty()], recommendedPropertyId: "not-in-list" } }),
                res
            );
            assert.strictEqual(res.statusCode, 400);
        });

        await test("VALIDATION (e2e): GET/PUT against a non-existent lead -> 404", async () => {
            const fakeId = "000000000000000000000000";
            const getRes = mockRes();
            await handler(mockReq({ method: "GET", query: { id: fakeId }, cookie: agent.cookie }), getRes);
            assert.strictEqual(getRes.statusCode, 404);
            const putRes = mockRes();
            await handler(mockReq({ method: "PUT", query: { id: fakeId }, cookie: agent.cookie, body: validBody }), putRes);
            assert.strictEqual(putRes.statusCode, 404);
        });

        // ── SECURITY ──
        await test("SECURITY: client-supplied createdBy/updatedBy are ignored — real values come from the session", async () => {
            const res = mockRes();
            await handler(
                mockReq({
                    method: "PUT",
                    query: { id: String(leadA._id) },
                    cookie: manager.cookie,
                    body: { ...validBody, createdBy: "000000000000000000000000", updatedBy: "000000000000000000000000" },
                }),
                res
            );
            assert.strictEqual(res.statusCode, 200);
            const stored = await AccommodationCuration.findOne({ leadId: leadA._id });
            assert.strictEqual(String(stored.updatedBy), String(manager.mongoUser._id));
            assert.notStrictEqual(String(stored.updatedBy), "000000000000000000000000");
        });

        await test("SECURITY: createdBy is set once on first insert and never changes on later updates", async () => {
            const stored = await AccommodationCuration.findOne({ leadId: leadA._id });
            const originalCreatedBy = String(stored.createdBy);
            const res = mockRes();
            await handler(mockReq({ method: "PUT", query: { id: String(leadA._id) }, cookie: admin.cookie, body: validBody }), res);
            const restored = await AccommodationCuration.findOne({ leadId: leadA._id });
            assert.strictEqual(String(restored.createdBy), originalCreatedBy);
            assert.strictEqual(String(restored.updatedBy), String(admin.mongoUser._id));
        });

        // ── CROSS-LEAD ISOLATION ──
        await test("CROSS-LEAD ISOLATION: GET for lead B returns null, never lead A's curation", async () => {
            const res = mockRes();
            await handler(mockReq({ method: "GET", query: { id: String(leadB._id) }, cookie: agent.cookie }), res);
            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.body.data, null);
        });

        await test("CROSS-LEAD ISOLATION: PUT for lead B never modifies lead A's curation", async () => {
            const before = await AccommodationCuration.findOne({ leadId: leadA._id });
            const res = mockRes();
            await handler(
                mockReq({
                    method: "PUT",
                    query: { id: String(leadB._id) },
                    cookie: agent.cookie,
                    body: { properties: [validProperty({ providerPropertyId: "lead-b-only", propertyId: "uhomes:id:lead-b-only" })] },
                }),
                res
            );
            assert.strictEqual(res.statusCode, 200);
            const afterA = await AccommodationCuration.findOne({ leadId: leadA._id });
            const afterB = await AccommodationCuration.findOne({ leadId: leadB._id });
            assert.strictEqual(String(afterA.updatedAt), String(before.updatedAt));
            assert.strictEqual(afterB.properties[0].propertyId, "uhomes:id:lead-b-only");
            assert.notStrictEqual(afterA.properties[0].propertyId, afterB.properties[0].propertyId);
        });

        // ── DATA INTEGRITY ──
        await test("DATA INTEGRITY: full round-trip preserves properties, recommendation, advantages/disadvantages, notes, and criteria snapshot", async () => {
            const fullBody = {
                criteriaSnapshot: validCriteriaSnapshot({ moveInDate: "2026-09-01", roomType: "Ensuite" }),
                properties: [validProperty({ advantages: "Cheap and close", disadvantages: "No lift" })],
                recommendedPropertyId: "uhomes:id:abc123",
                recommendationReason: "Best balance of price and distance",
                notes: "Student prefers ground floor.",
            };
            const putRes = mockRes();
            await handler(mockReq({ method: "PUT", query: { id: String(leadA._id) }, cookie: agent.cookie, body: fullBody }), putRes);
            assert.strictEqual(putRes.statusCode, 200, JSON.stringify(putRes.body));

            const getRes = mockRes();
            await handler(mockReq({ method: "GET", query: { id: String(leadA._id) }, cookie: agent.cookie }), getRes);
            const data = getRes.body.data;
            assert.strictEqual(data.properties[0].advantages, "Cheap and close");
            assert.strictEqual(data.properties[0].disadvantages, "No lift");
            assert.strictEqual(data.recommendedPropertyId, "uhomes:id:abc123");
            assert.strictEqual(data.recommendationReason, "Best balance of price and distance");
            assert.strictEqual(data.notes, "Student prefers ground floor.");
            assert.strictEqual(data.criteriaSnapshot.moveInDate, "2026-09-01");
            assert.strictEqual(data.criteriaSnapshot.university.name, "University of Hertfordshire");
            assert.strictEqual(data.criteriaSnapshot.sharing, 2);
        });

        // ── CLEANUP ──
        await AccommodationCuration.deleteMany({ leadId: { $in: createdLeadIds } });
        await Lead.deleteMany({ _id: { $in: createdLeadIds } });
        await User.deleteMany({ _id: { $in: createdUserIds } });
        const remaining = await AccommodationCuration.countDocuments({ leadId: { $in: createdLeadIds } });
        assert.strictEqual(remaining, 0, "cleanup must remove every curation document this run created");
        console.log(`\nCleanup complete. Created during this run: ${createdUserIds.length} users, ${createdLeadIds.length} leads (all removed).`);
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
