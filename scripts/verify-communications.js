#!/usr/bin/env node
// Milestone 23.11 — Communication backend verification.
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
    console.log("=== IvyHuts Communications Verification (Milestone 23.11) ===");
    console.log("Redis: forced in-memory fallback for this run.\n");

    const listHandler = require(path.join(ROOT, "api", "leads", "[id]", "communications", "index.js"));
    const singleHandler = require(path.join(ROOT, "api", "leads", "[id]", "communications", "[communicationId]", "index.js"));

    // ══════════════════════ STRUCTURAL ══════════════════════
    await test("STRUCTURAL: no reference to Amber anywhere in the routes (comments excluded)", () => {
        const fs = require("fs");
        const stripComments = (src) => src.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
        const files = [
            path.join(ROOT, "api", "leads", "[id]", "communications", "index.js"),
            path.join(ROOT, "api", "leads", "[id]", "communications", "[communicationId]", "index.js"),
        ];
        files.forEach((f) => assert.ok(!/\bamber\b/i.test(stripComments(fs.readFileSync(f, "utf8")))));
    });

    // ══════════════════ PURE: VALIDATION ══════════════════
    await test("VALIDATION: a valid channel/direction pair passes", () => {
        listHandler.validateChannelAndDirection("whatsapp", "outbound");
        listHandler.validateChannelAndDirection("phone", "inbound");
    });
    await test("VALIDATION: an invalid channel is rejected", () => {
        assert.throws(() => listHandler.validateChannelAndDirection("carrier_pigeon", "outbound"), (err) => err.code === "VALIDATION_ERROR");
    });
    await test("VALIDATION: an invalid direction is rejected", () => {
        assert.throws(() => listHandler.validateChannelAndDirection("email", "sideways"), (err) => err.code === "VALIDATION_ERROR");
    });

    // ══════════════════ MONGODB-DEPENDENT ══════════════════
    const MONGODB_URI = process.env.MONGODB_URI;
    const dbName = MONGODB_URI ? getDbNameFromUri(MONGODB_URI) : "";
    const looksLikeTestDb = /test/i.test(dbName);

    if (!MONGODB_URI) {
        skip("AUTH/CRUD/SECURITY/CROSS-LEAD ISOLATION (see below)", "MONGODB_URI is not set.");
    } else if (!looksLikeTestDb && process.env.ALLOW_MONGODB_LIVE_TEST !== "true") {
        skip("AUTH/CRUD/SECURITY/CROSS-LEAD ISOLATION (see below)", `MONGODB_URI points at database "${dbName}", which doesn't look like a test database — refusing to run against it.`);
    } else {
        const { connectToDatabase } = require(path.join(ROOT, "api", "_lib", "mongodb"));
        const userStore = require(path.join(ROOT, "api", "_lib", "userStore"));
        const session = require(path.join(ROOT, "api", "_lib", "session"));
        const { resolveMongoUser } = require(path.join(ROOT, "api", "_lib", "businessAuth"));
        const Lead = require(path.join(ROOT, "api", "_lib", "models", "Lead"));
        const User = require(path.join(ROOT, "api", "_lib", "models", "User"));
        const Communication = require(path.join(ROOT, "api", "_lib", "models", "Communication"));

        await connectToDatabase();
        console.log("\nMongoDB connection established for live verification.\n");

        const runId = `verify-communications-${Date.now()}`;
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
        const plainUser = await createActor("USER", "plain");
        const leadA = await createLead("a");
        const leadB = await createLead("b");

        // ── AUTH ──
        await test("AUTH: unauthenticated GET list -> 401", async () => {
            const res = mockRes();
            await listHandler(mockReq({ method: "GET", query: { id: String(leadA._id) } }), res);
            assert.strictEqual(res.statusCode, 401);
        });
        await test("AUTH: unauthenticated POST -> 401", async () => {
            const res = mockRes();
            await listHandler(mockReq({ method: "POST", query: { id: String(leadA._id) }, body: { channel: "phone", direction: "outbound" } }), res);
            assert.strictEqual(res.statusCode, 401);
        });
        await test("AUTH: plain USER GET list -> 403", async () => {
            const res = mockRes();
            await listHandler(mockReq({ method: "GET", query: { id: String(leadA._id) }, cookie: plainUser.cookie }), res);
            assert.strictEqual(res.statusCode, 403);
        });

        // ── CRUD / OWNERSHIP ──
        let commId;
        await test("CRUD: POST creates a communication with server-derived agentId, never from the body", async () => {
            const res = mockRes();
            await listHandler(
                mockReq({
                    method: "POST", query: { id: String(leadA._id) }, cookie: agent.cookie,
                    body: { channel: "phone", direction: "outbound", type: "call", content: "Discussed budget.", agentId: "000000000000000000000000" },
                }),
                res
            );
            assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
            assert.strictEqual(res.body.data.agentId, String(agent.mongoUser._id));
            assert.notStrictEqual(res.body.data.agentId, "000000000000000000000000");
            commId = res.body.data.id;
        });

        await test("OWNERSHIP: userId is derived from the Lead's own userId, never from the body", async () => {
            const leadWithUser = await createLead("with-user", { userId: agent.mongoUser._id });
            const res = mockRes();
            await listHandler(
                mockReq({ method: "POST", query: { id: String(leadWithUser._id) }, cookie: agent.cookie, body: { channel: "email", direction: "outbound", userId: "000000000000000000000000" } }),
                res
            );
            assert.strictEqual(res.statusCode, 201);
            assert.strictEqual(res.body.data.userId, String(agent.mongoUser._id));
        });

        await test("SIDE EFFECT: recording a communication bumps Lead.lastContactAt", async () => {
            const before = await Lead.findById(leadA._id);
            await new Promise((r) => setTimeout(r, 5));
            const res = mockRes();
            await listHandler(mockReq({ method: "POST", query: { id: String(leadA._id) }, cookie: agent.cookie, body: { channel: "sms", direction: "outbound" } }), res);
            assert.strictEqual(res.statusCode, 201);
            const after = await Lead.findById(leadA._id);
            assert.ok(new Date(after.lastContactAt).getTime() > new Date(before.lastContactAt).getTime());
        });

        await test("CRUD: GET list returns communications newest first", async () => {
            const res = mockRes();
            await listHandler(mockReq({ method: "GET", query: { id: String(leadA._id) }, cookie: agent.cookie }), res);
            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.body.data.length, 2);
            assert.ok(new Date(res.body.data[0].createdAt).getTime() >= new Date(res.body.data[1].createdAt).getTime());
        });

        await test("CRUD: GET single works", async () => {
            const res = mockRes();
            await singleHandler(mockReq({ method: "GET", query: { id: String(leadA._id), communicationId: commId }, cookie: agent.cookie }), res);
            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.body.data.id, commId);
        });

        await test("CRUD: PATCH can correct content, but never reassigns agentId", async () => {
            const res = mockRes();
            await singleHandler(
                mockReq({ method: "PATCH", query: { id: String(leadA._id), communicationId: commId }, cookie: agent.cookie, body: { content: "Corrected: discussed budget AND move-in date.", agentId: "000000000000000000000000" } }),
                res
            );
            assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
            assert.strictEqual(res.body.data.content, "Corrected: discussed budget AND move-in date.");
            assert.strictEqual(res.body.data.agentId, String(agent.mongoUser._id));
        });

        await test("VALIDATION (e2e): invalid channel on POST -> 400", async () => {
            const res = mockRes();
            await listHandler(mockReq({ method: "POST", query: { id: String(leadA._id) }, cookie: agent.cookie, body: { channel: "fax", direction: "outbound" } }), res);
            assert.strictEqual(res.statusCode, 400);
        });
        await test("VALIDATION (e2e): content longer than MAX_CONTENT_LENGTH but under the raw payload cap is truncated, not rejected", async () => {
            const res = mockRes();
            await listHandler(mockReq({ method: "POST", query: { id: String(leadA._id) }, cookie: agent.cookie, body: { channel: "email", direction: "outbound", content: "x".repeat(5500) } }), res);
            assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
            assert.strictEqual(res.body.data.content.length, 5000);
        });
        await test("VALIDATION (e2e): a payload exceeding MAX_PAYLOAD_BYTES entirely is rejected (413-style, via 400 PAYLOAD_TOO_LARGE)", async () => {
            const res = mockRes();
            await listHandler(mockReq({ method: "POST", query: { id: String(leadA._id) }, cookie: agent.cookie, body: { channel: "email", direction: "outbound", content: "x".repeat(6000) } }), res);
            assert.strictEqual(res.statusCode, 400);
        });
        await test("VALIDATION (e2e): GET/POST against a non-existent lead -> 404", async () => {
            const fakeId = "000000000000000000000000";
            const res = mockRes();
            await listHandler(mockReq({ method: "GET", query: { id: fakeId }, cookie: agent.cookie }), res);
            assert.strictEqual(res.statusCode, 404);
        });

        // ── CROSS-LEAD ISOLATION ──
        await test("CROSS-LEAD ISOLATION: leadB's communication list is empty despite leadA having entries", async () => {
            const res = mockRes();
            await listHandler(mockReq({ method: "GET", query: { id: String(leadB._id) }, cookie: agent.cookie }), res);
            assert.strictEqual(res.statusCode, 200);
            assert.deepStrictEqual(res.body.data, []);
        });
        await test("CROSS-LEAD ISOLATION: fetching leadA's communication through leadB's URL -> 404", async () => {
            const res = mockRes();
            await singleHandler(mockReq({ method: "GET", query: { id: String(leadB._id), communicationId: commId }, cookie: agent.cookie }), res);
            assert.strictEqual(res.statusCode, 404);
        });
        await test("CROSS-LEAD ISOLATION: PATCHing leadA's communication through leadB's URL -> 404, never mutates it", async () => {
            const before = await Communication.findById(commId);
            const res = mockRes();
            await singleHandler(mockReq({ method: "PATCH", query: { id: String(leadB._id), communicationId: commId }, cookie: agent.cookie, body: { content: "hijacked" } }), res);
            assert.strictEqual(res.statusCode, 404);
            const after = await Communication.findById(commId);
            assert.strictEqual(after.content, before.content);
        });

        // ── CLEANUP ──
        await Communication.deleteMany({ leadId: { $in: createdLeadIds } });
        await Lead.deleteMany({ _id: { $in: createdLeadIds } });
        await User.deleteMany({ _id: { $in: createdUserIds } });
        const remaining = await Communication.countDocuments({ leadId: { $in: createdLeadIds } });
        assert.strictEqual(remaining, 0, "cleanup must remove every communication this run created");
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
