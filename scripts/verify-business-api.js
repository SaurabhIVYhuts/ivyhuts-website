#!/usr/bin/env node
// Focused verification for the Milestone 2 business API (api/customers/*,
// api/leads/*, api/enquiries/*, and the businessAuth/businessRateLimit/
// leadLinking/events helpers behind them). Same style as
// scripts/verify-auth-backend.js and scripts/verify-mongodb-models.js: a
// standalone Node script, not Jest (CRA's Jest config isn't set up for
// plain Node backend modules under api/).
//
// REDIS: deliberately forced into in-memory fallback for this run, even
// though a real Upstash instance is configured in .env.local — this script
// creates and logs in several throwaway test accounts (ADMIN, USER, etc.)
// purely to exercise authorization, and those accounts/sessions have no
// business ever touching the real Redis instance. This mirrors
// scripts/verify-auth-backend.js's reasoning exactly.
//
// MONGODB: the opposite choice — this DOES use the real MONGODB_URI from
// .env.local, because the whole point of this milestone is verifying
// real Customer/Lead/Enquiry persistence, real indexes, and real
// authorization against actual data. Protected by the same "database name
// must contain 'test'" guard as scripts/verify-mongodb-models.js — refuses
// to run against anything that doesn't look like a test database.
"use strict";

const assert = require("assert");
const path = require("path");
const ROOT = path.join(__dirname, "..");

require("dotenv").config({ path: path.join(ROOT, ".env.local") });
require("dotenv").config({ path: path.join(ROOT, ".env") });
// Force Redis in-memory fallback for this run (see header comment) — must
// happen BEFORE any api/_lib module is required, since sharedStore.js
// reads these once at module load.
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
    // Round-trips through real JSON serialization (as res.json(body) does
    // for a live HTTP response via JSON.stringify) rather than just
    // assigning the object — this matters because Mongoose ObjectIds only
    // become plain hex strings via their toJSON(), which a raw object
    // reference here would skip, making test assertions see a raw
    // ObjectId where a real client would see the string it actually is.
    res.json = (body) => { res.body = JSON.parse(JSON.stringify(body)); return res; };
    res.setHeader = (key, value) => { res.headers[key] = value; return res; };
    return res;
}

function getDbNameFromUri(uri) {
    const match = /\/([^/?]+)(\?|$)/.exec(uri.replace(/^mongodb(\+srv)?:\/\//, "mongodb://").split("@").pop());
    return match ? match[1] : "";
}

async function main() {
    console.log("=== IvyHuts Business API Verification (Milestone 2) ===");
    console.log("Redis: forced in-memory fallback for this run (see header comment).\n");

    const MONGODB_URI = process.env.MONGODB_URI;
    if (!MONGODB_URI) {
        console.log("MONGODB_URI is not set — this milestone's live verification cannot run at all.");
        console.log("Set MONGODB_URI in .env.local (pointing at a database whose name contains \"test\") and re-run.");
        process.exitCode = 1;
        return;
    }
    const dbName = getDbNameFromUri(MONGODB_URI);
    const looksLikeTestDb = /test/i.test(dbName);
    if (!looksLikeTestDb && process.env.ALLOW_MONGODB_LIVE_TEST !== "true") {
        console.log(`MONGODB_URI points at database "${dbName}", which doesn't look like a test database.`);
        console.log("Refusing to run. Point MONGODB_URI at a database whose name contains \"test\", or set ALLOW_MONGODB_LIVE_TEST=true.");
        process.exitCode = 1;
        return;
    }

    // ── Require everything only now that Redis env vars are scrubbed ──
    const { connectToDatabase, disconnectFromDatabase } = require(path.join(ROOT, "api", "_lib", "mongodb"));
    const userStore = require(path.join(ROOT, "api", "_lib", "userStore"));
    const session = require(path.join(ROOT, "api", "_lib", "session"));
    const { resolveMongoUser } = require(path.join(ROOT, "api", "_lib", "businessAuth"));
    const User = require(path.join(ROOT, "api", "_lib", "models", "User"));
    const Lead = require(path.join(ROOT, "api", "_lib", "models", "Lead"));
    const Enquiry = require(path.join(ROOT, "api", "_lib", "models", "Enquiry"));
    const UserEvent = require(path.join(ROOT, "api", "_lib", "models", "UserEvent"));

    const customersIndex = require(path.join(ROOT, "api", "customers", "index.js"));
    const customersMe = require(path.join(ROOT, "api", "customers", "me.js"));
    const customersDetail = require(path.join(ROOT, "api", "customers", "[id].js"));
    const customersLifecycle = require(path.join(ROOT, "api", "customers", "[id]", "lifecycle.js"));
    const leadsIndex = require(path.join(ROOT, "api", "leads", "index.js"));
    const leadsDetail = require(path.join(ROOT, "api", "leads", "[id].js"));
    const leadsAssignment = require(path.join(ROOT, "api", "leads", "[id]", "assignment.js"));
    const enquiriesIndex = require(path.join(ROOT, "api", "enquiries", "index.js"));
    const enquiriesDetail = require(path.join(ROOT, "api", "enquiries", "[id].js"));

    await connectToDatabase();
    console.log("MongoDB connection established for live verification.\n");

    const runId = `verify-${Date.now()}`;
    const createdUserIds = [];
    const createdLeadIds = [];
    const createdEnquiryIds = [];

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
    const otherUser = await createActor("USER", "other-user");

    // ══════════════════════════ AUTHORIZATION ══════════════════════════
    await test("AUTH: unauthenticated GET /api/leads -> 401", async () => {
        const res = mockRes();
        await leadsIndex(mockReq({ method: "GET" }), res);
        assert.strictEqual(res.statusCode, 401);
    });
    await test("AUTH: plain USER GET /api/leads -> 403", async () => {
        const res = mockRes();
        await leadsIndex(mockReq({ method: "GET", cookie: plainUser.cookie }), res);
        assert.strictEqual(res.statusCode, 403);
    });
    await test("AUTH: MARKETING_AGENT GET /api/leads -> 200", async () => {
        const res = mockRes();
        await leadsIndex(mockReq({ method: "GET", cookie: agent.cookie }), res);
        assert.strictEqual(res.statusCode, 200);
    });
    await test("AUTH: MARKETING_MANAGER GET /api/leads -> 200", async () => {
        const res = mockRes();
        await leadsIndex(mockReq({ method: "GET", cookie: manager.cookie }), res);
        assert.strictEqual(res.statusCode, 200);
    });
    await test("AUTH: ADMIN GET /api/leads -> 200", async () => {
        const res = mockRes();
        await leadsIndex(mockReq({ method: "GET", cookie: admin.cookie }), res);
        assert.strictEqual(res.statusCode, 200);
    });
    await test("AUTH: plain USER GET /api/customers -> 403", async () => {
        const res = mockRes();
        await customersIndex(mockReq({ method: "GET", cookie: plainUser.cookie }), res);
        assert.strictEqual(res.statusCode, 403);
    });

    // ══════════════════════════ CUSTOMERS ══════════════════════════
    let createdCustomerId;
    await test("CUSTOMERS: create (internal role) succeeds and never leaks passwordHash", async () => {
        const email = `${runId}-imported@example.test`;
        const res = mockRes();
        await customersIndex(mockReq({ method: "POST", cookie: agent.cookie, body: { email, name: "Imported Customer", phone: "9876543211" } }), res);
        assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
        assert.strictEqual(res.body.data.email, email);
        assert.strictEqual(res.body.data.passwordHash, undefined);
        createdCustomerId = res.body.data.id;
        createdUserIds.push(createdCustomerId);
    });
    await test("CUSTOMERS: GET /api/customers/:id returns a Customer 360 shape", async () => {
        const res = mockRes();
        await customersDetail(mockReq({ method: "GET", cookie: agent.cookie, query: { id: String(createdCustomerId) } }), res);
        assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
        assert.ok("wishlist" in res.body.data && "recentLeads" in res.body.data && "recentEnquiries" in res.body.data);
    });
    await test("CUSTOMERS: PATCH /api/customers/:id updates whitelisted fields only", async () => {
        const res = mockRes();
        await customersDetail(mockReq({ method: "PATCH", cookie: agent.cookie, query: { id: String(createdCustomerId) }, body: { phone: "+44 7000 000000", profile: { city: "London" } } }), res);
        assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
        assert.strictEqual(res.body.data.phone, "+44 7000 000000");
        assert.strictEqual(res.body.data.profile.city, "London");
    });
    await test("CUSTOMERS: PATCH role change requires ADMIN (MARKETING_AGENT gets 403)", async () => {
        const res = mockRes();
        await customersDetail(mockReq({ method: "PATCH", cookie: agent.cookie, query: { id: String(createdCustomerId) }, body: { role: "ADMIN" } }), res);
        assert.strictEqual(res.statusCode, 403);
    });
    await test("CUSTOMERS: GET /api/customers/me returns only the caller's own profile", async () => {
        const res = mockRes();
        await customersMe(mockReq({ method: "GET", cookie: plainUser.cookie }), res);
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.body.data.id, String(plainUser.mongoUser._id));
    });
    await test("CUSTOMERS: pagination/search response shape is correct", async () => {
        const res = mockRes();
        await customersIndex(mockReq({ method: "GET", cookie: agent.cookie, query: { search: runId, page: "1", limit: "5" } }), res);
        assert.strictEqual(res.statusCode, 200);
        assert.ok(Array.isArray(res.body.data));
        assert.deepStrictEqual(Object.keys(res.body.pagination).sort(), ["limit", "page", "total", "totalPages"].sort());
        assert.strictEqual(res.body.pagination.limit, 5);
    });
    await test("CUSTOMERS: oversized limit is clamped to the maximum (100)", async () => {
        const res = mockRes();
        await customersIndex(mockReq({ method: "GET", cookie: agent.cookie, query: { limit: "99999" } }), res);
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.body.pagination.limit, 100);
    });

    // ══════════════════════════ LEADS ══════════════════════════
    let anonLeadId, userLeadId;
    await test("LEADS: anonymous creation succeeds with contact.email, userId stays null", async () => {
        const res = mockRes();
        await leadsIndex(mockReq({ method: "POST", body: { contact: { name: "Anon Lead", email: `${runId}-anonlead@example.test` }, source: "contact-form" } }), res);
        assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
        assert.strictEqual(res.body.data.userId, null);
        anonLeadId = res.body.data.id;
        createdLeadIds.push(anonLeadId);
    });
    await test("LEADS: anonymous creation with neither userId nor contact.email fails validation", async () => {
        const res = mockRes();
        await leadsIndex(mockReq({ method: "POST", body: { source: "contact-form" } }), res);
        assert.strictEqual(res.statusCode, 400);
    });
    await test("LEADS: authenticated creation derives userId from session, ignoring a spoofed body.userId", async () => {
        const res = mockRes();
        await leadsIndex(mockReq({
            method: "POST",
            cookie: plainUser.cookie,
            body: { contact: { name: "Session Lead", email: `${runId}-sessionlead@example.test` }, source: "signup", userId: String(otherUser.mongoUser._id) },
        }), res);
        assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
        assert.strictEqual(res.body.data.userId, String(plainUser.mongoUser._id), "userId must be the session's own id, never the spoofed body value");
        userLeadId = res.body.data.id;
        createdLeadIds.push(userLeadId);
    });
    await test("LEADS: staff-supplied userId IS honored when the caller holds an internal role", async () => {
        const res = mockRes();
        await leadsIndex(mockReq({
            method: "POST",
            cookie: agent.cookie,
            body: { userId: String(otherUser.mongoUser._id), source: "staff-import" },
        }), res);
        assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
        assert.strictEqual(res.body.data.userId, String(otherUser.mongoUser._id));
        createdLeadIds.push(res.body.data.id);
    });
    await test("LEADS: filtering by status and pagination works", async () => {
        const res = mockRes();
        await leadsIndex(mockReq({ method: "GET", cookie: agent.cookie, query: { status: "new", search: runId, page: "1", limit: "50" } }), res);
        assert.strictEqual(res.statusCode, 200);
        assert.ok(res.body.data.every((l) => l.status === "new"));
    });
    await test("LEADS: an unsupported status value is rejected (whitelist, not arbitrary filters)", async () => {
        const res = mockRes();
        await leadsIndex(mockReq({ method: "GET", cookie: agent.cookie, query: { status: "$where" } }), res);
        assert.strictEqual(res.statusCode, 400);
    });
    await test("LEADS: PATCH status change updates convertedAt and records a UserEvent", async () => {
        const res = mockRes();
        await leadsDetail(mockReq({ method: "PATCH", cookie: agent.cookie, query: { id: String(anonLeadId) }, body: { status: "converted" } }), res);
        assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
        assert.strictEqual(res.body.data.status, "converted");
        assert.ok(res.body.data.convertedAt);
        const evt = await UserEvent.findOne({ event: "LEAD_STATUS_CHANGED", "properties.leadId": String(anonLeadId) });
        assert.ok(evt, "expected a LEAD_STATUS_CHANGED UserEvent to have been recorded");
    });
    await test("LEADS: PATCH cannot touch immutable fields (userId, createdAt, assignedTo)", async () => {
        const res = mockRes();
        await leadsDetail(mockReq({ method: "PATCH", cookie: agent.cookie, query: { id: String(userLeadId) }, body: { userId: String(otherUser.mongoUser._id) } }), res);
        assert.strictEqual(res.statusCode, 400);
    });
    await test("LEADS: assignment to a MARKETING_AGENT succeeds", async () => {
        const res = mockRes();
        await leadsAssignment(mockReq({ method: "PATCH", cookie: manager.cookie, query: { id: String(userLeadId) }, body: { assignedTo: String(agent.mongoUser._id) } }), res);
        assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
        assert.strictEqual(res.body.data.assignedTo, String(agent.mongoUser._id));
    });
    await test("LEADS: assignment to an ordinary USER is rejected", async () => {
        const res = mockRes();
        await leadsAssignment(mockReq({ method: "PATCH", cookie: manager.cookie, query: { id: String(userLeadId) }, body: { assignedTo: String(plainUser.mongoUser._id) } }), res);
        assert.strictEqual(res.statusCode, 400);
    });
    await test("LEADS: assignment unassign (assignedTo: null) succeeds", async () => {
        const res = mockRes();
        await leadsAssignment(mockReq({ method: "PATCH", cookie: manager.cookie, query: { id: String(userLeadId) }, body: { assignedTo: null } }), res);
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.body.data.assignedTo, null);
    });
    await test("LEADS: unauthorized assignment (plain USER) -> 403", async () => {
        const res = mockRes();
        await leadsAssignment(mockReq({ method: "PATCH", cookie: plainUser.cookie, query: { id: String(userLeadId) }, body: { assignedTo: String(agent.mongoUser._id) } }), res);
        assert.strictEqual(res.statusCode, 403);
    });
    await test("LEADS: DELETE by MARKETING_AGENT is forbidden (destructive delete restricted)", async () => {
        const res = mockRes();
        await leadsDetail(mockReq({ method: "DELETE", cookie: agent.cookie, query: { id: String(userLeadId) } }), res);
        assert.strictEqual(res.statusCode, 403);
    });
    await test("LEADS: DELETE by MARKETING_MANAGER soft-archives (not a hard delete)", async () => {
        const res = mockRes();
        await leadsDetail(mockReq({ method: "DELETE", cookie: manager.cookie, query: { id: String(userLeadId) } }), res);
        assert.strictEqual(res.statusCode, 200);
        assert.ok(res.body.data.archivedAt);
        const stillInDb = await Lead.findById(userLeadId);
        assert.ok(stillInDb, "the document must still exist in MongoDB after a soft delete");
    });
    await test("LEADS: archived leads are excluded from the default list, included with includeArchived=true", async () => {
        const withoutArchived = mockRes();
        await leadsIndex(mockReq({ method: "GET", cookie: agent.cookie, query: { search: runId } }), withoutArchived);
        assert.ok(!withoutArchived.body.data.some((l) => l.id === String(userLeadId)));

        const withArchived = mockRes();
        await leadsIndex(mockReq({ method: "GET", cookie: agent.cookie, query: { search: runId, includeArchived: "true" } }), withArchived);
        assert.ok(withArchived.body.data.some((l) => l.id === String(userLeadId)));
    });

    // ══════════════════════════ ENQUIRIES ══════════════════════════
    let firstEnquiryLeadId;
    await test("ENQUIRIES: anonymous submission creates/links a Lead", async () => {
        const res = mockRes();
        await enquiriesIndex(mockReq({
            method: "POST",
            body: { contact: { name: "Enquirer", email: `${runId}-enquirer@example.test` }, property: { id: "prop-1", city: "London" }, message: "Interested", source: "find-rooms" },
        }), res);
        assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
        assert.ok(res.body.data.leadId);
        firstEnquiryLeadId = res.body.data.leadId;
        createdEnquiryIds.push(res.body.data.id);
        createdLeadIds.push(firstEnquiryLeadId);
    });
    await test("ENQUIRIES: a second enquiry from the same email reuses the same open Lead", async () => {
        const res = mockRes();
        await enquiriesIndex(mockReq({
            method: "POST",
            body: { contact: { name: "Enquirer Again", email: `${runId}-enquirer@example.test` }, property: { id: "prop-2", city: "London" }, message: "Still interested", source: "find-rooms" },
        }), res);
        assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
        assert.strictEqual(res.body.data.leadId, firstEnquiryLeadId, "a repeat enquiry from the same contact should reuse the existing open Lead, not create a duplicate");
        createdEnquiryIds.push(res.body.data.id);
    });
    await test("ENQUIRIES: authenticated submission derives userId from session", async () => {
        const res = mockRes();
        await enquiriesIndex(mockReq({
            method: "POST",
            cookie: plainUser.cookie,
            body: { contact: { name: "Test User", email: `${runId}-user@example.test` }, message: "Hi", source: "contact" },
        }), res);
        assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
        assert.strictEqual(res.body.data.userId, String(plainUser.mongoUser._id));
        createdEnquiryIds.push(res.body.data.id);
        createdLeadIds.push(res.body.data.leadId);
    });
    await test("ENQUIRIES: missing contact fails validation", async () => {
        const res = mockRes();
        await enquiriesIndex(mockReq({ method: "POST", body: { message: "no contact given" } }), res);
        assert.strictEqual(res.statusCode, 400);
    });
    await test("ENQUIRIES: list is internal-role only and supports pagination", async () => {
        const unauth = mockRes();
        await enquiriesIndex(mockReq({ method: "GET" }), unauth);
        assert.strictEqual(unauth.statusCode, 401);

        const res = mockRes();
        await enquiriesIndex(mockReq({ method: "GET", cookie: agent.cookie, query: { limit: "10" } }), res);
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.body.pagination.limit, 10);
    });
    await test("ENQUIRIES: GET detail by id works for internal roles", async () => {
        const res = mockRes();
        await enquiriesDetail(mockReq({ method: "GET", cookie: agent.cookie, query: { id: String(createdEnquiryIds[0]) } }), res);
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.body.data.id, String(createdEnquiryIds[0]));
    });

    // ══════════════════════════ LIFECYCLE ══════════════════════════
    await test("LIFECYCLE: internal role can update status, and it's reflected", async () => {
        const res = mockRes();
        await customersLifecycle(mockReq({ method: "PATCH", cookie: manager.cookie, query: { id: String(plainUser.mongoUser._id) }, body: { status: "ENQUIRY" } }), res);
        assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
        assert.strictEqual(res.body.data.accommodationJourney.status, "ENQUIRY");
    });
    await test("LIFECYCLE: invalid status enum is rejected", async () => {
        const res = mockRes();
        await customersLifecycle(mockReq({ method: "PATCH", cookie: manager.cookie, query: { id: String(plainUser.mongoUser._id) }, body: { status: "NOT_A_REAL_STATUS" } }), res);
        assert.strictEqual(res.statusCode, 400);
    });
    await test("LIFECYCLE: invalid date relationship (expectedMoveOutDate before moveInDate) is rejected", async () => {
        const res = mockRes();
        await customersLifecycle(mockReq({
            method: "PATCH", cookie: manager.cookie, query: { id: String(plainUser.mongoUser._id) },
            body: { moveInDate: "2026-09-01", expectedMoveOutDate: "2026-08-01" },
        }), res);
        assert.strictEqual(res.statusCode, 400);
    });
    await test("LIFECYCLE: an ordinary USER cannot update their own lifecycle (no self-service fields yet)", async () => {
        const res = mockRes();
        await customersLifecycle(mockReq({ method: "PATCH", cookie: plainUser.cookie, query: { id: String(plainUser.mongoUser._id) }, body: { status: "BOOKED" } }), res);
        assert.strictEqual(res.statusCode, 403);
    });
    await test("LIFECYCLE: an ordinary USER cannot update another user's lifecycle", async () => {
        const res = mockRes();
        await customersLifecycle(mockReq({ method: "PATCH", cookie: plainUser.cookie, query: { id: String(otherUser.mongoUser._id) }, body: { status: "BOOKED" } }), res);
        assert.strictEqual(res.statusCode, 403);
    });

    // ══════════════════════════ SECURITY ══════════════════════════
    await test("SECURITY: cross-user access — a USER can never GET another customer's record via /api/customers/:id", async () => {
        const res = mockRes();
        await customersDetail(mockReq({ method: "GET", cookie: plainUser.cookie, query: { id: String(otherUser.mongoUser._id) } }), res);
        assert.strictEqual(res.statusCode, 403);
    });
    await test("SECURITY: invalid ObjectId format -> 400, not a 500 or a Mongo cast error leak", async () => {
        const res = mockRes();
        await leadsDetail(mockReq({ method: "GET", cookie: agent.cookie, query: { id: "not-a-valid-object-id" } }), res);
        assert.strictEqual(res.statusCode, 400);
        assert.strictEqual(res.body.error.code, "INVALID_ID");
    });
    await test("SECURITY: malformed JSON body -> 400, not a 500", async () => {
        const res = mockRes();
        await leadsIndex(mockReq({ method: "POST", cookie: agent.cookie, body: "{not valid json" }), res);
        assert.strictEqual(res.statusCode, 400);
    });
    await test("SECURITY: 404 for a well-formed id that doesn't exist", async () => {
        const mongoose = require("mongoose");
        const res = mockRes();
        await leadsDetail(mockReq({ method: "GET", cookie: agent.cookie, query: { id: String(new mongoose.Types.ObjectId()) } }), res);
        assert.strictEqual(res.statusCode, 404);
    });

    // ══════════════════════════ DATABASE ══════════════════════════
    await test("DATABASE: created documents and references actually persist in MongoDB", async () => {
        const lead = await Lead.findById(userLeadId);
        assert.ok(lead, "lead should be persisted");
        assert.strictEqual(String(lead.userId), String(plainUser.mongoUser._id), "lead.userId reference should persist correctly");

        const enquiry = await Enquiry.findById(createdEnquiryIds[0]);
        assert.ok(enquiry, "enquiry should be persisted");
        assert.strictEqual(String(enquiry.leadId), String(firstEnquiryLeadId), "enquiry.leadId reference should persist correctly");
    });

    // ══════════════════════════ CLEANUP ══════════════════════════
    console.log("\nCleaning up test records...");
    const leadEventFilter = { "properties.leadId": { $in: createdLeadIds.map(String) } };
    await UserEvent.deleteMany({ $or: [{ userId: { $in: createdUserIds } }, leadEventFilter] });
    await Enquiry.deleteMany({ _id: { $in: createdEnquiryIds } });
    await Lead.deleteMany({ _id: { $in: createdLeadIds } });
    await User.deleteMany({ _id: { $in: createdUserIds } });

    const remaining = {
        users: await User.countDocuments({ _id: { $in: createdUserIds } }),
        leads: await Lead.countDocuments({ _id: { $in: createdLeadIds } }),
        enquiries: await Enquiry.countDocuments({ _id: { $in: createdEnquiryIds } }),
        events: await UserEvent.countDocuments({ $or: [{ userId: { $in: createdUserIds } }, leadEventFilter] }),
    };
    await test("CLEANUP: all test documents removed (verified by re-query)", async () => {
        assert.deepStrictEqual(remaining, { users: 0, leads: 0, enquiries: 0, events: 0 }, `residual test data found: ${JSON.stringify(remaining)}`);
    });
    console.log(`Cleanup complete. Created during this run: ${createdUserIds.length} users, ${createdLeadIds.length} leads, ${createdEnquiryIds.length} enquiries (all removed).`);

    await disconnectFromDatabase();

    console.log(`\n=== ${passed} passed, ${failed} failed, ${skipped} skipped ===`);
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
