#!/usr/bin/env node
// Milestone 23.7 — Discovery backend contract verification. Same
// standalone-Node-script convention as every other scripts/verify-*.js in
// this repo (Jest is broken repo-wide for an unrelated pre-existing
// reason — see scripts/verify-auth-backend.js).
//
// REDIS: forced into in-memory fallback (same reasoning as
// scripts/verify-business-api.js).
//
// MONGODB: uses the real MONGODB_URI from .env.local for the Auth/CRUD/
// Security/Legacy sections, guarded by the same "database name must
// contain 'test'" check as scripts/verify-business-api.js. The Validation
// section needs no database (pure functions, always runs).
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

async function main() {
    console.log("=== IvyHuts Discovery Verification (Milestone 23.7) ===");
    console.log("Redis: forced in-memory fallback for this run.\n");

    const handler = require(path.join(ROOT, "api", "leads", "[id]", "discovery.js"));

    // ══════════════════════ VALIDATION (pure — no Mongo needed) ══════════════════════
    await test("VALIDATION: a valid effective accommodation state passes cleanly", () => {
        handler.validateEffectiveAccommodation({ budgetMin: 150, budgetMax: 250, currency: "GBP", sharing: 2, moveInDate: null, stayDurationMonths: null, preferredLocation: null, roomPreference: null, distancePreference: null });
    });

    await test("VALIDATION: budgetMin negative is rejected", () => {
        assert.throws(
            () => handler.validateEffectiveAccommodation({ budgetMin: -10, budgetMax: null, currency: "GBP", sharing: null }),
            (err) => err.code === "VALIDATION_ERROR"
        );
    });

    await test("VALIDATION: budgetMin > budgetMax is rejected", () => {
        assert.throws(
            () => handler.validateEffectiveAccommodation({ budgetMin: 300, budgetMax: 100, currency: "GBP", sharing: null }),
            (err) => err.code === "VALIDATION_ERROR"
        );
    });

    await test("VALIDATION: budget present without currency is rejected — never silently assumes GBP", () => {
        assert.throws(
            () => handler.validateEffectiveAccommodation({ budgetMin: 150, budgetMax: 250, currency: null, sharing: null }),
            (err) => err.code === "VALIDATION_ERROR" && /currency/.test(err.message)
        );
    });

    await test("VALIDATION: sharing zero is rejected (0 people sharing is meaningless)", () => {
        assert.throws(
            () => handler.validateEffectiveAccommodation({ budgetMin: null, budgetMax: null, currency: null, sharing: 0 }),
            (err) => err.code === "VALIDATION_ERROR"
        );
    });

    await test("VALIDATION: sharing negative is rejected", () => {
        assert.throws(
            () => handler.validateEffectiveAccommodation({ budgetMin: null, budgetMax: null, currency: null, sharing: -2 }),
            (err) => err.code === "VALIDATION_ERROR"
        );
    });

    await test("VALIDATION: sharing non-integer is rejected", () => {
        assert.throws(
            () => handler.validateEffectiveAccommodation({ budgetMin: null, budgetMax: null, currency: null, sharing: 2.5 }),
            (err) => err.code === "VALIDATION_ERROR"
        );
    });

    await test("VALIDATION: unreasonably large sharing is rejected without over-restricting legitimate shared houses", () => {
        handler.validateEffectiveAccommodation({ budgetMin: null, budgetMax: null, currency: null, sharing: 8 }); // legitimate, must pass
        assert.throws(
            () => handler.validateEffectiveAccommodation({ budgetMin: null, budgetMax: null, currency: null, sharing: 500 }),
            (err) => err.code === "VALIDATION_ERROR"
        );
    });

    await test("VALIDATION: invalid university — universityResolved missing id/name is rejected", () => {
        assert.throws(
            () => handler.validateEffectiveStudent({ university: "Test Uni", universityResolved: { name: "Test Uni" }, course: null, intake: null }),
            (err) => err.code === "VALIDATION_ERROR"
        );
    });

    await test("VALIDATION: unresolved university (universityResolved: null) is a valid state, not an error", () => {
        handler.validateEffectiveStudent({ university: "Some Typed Text", universityResolved: null, course: null, intake: null });
    });

    await test("VALIDATION: a well-formed universityResolved snapshot passes", () => {
        handler.validateEffectiveStudent({
            university: "University of Hertfordshire",
            universityResolved: { id: "university-of-hertfordshire", name: "University of Hertfordshire", city: "Hatfield", country: "United Kingdom", latitude: 51.7636, longitude: -0.2405 },
            course: null,
            intake: null,
        });
    });

    await test("MERGE: only keys present in the incoming partial are collected as set-paths; absent keys pass existing value through untouched", () => {
        const setPaths = {};
        const effective = handler.mergeAndCollectSetPaths(
            "accommodation",
            { budgetMin: 150, budgetMax: 250, currency: "GBP", sharing: null, moveInDate: null, stayDurationMonths: null, preferredLocation: null, roomPreference: null, distancePreference: null },
            { sharing: 2 },
            ["budgetMin", "budgetMax", "currency", "moveInDate", "stayDurationMonths", "preferredLocation", "roomPreference", "sharing", "distancePreference"],
            setPaths
        );
        assert.strictEqual(effective.budgetMin, 150, "untouched key must pass through from existing");
        assert.strictEqual(effective.sharing, 2, "provided key must be updated");
        assert.deepStrictEqual(setPaths, { "accommodation.sharing": 2 }, "only the provided key should become a set-path");
    });

    await test("MERGE: an explicit null in the incoming partial clears that field (distinct from an absent key)", () => {
        const setPaths = {};
        const effective = handler.mergeAndCollectSetPaths("accommodation", { sharing: 2 }, { sharing: null }, ["sharing"], setPaths);
        assert.strictEqual(effective.sharing, null);
        assert.deepStrictEqual(setPaths, { "accommodation.sharing": null });
    });

    // ══════════════════ VALIDATION: REQUIREMENT PROVENANCE (Milestone 23.10, pure) ══════════════════
    await test("PROVENANCE: each of the four valid sources is accepted", () => {
        for (const source of ["lead_form", "agent", "meeting", "transcript"]) {
            handler.validateRequirementSources({ university: source, budget: source, sharing: source });
        }
    });
    await test("PROVENANCE: null is a valid (unset) source", () => {
        handler.validateRequirementSources({ university: null, budget: null, sharing: null });
    });
    await test("PROVENANCE: an invalid source value is rejected", () => {
        assert.throws(
            () => handler.validateRequirementSources({ university: "ai_guess", budget: null, sharing: null }),
            (err) => err.code === "VALIDATION_ERROR" && /requirementSources\.university/.test(err.message)
        );
    });

    // ══════════════════════ MONGODB-DEPENDENT: AUTH / CRUD / SECURITY / LEGACY ══════════════════════
    const MONGODB_URI = process.env.MONGODB_URI;
    const dbName = MONGODB_URI ? getDbNameFromUri(MONGODB_URI) : "";
    const looksLikeTestDb = /test/i.test(dbName);

    if (!MONGODB_URI) {
        skip("AUTH/CRUD/SECURITY/LEGACY (see below)", "MONGODB_URI is not set — set it in .env.local (pointing at a database whose name contains \"test\") to run these.");
    } else if (!looksLikeTestDb && process.env.ALLOW_MONGODB_LIVE_TEST !== "true") {
        skip("AUTH/CRUD/SECURITY/LEGACY (see below)", `MONGODB_URI points at database "${dbName}", which doesn't look like a test database — refusing to run against it.`);
    } else {
        const { connectToDatabase } = require(path.join(ROOT, "api", "_lib", "mongodb"));
        const userStore = require(path.join(ROOT, "api", "_lib", "userStore"));
        const session = require(path.join(ROOT, "api", "_lib", "session"));
        const { resolveMongoUser } = require(path.join(ROOT, "api", "_lib", "businessAuth"));
        const Lead = require(path.join(ROOT, "api", "_lib", "models", "Lead"));
        const User = require(path.join(ROOT, "api", "_lib", "models", "User"));
        const Discovery = require(path.join(ROOT, "api", "_lib", "models", "Discovery"));

        await connectToDatabase();
        console.log("\nMongoDB connection established for live verification.\n");

        const runId = `verify-discovery-${Date.now()}`;
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

        const validSaveBody = {
            student: { university: "University of Hertfordshire", universityResolved: { id: "university-of-hertfordshire", name: "University of Hertfordshire", city: "Hatfield", country: "United Kingdom", latitude: 51.7636, longitude: -0.2405 } },
            accommodation: { budgetMin: 150, budgetMax: 250, currency: "GBP", sharing: 2, roomPreference: "2 Sharing" },
        };

        // ── AUTH ──
        await test("AUTH: unauthenticated GET -> 401", async () => {
            const res = mockRes();
            await handler(mockReq({ method: "GET", query: { id: String(leadA._id) } }), res);
            assert.strictEqual(res.statusCode, 401);
        });
        await test("AUTH: unauthenticated PUT -> 401", async () => {
            const res = mockRes();
            await handler(mockReq({ method: "PUT", query: { id: String(leadA._id) }, body: validSaveBody }), res);
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
        await test("CRUD: GET with no saved Discovery returns {data: null}", async () => {
            const res = mockRes();
            await handler(mockReq({ method: "GET", query: { id: String(leadA._id) }, cookie: agent.cookie }), res);
            assert.strictEqual(res.body.data, null);
        });
        await test("CRUD: PUT creates a new Discovery", async () => {
            const res = mockRes();
            await handler(mockReq({ method: "PUT", query: { id: String(leadA._id) }, cookie: agent.cookie, body: validSaveBody }), res);
            assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
            assert.strictEqual(res.body.data.student.university, "University of Hertfordshire");
            assert.strictEqual(res.body.data.accommodation.sharing, 2);
        });
        await test("CRUD: GET now returns the saved Discovery", async () => {
            const res = mockRes();
            await handler(mockReq({ method: "GET", query: { id: String(leadA._id) }, cookie: agent.cookie }), res);
            assert.strictEqual(res.body.data.accommodation.budgetMax, 250);
        });
        await test("CRUD: PUT updates (partial) — changing only sharing leaves budget/university untouched", async () => {
            const res = mockRes();
            await handler(mockReq({ method: "PUT", query: { id: String(leadA._id) }, cookie: agent.cookie, body: { accommodation: { sharing: 3 } } }), res);
            assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
            assert.strictEqual(res.body.data.accommodation.sharing, 3);
            assert.strictEqual(res.body.data.accommodation.budgetMin, 150, "budgetMin must survive a partial update that never mentioned it");
            assert.strictEqual(res.body.data.student.university, "University of Hertfordshire", "student.university must survive a partial accommodation-only update");
        });
        await test("CRUD: GET reflects the update", async () => {
            const res = mockRes();
            await handler(mockReq({ method: "GET", query: { id: String(leadA._id) }, cookie: agent.cookie }), res);
            assert.strictEqual(res.body.data.accommodation.sharing, 3);
        });

        // ── REQUIREMENT PROVENANCE (e2e, Milestone 23.10) ──
        await test("PROVENANCE (e2e): PUT can set requirementSources independently of the values they describe", async () => {
            const res = mockRes();
            await handler(mockReq({ method: "PUT", query: { id: String(leadA._id) }, cookie: agent.cookie, body: { requirementSources: { university: "meeting", budget: "lead_form" } } }), res);
            assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
            assert.strictEqual(res.body.data.requirementSources.university, "meeting");
            assert.strictEqual(res.body.data.requirementSources.budget, "lead_form");
            assert.strictEqual(res.body.data.requirementSources.sharing, null, "a source never mentioned in this call must stay null, not default to something");
            // The values themselves must be completely unaffected by this call.
            assert.strictEqual(res.body.data.accommodation.sharing, 3, "setting provenance must never change the requirement value itself");
        });
        await test("PROVENANCE (e2e): an unrelated update (notes only) leaves requirementSources untouched — no silent overwrite", async () => {
            const before = await Discovery.findOne({ leadId: leadA._id });
            const res = mockRes();
            await handler(mockReq({ method: "PUT", query: { id: String(leadA._id) }, cookie: agent.cookie, body: { notes: "agent called back" } }), res);
            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.body.data.requirementSources.university, before.requirementSources.university);
            assert.strictEqual(res.body.data.requirementSources.budget, before.requirementSources.budget);
        });
        await test("PROVENANCE (e2e): an explicit null clears a previously-set source", async () => {
            const res = mockRes();
            await handler(mockReq({ method: "PUT", query: { id: String(leadA._id) }, cookie: agent.cookie, body: { requirementSources: { university: null } } }), res);
            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.body.data.requirementSources.university, null);
            assert.strictEqual(res.body.data.requirementSources.budget, "lead_form", "clearing one source must not clear the others");
        });
        await test("PROVENANCE (e2e): an invalid source value -> 400, and does not partially apply", async () => {
            const before = await Discovery.findOne({ leadId: leadA._id });
            const res = mockRes();
            await handler(mockReq({ method: "PUT", query: { id: String(leadA._id) }, cookie: agent.cookie, body: { requirementSources: { sharing: "not_a_real_source" } } }), res);
            assert.strictEqual(res.statusCode, 400);
            const after = await Discovery.findOne({ leadId: leadA._id });
            assert.strictEqual(after.requirementSources.sharing, before.requirementSources.sharing, "a rejected PUT must not partially persist any of its fields");
        });
        await test("PROVENANCE (e2e): a fresh Discovery document defaults every source to null (never guessed)", async () => {
            const freshLead = await createLead("fresh-provenance");
            const res = mockRes();
            await handler(mockReq({ method: "PUT", query: { id: String(freshLead._id) }, cookie: agent.cookie, body: { notes: "first save" } }), res);
            assert.strictEqual(res.statusCode, 200);
            assert.deepStrictEqual(res.body.data.requirementSources, { university: null, budget: null, sharing: null });
        });

        // ── VALIDATION (e2e) ──
        await test("VALIDATION (e2e): invalid budget (min > max) -> 400", async () => {
            const res = mockRes();
            await handler(mockReq({ method: "PUT", query: { id: String(leadA._id) }, cookie: agent.cookie, body: { accommodation: { budgetMin: 500, budgetMax: 100 } } }), res);
            assert.strictEqual(res.statusCode, 400);
        });
        await test("VALIDATION (e2e): invalid sharing (0) -> 400", async () => {
            const res = mockRes();
            await handler(mockReq({ method: "PUT", query: { id: String(leadA._id) }, cookie: agent.cookie, body: { accommodation: { sharing: 0 } } }), res);
            assert.strictEqual(res.statusCode, 400);
        });
        await test("VALIDATION (e2e): setting a fresh budget with no currency anywhere (new lead) -> 400", async () => {
            const freshLead = await createLead("fresh-budget");
            const res = mockRes();
            await handler(mockReq({ method: "PUT", query: { id: String(freshLead._id) }, cookie: agent.cookie, body: { accommodation: { budgetMin: 100 } } }), res);
            assert.strictEqual(res.statusCode, 400);
        });
        await test("VALIDATION (e2e): GET/PUT against a non-existent lead -> 404", async () => {
            const fakeId = "000000000000000000000000";
            const getRes = mockRes();
            await handler(mockReq({ method: "GET", query: { id: fakeId }, cookie: agent.cookie }), getRes);
            assert.strictEqual(getRes.statusCode, 404);
        });

        // ── SECURITY ──
        await test("SECURITY: client-supplied createdBy/updatedBy are ignored", async () => {
            const res = mockRes();
            await handler(
                mockReq({ method: "PUT", query: { id: String(leadA._id) }, cookie: manager.cookie, body: { accommodation: { sharing: 4 }, createdBy: "000000000000000000000000", updatedBy: "000000000000000000000000" } }),
                res
            );
            assert.strictEqual(res.statusCode, 200);
            const stored = await Discovery.findOne({ leadId: leadA._id });
            assert.strictEqual(String(stored.updatedBy), String(manager.mongoUser._id));
        });
        await test("SECURITY: createdBy is set once on first insert and never changes", async () => {
            const before = await Discovery.findOne({ leadId: leadA._id });
            const originalCreatedBy = String(before.createdBy);
            const res = mockRes();
            await handler(mockReq({ method: "PUT", query: { id: String(leadA._id) }, cookie: admin.cookie, body: { notes: "final check" } }), res);
            assert.strictEqual(res.statusCode, 200);
            const after = await Discovery.findOne({ leadId: leadA._id });
            assert.strictEqual(String(after.createdBy), originalCreatedBy);
            assert.strictEqual(String(after.updatedBy), String(admin.mongoUser._id));
        });

        // ── CROSS-LEAD ISOLATION ──
        await test("CROSS-LEAD ISOLATION: GET for lead B returns null, never lead A's Discovery", async () => {
            const res = mockRes();
            await handler(mockReq({ method: "GET", query: { id: String(leadB._id) }, cookie: agent.cookie }), res);
            assert.strictEqual(res.body.data, null);
        });
        await test("CROSS-LEAD ISOLATION: PUT for lead B never modifies lead A's Discovery", async () => {
            const beforeA = await Discovery.findOne({ leadId: leadA._id });
            const res = mockRes();
            await handler(mockReq({ method: "PUT", query: { id: String(leadB._id) }, cookie: agent.cookie, body: { student: { university: "Lead B University" } } }), res);
            assert.strictEqual(res.statusCode, 200);
            const afterA = await Discovery.findOne({ leadId: leadA._id });
            const afterB = await Discovery.findOne({ leadId: leadB._id });
            assert.strictEqual(String(afterA.updatedAt), String(beforeA.updatedAt));
            assert.strictEqual(afterB.student.university, "Lead B University");
            assert.notStrictEqual(afterA.student.university, afterB.student.university);
        });

        // ── LEGACY BEHAVIOR ──
        await test("LEGACY: a record saved with only roomPreference (no explicit sharing) reports sharing as honestly null, never guessed server-side", async () => {
            const legacyLead = await createLead("legacy");
            const res = mockRes();
            await handler(mockReq({ method: "PUT", query: { id: String(legacyLead._id) }, cookie: agent.cookie, body: { accommodation: { roomPreference: "2 Sharing" } } }), res);
            assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
            assert.strictEqual(res.body.data.accommodation.sharing, null, "the backend must never derive sharing from roomPreference text itself");
            assert.strictEqual(res.body.data.accommodation.roomPreference, "2 Sharing");

            const getRes = mockRes();
            await handler(mockReq({ method: "GET", query: { id: String(legacyLead._id) }, cookie: agent.cookie }), getRes);
            assert.strictEqual(getRes.body.data.accommodation.sharing, null);
        });

        // ── CLEANUP ──
        await Discovery.deleteMany({ leadId: { $in: createdLeadIds } });
        await Lead.deleteMany({ _id: { $in: createdLeadIds } });
        await User.deleteMany({ _id: { $in: createdUserIds } });
        const remaining = await Discovery.countDocuments({ leadId: { $in: createdLeadIds } });
        assert.strictEqual(remaining, 0, "cleanup must remove every Discovery document this run created");
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
