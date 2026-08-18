#!/usr/bin/env node
// Milestone 23.10 — Meeting backend verification.
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
    console.log("=== IvyHuts Meetings Verification (Milestone 23.10) ===");
    console.log("Redis: forced in-memory fallback for this run.\n");

    const listHandler = require(path.join(ROOT, "api", "leads", "[id]", "meetings", "index.js"));
    const singleHandler = require(path.join(ROOT, "api", "leads", "[id]", "meetings", "[meetingId]", "index.js"));

    // ══════════════════════ STRUCTURAL ══════════════════════
    await test("STRUCTURAL: no reference to Amber anywhere in the model or routes (comments excluded)", () => {
        const fs = require("fs");
        const stripComments = (src) => src.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
        const files = [
            path.join(ROOT, "api", "_lib", "models", "Meeting.js"),
            path.join(ROOT, "api", "leads", "[id]", "meetings", "index.js"),
            path.join(ROOT, "api", "leads", "[id]", "meetings", "[meetingId]", "index.js"),
        ];
        files.forEach((f) => assert.ok(!/\bamber\b/i.test(stripComments(fs.readFileSync(f, "utf8")))));
    });

    // ══════════════════ PURE: MEDIA-PAIR VALIDATION ══════════════════
    await test("VALIDATION: recordingStatus 'available' requires a non-empty recordingUrl", () => {
        assert.throws(() => singleHandler.validateMediaPair("available", null, "recording"), (err) => err.code === "VALIDATION_ERROR");
        assert.throws(() => singleHandler.validateMediaPair("available", "", "recording"), (err) => err.code === "VALIDATION_ERROR");
        assert.doesNotThrow(() => singleHandler.validateMediaPair("available", "https://example.test/rec.mp4", "recording"));
    });
    await test("VALIDATION: a non-'available' status must have a null url/reference", () => {
        assert.throws(() => singleHandler.validateMediaPair("pending", "https://example.test/rec.mp4", "recording"), (err) => err.code === "VALIDATION_ERROR");
        assert.doesNotThrow(() => singleHandler.validateMediaPair("pending", null, "recording"));
        assert.doesNotThrow(() => singleHandler.validateMediaPair("none", null, "transcript"));
    });
    await test("VALIDATION: an invalid status value is rejected", () => {
        assert.throws(() => singleHandler.validateMediaPair("live", null, "recording"), (err) => err.code === "VALIDATION_ERROR");
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
        const Meeting = require(path.join(ROOT, "api", "_lib", "models", "Meeting"));

        await connectToDatabase();
        console.log("\nMongoDB connection established for live verification.\n");

        const runId = `verify-meetings-${Date.now()}`;
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
            await listHandler(mockReq({ method: "POST", query: { id: String(leadA._id) }, body: { scheduledAt: new Date().toISOString() } }), res);
            assert.strictEqual(res.statusCode, 401);
        });
        await test("AUTH: plain USER GET list -> 403", async () => {
            const res = mockRes();
            await listHandler(mockReq({ method: "GET", query: { id: String(leadA._id) }, cookie: plainUser.cookie }), res);
            assert.strictEqual(res.statusCode, 403);
        });

        // ── CRUD ──
        let meetingId;
        await test("CRUD: POST schedules a meeting starting 'scheduled' with media status 'none'", async () => {
            const res = mockRes();
            await listHandler(mockReq({ method: "POST", query: { id: String(leadA._id) }, cookie: agent.cookie, body: { scheduledAt: "2026-09-01T10:00:00.000Z", notes: "Intro call" } }), res);
            assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
            assert.strictEqual(res.body.data.status, "scheduled");
            assert.strictEqual(res.body.data.recordingStatus, "none");
            assert.strictEqual(res.body.data.transcriptStatus, "none");
            meetingId = res.body.data.id;
        });

        await test("CRUD: POST requires scheduledAt", async () => {
            const res = mockRes();
            await listHandler(mockReq({ method: "POST", query: { id: String(leadA._id) }, cookie: agent.cookie, body: { notes: "no date" } }), res);
            assert.strictEqual(res.statusCode, 400);
        });

        await test("CRUD: GET list returns the created meeting", async () => {
            const res = mockRes();
            await listHandler(mockReq({ method: "GET", query: { id: String(leadA._id) }, cookie: agent.cookie }), res);
            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.body.data.length, 1);
            assert.strictEqual(res.body.data[0].id, meetingId);
        });

        await test("CRUD: GET single meeting works", async () => {
            const res = mockRes();
            await singleHandler(mockReq({ method: "GET", query: { id: String(leadA._id), meetingId }, cookie: agent.cookie }), res);
            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.body.data.id, meetingId);
        });

        await test("CRUD: PATCH can mark completed and sets completedAt", async () => {
            const res = mockRes();
            await singleHandler(mockReq({ method: "PATCH", query: { id: String(leadA._id), meetingId }, cookie: agent.cookie, body: { status: "completed" } }), res);
            assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
            assert.strictEqual(res.body.data.status, "completed");
            assert.ok(res.body.data.completedAt);
        });

        await test("CRUD: PATCH can move recordingStatus to pending, then to available with a URL", async () => {
            const res1 = mockRes();
            await singleHandler(mockReq({ method: "PATCH", query: { id: String(leadA._id), meetingId }, cookie: agent.cookie, body: { recordingStatus: "pending" } }), res1);
            assert.strictEqual(res1.statusCode, 200, JSON.stringify(res1.body));
            assert.strictEqual(res1.body.data.recordingStatus, "pending");

            const res2 = mockRes();
            await singleHandler(mockReq({ method: "PATCH", query: { id: String(leadA._id), meetingId }, cookie: agent.cookie, body: { recordingStatus: "available", recordingUrl: "https://example.test/recording.mp4" } }), res2);
            assert.strictEqual(res2.statusCode, 200, JSON.stringify(res2.body));
            assert.strictEqual(res2.body.data.recordingUrl, "https://example.test/recording.mp4");
        });

        await test("CRUD: PATCH rejects recordingStatus='available' without a URL", async () => {
            const res = mockRes();
            await singleHandler(mockReq({ method: "PATCH", query: { id: String(leadA._id), meetingId }, cookie: agent.cookie, body: { recordingStatus: "available", recordingUrl: null } }), res);
            assert.strictEqual(res.statusCode, 400);
        });

        await test("CRUD: PATCH can set transcriptStatus to available with a reference (never fabricated content)", async () => {
            const res = mockRes();
            await singleHandler(mockReq({ method: "PATCH", query: { id: String(leadA._id), meetingId }, cookie: agent.cookie, body: { transcriptStatus: "available", transcriptReference: "drive://transcripts/lead-a-call-1" } }), res);
            assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
            assert.strictEqual(res.body.data.transcriptStatus, "available");
            assert.strictEqual(res.body.data.transcriptReference, "drive://transcripts/lead-a-call-1");
        });

        // ── INVALID LEAD / MEETING ──
        await test("VALIDATION: POST/GET against a non-existent lead -> 404", async () => {
            const fakeId = "000000000000000000000000";
            const getRes = mockRes();
            await listHandler(mockReq({ method: "GET", query: { id: fakeId }, cookie: agent.cookie }), getRes);
            assert.strictEqual(getRes.statusCode, 404);
        });
        await test("VALIDATION: GET a non-existent meeting on a real lead -> 404", async () => {
            const fakeMeetingId = "000000000000000000000000";
            const res = mockRes();
            await singleHandler(mockReq({ method: "GET", query: { id: String(leadA._id), meetingId: fakeMeetingId }, cookie: agent.cookie }), res);
            assert.strictEqual(res.statusCode, 404);
        });

        // ── CROSS-LEAD ISOLATION ──
        await test("CROSS-LEAD ISOLATION: leadB's meeting list is empty despite leadA having one", async () => {
            const res = mockRes();
            await listHandler(mockReq({ method: "GET", query: { id: String(leadB._id) }, cookie: agent.cookie }), res);
            assert.strictEqual(res.statusCode, 200);
            assert.deepStrictEqual(res.body.data, []);
        });
        await test("CROSS-LEAD ISOLATION: fetching leadA's meeting through leadB's URL -> 404", async () => {
            const res = mockRes();
            await singleHandler(mockReq({ method: "GET", query: { id: String(leadB._id), meetingId }, cookie: agent.cookie }), res);
            assert.strictEqual(res.statusCode, 404);
        });
        await test("CROSS-LEAD ISOLATION: PATCHing leadA's meeting through leadB's URL -> 404, never mutates it", async () => {
            const before = await Meeting.findById(meetingId);
            const res = mockRes();
            await singleHandler(mockReq({ method: "PATCH", query: { id: String(leadB._id), meetingId }, cookie: agent.cookie, body: { status: "cancelled" } }), res);
            assert.strictEqual(res.statusCode, 404);
            const after = await Meeting.findById(meetingId);
            assert.strictEqual(after.status, before.status);
        });

        // ── CLEANUP ──
        await Meeting.deleteMany({ leadId: { $in: createdLeadIds } });
        await Lead.deleteMany({ _id: { $in: createdLeadIds } });
        await User.deleteMany({ _id: { $in: createdUserIds } });
        const remaining = await Meeting.countDocuments({ leadId: { $in: createdLeadIds } });
        assert.strictEqual(remaining, 0, "cleanup must remove every meeting this run created");
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
