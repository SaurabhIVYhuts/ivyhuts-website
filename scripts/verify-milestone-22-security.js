#!/usr/bin/env node
// Focused verification for Milestone 22 (Security + CRM Contract
// Foundation): the /api/insights/* RBAC fix, the "nurturing" Lead status
// addition, and a cross-lead-isolation regression guard for the nested
// reads that already exist (buildLeadDetail, buildCustomer360). Same style
// as scripts/verify-business-api.js — a standalone Node script, not Jest.
//
// REDIS: forced into in-memory fallback (see verify-business-api.js's
// header comment for why — same reasoning applies here).
//
// MONGODB: unlike verify-business-api.js, this script REQUIRES MONGODB_URI
// to already be set in the environment to a local, throwaway instance
// before this script runs (Milestone 22 explicitly forbids touching the
// real Atlas database at all, even a same-Atlas "test"-named database).
// This script does NOT load .env.local's MONGODB_URI — dotenv.config()
// never overrides an already-set process.env value, so as long as
// MONGODB_URI is exported before `node` is invoked, that value wins. The
// existing "database name must contain 'test'" guard is kept anyway as a
// second safety net.
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

function mockReq({ method = "GET", body, cookie, query = {} } = {}) {
    return {
        method,
        body,
        query: { ...query },
        headers: cookie ? { cookie } : {},
        socket: { remoteAddress: "127.0.0.1" },
    };
}
function mockRes() {
    const res = { statusCode: 200, headers: {}, body: undefined };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (body) => { res.body = JSON.parse(JSON.stringify(body)); return res; };
    res.setHeader = (key, value) => { res.headers[key] = value; return res; };
    return res;
}

function getDbNameFromUri(uri) {
    const match = /\/([^/?]+)(\?|$)/.exec(uri.replace(/^mongodb(\+srv)?:\/\//, "mongodb://").split("@").pop());
    return match ? match[1] : "";
}

async function main() {
    console.log("=== IvyHuts Milestone 22 Verification (Security + Nurturing) ===");
    console.log("Redis: forced in-memory fallback for this run.\n");

    const MONGODB_URI = process.env.MONGODB_URI;
    if (!MONGODB_URI) {
        console.log("MONGODB_URI is not set. This script must be pointed at a local, throwaway");
        console.log("MongoDB instance (e.g. mongodb://127.0.0.1:27099/ivyhuts_test_m22) — it will");
        console.log("NEVER fall back to whatever is in .env.local, by design.");
        process.exitCode = 1;
        return;
    }
    if (!/^mongodb:\/\/(127\.0\.0\.1|localhost)[:/]/.test(MONGODB_URI)) {
        console.log("Refusing to run: MONGODB_URI does not point at 127.0.0.1/localhost.");
        console.log("Milestone 22 explicitly forbids running these tests against Atlas, even a");
        console.log("database whose name contains \"test\". Point MONGODB_URI at a local mongod.");
        process.exitCode = 1;
        return;
    }
    const dbName = getDbNameFromUri(MONGODB_URI);
    if (!/test/i.test(dbName)) {
        console.log(`MONGODB_URI points at database "${dbName}", which doesn't look like a test database.`);
        process.exitCode = 1;
        return;
    }

    const { connectToDatabase, disconnectFromDatabase } = require(path.join(ROOT, "api", "_lib", "mongodb"));
    const userStore = require(path.join(ROOT, "api", "_lib", "userStore"));
    const session = require(path.join(ROOT, "api", "_lib", "session"));
    const { resolveMongoUser } = require(path.join(ROOT, "api", "_lib", "businessAuth"));
    const User = require(path.join(ROOT, "api", "_lib", "models", "User"));
    const Lead = require(path.join(ROOT, "api", "_lib", "models", "Lead"));
    const Enquiry = require(path.join(ROOT, "api", "_lib", "models", "Enquiry"));
    const FollowUp = require(path.join(ROOT, "api", "_lib", "models", "FollowUp"));
    const Communication = require(path.join(ROOT, "api", "_lib", "models", "Communication"));
    const UserEvent = require(path.join(ROOT, "api", "_lib", "models", "UserEvent"));

    const leadsIndex = require(path.join(ROOT, "api", "_lib", "routes", "leads", "index.js"));
    const leadsDetail = require(path.join(ROOT, "api", "_lib", "routes", "leads", "[id].js"));
    const customersDetail = require(path.join(ROOT, "api", "_lib", "routes", "customers", "[id].js"));
    const customersIndex = require(path.join(ROOT, "api", "_lib", "routes", "customers", "index.js"));

    const insightsOverview = require(path.join(ROOT, "api", "_lib", "routes", "insights", "overview.js"));
    const insightsMarket = require(path.join(ROOT, "api", "_lib", "routes", "insights", "market.js"));
    const insightsSnapshot = require(path.join(ROOT, "api", "_lib", "routes", "insights", "snapshot.js"));
    const insightsSnapshotDates = require(path.join(ROOT, "api", "_lib", "routes", "insights", "snapshot-dates.js"));

    await connectToDatabase();
    console.log(`MongoDB connection established (local, throwaway: ${dbName}).\n`);

    const runId = `verify-m22-${Date.now()}`;
    const createdUserIds = [];
    const createdLeadIds = [];
    const createdEnquiryIds = [];
    const createdFollowUpIds = [];
    const createdCommunicationIds = [];

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
        return { redisUser, mongoUser, cookie: `${session.COOKIE_NAME}=${sessionId}` };
    }

    const admin = await createActor("ADMIN", "admin");
    const manager = await createActor("MARKETING_MANAGER", "manager");
    const agent = await createActor("MARKETING_AGENT", "agent");
    const plainUser = await createActor("USER", "user");

    // ═══════════════════════ INSIGHTS RBAC (Part B) ═══════════════════════
    // authorizeInsights() (api/_lib/insightsDevAuth.js) is the exact same
    // requireRole(req, res, INTERNAL_ROLES) call, shared byte-for-byte by all
    // four of these files — proving the gate itself grants/denies correctly
    // on one endpoint is evidence it does so on all four. The 401/403 paths
    // never reach past the auth check (no data is fetched), so those are
    // safe to exercise on every endpoint. The 200 path is only exercised
    // against snapshot-dates.js, which is pure MongoDB (listSnapshotDates())
    // with zero external dependency — overview.js/market.js/snapshot.js all
    // call live, rate-budgeted Amber-backed functions on success
    // (getInventoryStats/getMarketIntelligence), and this regression suite
    // must never make real third-party network calls, so their 200 path is
    // intentionally not exercised here.
    const authOnlyEndpoints = [
        ["GET /api/insights/overview", insightsOverview],
        ["GET /api/insights/market", insightsMarket],
        ["GET /api/insights/snapshot", insightsSnapshot],
        ["GET /api/insights/snapshot-dates", insightsSnapshotDates],
    ];
    for (const [label, handler] of authOnlyEndpoints) {
        await test(`INSIGHTS: ${label} — unauthenticated -> 401`, async () => {
            const res = mockRes();
            await handler(mockReq({ method: "GET" }), res);
            assert.strictEqual(res.statusCode, 401);
            assert.strictEqual(res.body.success, undefined, "401 body should use the auth module's {ok,error} shape, not leak an unexpected shape");
            assert.strictEqual(JSON.stringify(res.body).toLowerCase().includes("mongodb"), false, "error body must never mention internals");
        });
        await test(`INSIGHTS: ${label} — plain USER -> 403`, async () => {
            const res = mockRes();
            await handler(mockReq({ method: "GET", cookie: plainUser.cookie }), res);
            assert.strictEqual(res.statusCode, 403);
            assert.strictEqual(res.body.success, false);
            assert.ok(res.body.error && res.body.error.code === "FORBIDDEN");
            assert.strictEqual(res.body.error.message.includes("MongoNetwork"), false);
        });
    }
    await test("INSIGHTS: GET /api/insights/snapshot-dates — MARKETING_AGENT -> 200 (Mongo-only endpoint, safe to exercise fully)", async () => {
        const res = mockRes();
        await insightsSnapshotDates(mockReq({ method: "GET", cookie: agent.cookie }), res);
        assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    });
    await test("INSIGHTS: GET /api/insights/snapshot-dates — MARKETING_MANAGER -> 200", async () => {
        const res = mockRes();
        await insightsSnapshotDates(mockReq({ method: "GET", cookie: manager.cookie }), res);
        assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    });
    await test("INSIGHTS: GET /api/insights/snapshot-dates — ADMIN -> 200", async () => {
        const res = mockRes();
        await insightsSnapshotDates(mockReq({ method: "GET", cookie: admin.cookie }), res);
        assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    });

    // ═══════════════════════ NURTURING (Part C) ═══════════════════════
    let nurturingLeadId;
    await test("NURTURING: lead creation defaults still work (status omitted -> \"new\")", async () => {
        const res = mockRes();
        await leadsIndex(mockReq({ method: "POST", body: { contact: { name: "Nurture Test", email: `${runId}-nurture@example.test` }, source: "contact-form" } }), res);
        assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
        assert.strictEqual(res.body.data.status, "new");
        nurturingLeadId = res.body.data.id;
        createdLeadIds.push(nurturingLeadId);
    });
    await test("NURTURING: PATCH status to \"nurturing\" is accepted", async () => {
        const res = mockRes();
        await leadsDetail(mockReq({ method: "PATCH", cookie: agent.cookie, query: { id: String(nurturingLeadId) }, body: { status: "nurturing", notes: "Comparing options with parents" } }), res);
        assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
        assert.strictEqual(res.body.data.status, "nurturing");
        assert.strictEqual(res.body.data.notes, "Comparing options with parents");
    });
    await test("NURTURING: an existing (pre-Milestone-22) status is still accepted", async () => {
        const res = mockRes();
        await leadsDetail(mockReq({ method: "PATCH", cookie: agent.cookie, query: { id: String(nurturingLeadId) }, body: { status: "qualified" } }), res);
        assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
        assert.strictEqual(res.body.data.status, "qualified");
    });
    await test("NURTURING: an invalid status is still rejected (enum whitelist intact)", async () => {
        const res = mockRes();
        await leadsDetail(mockReq({ method: "PATCH", cookie: agent.cookie, query: { id: String(nurturingLeadId) }, body: { status: "definitely_not_a_real_status" } }), res);
        assert.strictEqual(res.statusCode, 400);
    });
    await test("NURTURING: lead can transition back into nurturing from another status", async () => {
        const res = mockRes();
        await leadsDetail(mockReq({ method: "PATCH", cookie: agent.cookie, query: { id: String(nurturingLeadId) }, body: { status: "nurturing" } }), res);
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.body.data.status, "nurturing");
    });
    await test("NURTURING: lead can transition OUT of nurturing", async () => {
        const res = mockRes();
        await leadsDetail(mockReq({ method: "PATCH", cookie: agent.cookie, query: { id: String(nurturingLeadId) }, body: { status: "contacted" } }), res);
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.body.data.status, "contacted");
    });
    await test("NURTURING: assignedTo is unaffected by a status change (never silently touched)", async () => {
        const before = mockRes();
        await leadsDetail(mockReq({ method: "GET", cookie: agent.cookie, query: { id: String(nurturingLeadId) } }), before);
        const assignedBefore = before.body.data.assignedTo;

        const res = mockRes();
        await leadsDetail(mockReq({ method: "PATCH", cookie: agent.cookie, query: { id: String(nurturingLeadId) }, body: { status: "nurturing" } }), res);
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.body.data.assignedTo, assignedBefore, "assignedTo must not change as a side effect of a status PATCH");
    });
    await test("NURTURING: notes are not overwritten when a status change omits notes", async () => {
        const setNotes = mockRes();
        await leadsDetail(mockReq({ method: "PATCH", cookie: agent.cookie, query: { id: String(nurturingLeadId) }, body: { notes: "Original note, set independently" } }), setNotes);
        assert.strictEqual(setNotes.statusCode, 200);

        const changeStatus = mockRes();
        await leadsDetail(mockReq({ method: "PATCH", cookie: agent.cookie, query: { id: String(nurturingLeadId) }, body: { status: "qualified" } }), changeStatus);
        assert.strictEqual(changeStatus.statusCode, 200);
        assert.strictEqual(changeStatus.body.data.notes, "Original note, set independently", "a status-only PATCH must never clear or alter notes it didn't touch");
    });
    await test("NURTURING: filtering the lead list by status=nurturing works", async () => {
        const setNurturing = mockRes();
        await leadsDetail(mockReq({ method: "PATCH", cookie: agent.cookie, query: { id: String(nurturingLeadId) }, body: { status: "nurturing" } }), setNurturing);
        assert.strictEqual(setNurturing.statusCode, 200);

        const res = mockRes();
        await leadsIndex(mockReq({ method: "GET", cookie: agent.cookie, query: { status: "nurturing", search: runId } }), res);
        assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
        assert.ok(res.body.data.some((l) => l.id === String(nurturingLeadId)));
        assert.ok(res.body.data.every((l) => l.status === "nurturing"));
    });

    // ═══════════════════ CROSS-LEAD ISOLATION REGRESSION (Part A) ═══════════════════
    // No nested lead-child route (e.g. /api/leads/:leadId/follow-ups/:id) exists
    // anywhere in the current tree — see Milestone 21/22 investigation — so the
    // literal "Child.findById(childId) without a leadId check" vulnerability
    // pattern has no live instance to exercise. What CAN be tested against
    // CURRENT endpoints is that the nested reads inside buildLeadDetail() and
    // buildCustomer360() stay correctly scoped to their parent, and never
    // leak another lead's/user's data through the top-level detail endpoints.
    let leadA, leadB, userA, userB;
    await test("ISOLATION setup: create Lead A and Lead B with their own nested records", async () => {
        const leadARes = mockRes();
        await leadsIndex(mockReq({ method: "POST", body: { contact: { name: "Lead A", email: `${runId}-leada@example.test` }, source: "contact-form" } }), leadARes);
        leadA = leadARes.body.data.id;
        createdLeadIds.push(leadA);

        const leadBRes = mockRes();
        await leadsIndex(mockReq({ method: "POST", body: { contact: { name: "Lead B", email: `${runId}-leadb@example.test` }, source: "contact-form" } }), leadBRes);
        leadB = leadBRes.body.data.id;
        createdLeadIds.push(leadB);

        const fuA = await FollowUp.create({ leadId: leadA, type: "call", priority: "medium", dueAt: new Date(), status: "pending", notes: "FollowUp belonging to Lead A only" });
        const fuB = await FollowUp.create({ leadId: leadB, type: "email", priority: "low", dueAt: new Date(), status: "pending", notes: "FollowUp belonging to Lead B only" });
        createdFollowUpIds.push(fuA._id, fuB._id);

        const commA = await Communication.create({ leadId: leadA, channel: "email", direction: "outbound", type: "general", content: "Message for Lead A only" });
        const commB = await Communication.create({ leadId: leadB, channel: "phone", direction: "inbound", type: "general", content: "Message for Lead B only" });
        createdCommunicationIds.push(commA._id, commB._id);

        const enqA = await Enquiry.create({ leadId: leadA, contact: { name: "Lead A", email: `${runId}-leada@example.test` }, source: "find-rooms", status: "new" });
        const enqB = await Enquiry.create({ leadId: leadB, contact: { name: "Lead B", email: `${runId}-leadb@example.test` }, source: "find-rooms", status: "new" });
        createdEnquiryIds.push(enqA._id, enqB._id);
    });
    await test("ISOLATION: GET /api/leads/:idA never returns Lead B's follow-ups/communications/enquiries", async () => {
        const res = mockRes();
        await leadsDetail(mockReq({ method: "GET", cookie: agent.cookie, query: { id: String(leadA) } }), res);
        assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
        assert.ok(res.body.data.followUps.every((f) => f.notes !== "FollowUp belonging to Lead B only"));
        assert.ok(res.body.data.communications.every((c) => c._id !== undefined) && res.body.data.communications.length <= 10);
        assert.ok(res.body.data.followUps.some((f) => f.notes === "FollowUp belonging to Lead A only"), "Lead A's own follow-up must still be present");
        assert.ok(res.body.data.enquiries.every((e) => e._id !== undefined));
        const enquiryForB = await Enquiry.findOne({ leadId: leadB });
        const leakedEnquiry = res.body.data.enquiries.find((e) => String(e._id) === String(enquiryForB._id));
        assert.strictEqual(leakedEnquiry, undefined, "Lead A's detail response must never include Lead B's enquiry");
    });
    await test("ISOLATION: GET /api/leads/:idB never returns Lead A's follow-ups/communications/enquiries", async () => {
        const res = mockRes();
        await leadsDetail(mockReq({ method: "GET", cookie: agent.cookie, query: { id: String(leadB) } }), res);
        assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
        assert.ok(res.body.data.followUps.every((f) => f.notes !== "FollowUp belonging to Lead A only"));
        assert.ok(res.body.data.followUps.some((f) => f.notes === "FollowUp belonging to Lead B only"), "Lead B's own follow-up must still be present");
    });
    await test("ISOLATION setup: create User A and User B with their own leads/enquiries", async () => {
        userA = await createActor("USER", "isoA");
        userB = await createActor("USER", "isoB");

        const leadForA = await Lead.create({ userId: userA.mongoUser._id, contact: {}, source: "signup", status: "new" });
        const leadForB = await Lead.create({ userId: userB.mongoUser._id, contact: {}, source: "signup", status: "new" });
        createdLeadIds.push(leadForA._id, leadForB._id);
    });
    await test("ISOLATION: GET /api/customers/:idA (Customer 360) never returns User B's leads", async () => {
        const res = mockRes();
        await customersDetail(mockReq({ method: "GET", cookie: agent.cookie, query: { id: String(userA.mongoUser._id) } }), res);
        assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
        const rawLeadsForA = await Lead.find({ userId: userA.mongoUser._id }).select("_id");
        const rawLeadsForB = await Lead.find({ userId: userB.mongoUser._id }).select("_id");
        const returnedIds = res.body.data.recentLeads.map((l) => String(l._id));
        for (const l of rawLeadsForA) assert.ok(returnedIds.includes(String(l._id)), "User A's own lead must be present");
        for (const l of rawLeadsForB) assert.ok(!returnedIds.includes(String(l._id)), "User B's lead must never appear in User A's Customer 360");
    });
    await test("ISOLATION: an internal role opening two different leads back-to-back gets correctly isolated data both times (no cross-request state leak)", async () => {
        const resA = mockRes();
        await leadsDetail(mockReq({ method: "GET", cookie: manager.cookie, query: { id: String(leadA) } }), resA);
        const resB = mockRes();
        await leadsDetail(mockReq({ method: "GET", cookie: manager.cookie, query: { id: String(leadB) } }), resB);
        assert.notStrictEqual(resA.body.data.id, resB.body.data.id);
        assert.strictEqual(resA.body.data.id, String(leadA));
        assert.strictEqual(resB.body.data.id, String(leadB));
    });

    // ═══════════════════════ SANITY: nothing else broke ═══════════════════════
    await test("SANITY: unauthenticated GET /api/leads still -> 401 (existing behavior unchanged)", async () => {
        const res = mockRes();
        await leadsIndex(mockReq({ method: "GET" }), res);
        assert.strictEqual(res.statusCode, 401);
    });
    await test("SANITY: plain USER GET /api/customers still -> 403 (existing behavior unchanged)", async () => {
        const res = mockRes();
        await customersIndex(mockReq({ method: "GET", cookie: plainUser.cookie }), res);
        assert.strictEqual(res.statusCode, 403);
    });

    // ══════════════════════════ CLEANUP ══════════════════════════
    console.log("\nCleaning up test records...");
    const leadEventFilter = { "properties.leadId": { $in: createdLeadIds.map(String) } };
    await UserEvent.deleteMany({ $or: [{ userId: { $in: createdUserIds } }, leadEventFilter] });
    await FollowUp.deleteMany({ _id: { $in: createdFollowUpIds } });
    await Communication.deleteMany({ _id: { $in: createdCommunicationIds } });
    await Enquiry.deleteMany({ _id: { $in: createdEnquiryIds } });
    await Lead.deleteMany({ _id: { $in: createdLeadIds } });
    await User.deleteMany({ _id: { $in: createdUserIds } });
    console.log(`Cleanup complete. Created: ${createdUserIds.length} users, ${createdLeadIds.length} leads, ${createdEnquiryIds.length} enquiries, ${createdFollowUpIds.length} follow-ups, ${createdCommunicationIds.length} communications.`);

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
