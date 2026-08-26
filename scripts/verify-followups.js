#!/usr/bin/env node
// Milestone 23.11 — Follow-up backend verification.
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
    console.log("=== IvyHuts Follow-ups Verification (Milestone 23.11) ===");
    console.log("Redis: forced in-memory fallback for this run.\n");

    const listHandler = require(path.join(ROOT, "api", "_lib", "routes", "leads", "[id]", "follow-ups", "index.js"));
    const singleHandler = require(path.join(ROOT, "api", "_lib", "routes", "leads", "[id]", "follow-ups", "[followUpId]", "index.js"));

    // ══════════════════════ STRUCTURAL ══════════════════════
    await test("STRUCTURAL: no reference to Amber anywhere in the routes (comments excluded)", () => {
        const fs = require("fs");
        const stripComments = (src) => src.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
        const files = [
            path.join(ROOT, "api", "_lib", "routes", "leads", "[id]", "follow-ups", "index.js"),
            path.join(ROOT, "api", "_lib", "routes", "leads", "[id]", "follow-ups", "[followUpId]", "index.js"),
        ];
        files.forEach((f) => assert.ok(!/\bamber\b/i.test(stripComments(fs.readFileSync(f, "utf8")))));
    });

    // ══════════════════ MONGODB-DEPENDENT ══════════════════
    const MONGODB_URI = process.env.MONGODB_URI;
    const dbName = MONGODB_URI ? getDbNameFromUri(MONGODB_URI) : "";
    const looksLikeTestDb = /test/i.test(dbName);

    if (!MONGODB_URI) {
        skip("AUTH/CRUD/COMPLETION/SECURITY/CROSS-LEAD ISOLATION (see below)", "MONGODB_URI is not set.");
    } else if (!looksLikeTestDb && process.env.ALLOW_MONGODB_LIVE_TEST !== "true") {
        skip("AUTH/CRUD/COMPLETION/SECURITY/CROSS-LEAD ISOLATION (see below)", `MONGODB_URI points at database "${dbName}", which doesn't look like a test database — refusing to run against it.`);
    } else {
        const { connectToDatabase } = require(path.join(ROOT, "api", "_lib", "mongodb"));
        const userStore = require(path.join(ROOT, "api", "_lib", "userStore"));
        const session = require(path.join(ROOT, "api", "_lib", "session"));
        const { resolveMongoUser } = require(path.join(ROOT, "api", "_lib", "businessAuth"));
        const Lead = require(path.join(ROOT, "api", "_lib", "models", "Lead"));
        const User = require(path.join(ROOT, "api", "_lib", "models", "User"));
        const FollowUp = require(path.join(ROOT, "api", "_lib", "models", "FollowUp"));

        await connectToDatabase();
        console.log("\nMongoDB connection established for live verification.\n");

        const runId = `verify-followups-${Date.now()}`;
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
        async function createLead(tag, overrides = {}) {
            const lead = await Lead.create({ contact: { name: `Test Lead ${tag}`, email: `${runId}-lead-${tag}@example.test` }, source: "verify-script", ...overrides });
            createdLeadIds.push(lead._id);
            return lead;
        }

        const agent = await createActor("MARKETING_AGENT", "agent");
        const manager = await createActor("MARKETING_MANAGER", "manager");
        const plainUser = await createActor("USER", "plain");

        const leadA = await createLead("a", { assignedTo: String(agent.mongoUser._id) });
        const leadB = await createLead("b");

        // ── AUTH ──
        await test("AUTH: unauthenticated GET list -> 401", async () => {
            const res = mockRes();
            await listHandler(mockReq({ method: "GET", query: { id: String(leadA._id) } }), res);
            assert.strictEqual(res.statusCode, 401);
        });
        await test("AUTH: plain USER POST -> 403", async () => {
            const res = mockRes();
            await listHandler(mockReq({ method: "POST", query: { id: String(leadA._id) }, cookie: plainUser.cookie, body: { type: "call", dueAt: "2026-09-01T10:00:00.000Z" } }), res);
            assert.strictEqual(res.statusCode, 403);
        });

        // ── CRUD / OWNERSHIP ──
        let fuId;
        await test("CRUD: POST creates a follow-up with assignedTo derived from the LEAD's assignment, never the session or body", async () => {
            const res = mockRes();
            await listHandler(
                mockReq({
                    method: "POST", query: { id: String(leadA._id) }, cookie: manager.cookie, // manager creates it, agent is assigned
                    body: { type: "call", dueAt: "2026-09-01T10:00:00.000Z", priority: "high", notes: "Discuss budget", assignedTo: "000000000000000000000000" },
                }),
                res
            );
            assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
            assert.strictEqual(res.body.data.assignedTo, String(agent.mongoUser._id), "assignedTo must come from the Lead's own assignment, not the creator");
            assert.strictEqual(res.body.data.status, "pending");
            fuId = res.body.data.id;
        });

        await test("CRUD: an unassigned lead's follow-up has assignedTo: null (never invented)", async () => {
            const unassignedLead = await createLead("unassigned");
            const res = mockRes();
            await listHandler(mockReq({ method: "POST", query: { id: String(unassignedLead._id) }, cookie: agent.cookie, body: { type: "email", dueAt: "2026-09-01T10:00:00.000Z" } }), res);
            assert.strictEqual(res.statusCode, 201);
            assert.strictEqual(res.body.data.assignedTo, null);
        });

        await test("CRUD: GET list works", async () => {
            const res = mockRes();
            await listHandler(mockReq({ method: "GET", query: { id: String(leadA._id) }, cookie: agent.cookie }), res);
            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.body.data.length, 1);
        });
        await test("CRUD: GET single works", async () => {
            const res = mockRes();
            await singleHandler(mockReq({ method: "GET", query: { id: String(leadA._id), followUpId: fuId }, cookie: agent.cookie }), res);
            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.body.data.id, fuId);
        });

        // ── COMPLETION ──
        await test("COMPLETION: PATCH to status=completed sets completedAt exactly once", async () => {
            const res = mockRes();
            await singleHandler(mockReq({ method: "PATCH", query: { id: String(leadA._id), followUpId: fuId }, cookie: agent.cookie, body: { status: "completed", notes: "Called, discussed budget." } }), res);
            assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
            assert.strictEqual(res.body.data.status, "completed");
            assert.ok(res.body.data.completedAt);
            assert.strictEqual(res.body.data.notes, "Called, discussed budget.");
        });
        await test("COMPLETION: completedAt does not change on a later unrelated PATCH", async () => {
            const before = await FollowUp.findById(fuId);
            const res = mockRes();
            await singleHandler(mockReq({ method: "PATCH", query: { id: String(leadA._id), followUpId: fuId }, cookie: agent.cookie, body: { notes: "amended note" } }), res);
            assert.strictEqual(res.statusCode, 200);
            const after = await FollowUp.findById(fuId);
            assert.strictEqual(new Date(after.completedAt).getTime(), new Date(before.completedAt).getTime());
        });

        // ── CANCELLATION ──
        await test("CANCELLATION: a pending follow-up can be cancelled via the existing status enum (no new state invented)", async () => {
            const res1 = mockRes();
            await listHandler(mockReq({ method: "POST", query: { id: String(leadA._id) }, cookie: agent.cookie, body: { type: "email", dueAt: "2026-09-05T10:00:00.000Z" } }), res1);
            const cancelId = res1.body.data.id;
            const res2 = mockRes();
            await singleHandler(mockReq({ method: "PATCH", query: { id: String(leadA._id), followUpId: cancelId }, cookie: agent.cookie, body: { status: "cancelled" } }), res2);
            assert.strictEqual(res2.statusCode, 200);
            assert.strictEqual(res2.body.data.status, "cancelled");
            assert.strictEqual(res2.body.data.completedAt, null, "cancelling must never set completedAt — that's specific to actual completion");
        });

        // ── VALIDATION (e2e) ──
        await test("VALIDATION (e2e): invalid type -> 400", async () => {
            const res = mockRes();
            await listHandler(mockReq({ method: "POST", query: { id: String(leadA._id) }, cookie: agent.cookie, body: { type: "carrier_pigeon", dueAt: "2026-09-01T10:00:00.000Z" } }), res);
            assert.strictEqual(res.statusCode, 400);
        });
        await test("VALIDATION (e2e): missing dueAt -> 400", async () => {
            const res = mockRes();
            await listHandler(mockReq({ method: "POST", query: { id: String(leadA._id) }, cookie: agent.cookie, body: { type: "call" } }), res);
            assert.strictEqual(res.statusCode, 400);
        });
        await test("VALIDATION (e2e): invalid status on PATCH -> 400", async () => {
            const res = mockRes();
            await singleHandler(mockReq({ method: "PATCH", query: { id: String(leadA._id), followUpId: fuId }, cookie: agent.cookie, body: { status: "in_progress" } }), res);
            assert.strictEqual(res.statusCode, 400);
        });
        await test("VALIDATION (e2e): GET/POST against a non-existent lead -> 404", async () => {
            const fakeId = "000000000000000000000000";
            const res = mockRes();
            await listHandler(mockReq({ method: "GET", query: { id: fakeId }, cookie: agent.cookie }), res);
            assert.strictEqual(res.statusCode, 404);
        });

        // ── CROSS-LEAD ISOLATION ──
        await test("CROSS-LEAD ISOLATION: leadB's follow-up list is empty despite leadA having entries", async () => {
            const res = mockRes();
            await listHandler(mockReq({ method: "GET", query: { id: String(leadB._id) }, cookie: agent.cookie }), res);
            assert.strictEqual(res.statusCode, 200);
            assert.deepStrictEqual(res.body.data, []);
        });
        await test("CROSS-LEAD ISOLATION: fetching leadA's follow-up through leadB's URL -> 404", async () => {
            const res = mockRes();
            await singleHandler(mockReq({ method: "GET", query: { id: String(leadB._id), followUpId: fuId }, cookie: agent.cookie }), res);
            assert.strictEqual(res.statusCode, 404);
        });
        await test("CROSS-LEAD ISOLATION: PATCHing leadA's follow-up through leadB's URL -> 404, never mutates it", async () => {
            const before = await FollowUp.findById(fuId);
            const res = mockRes();
            await singleHandler(mockReq({ method: "PATCH", query: { id: String(leadB._id), followUpId: fuId }, cookie: agent.cookie, body: { status: "cancelled" } }), res);
            assert.strictEqual(res.statusCode, 404);
            const after = await FollowUp.findById(fuId);
            assert.strictEqual(after.status, before.status);
        });

        // ── CLEANUP ──
        await FollowUp.deleteMany({ leadId: { $in: createdLeadIds } });
        await Lead.deleteMany({ _id: { $in: createdLeadIds } });
        await User.deleteMany({ _id: { $in: createdUserIds } });
        const remaining = await FollowUp.countDocuments({ leadId: { $in: createdLeadIds } });
        assert.strictEqual(remaining, 0, "cleanup must remove every follow-up this run created");
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
