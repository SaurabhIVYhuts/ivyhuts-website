#!/usr/bin/env node
// Focused verification for Milestone 3 (Production Enquiry Data Capture):
// wiring the demand-side enquiry forms (AccommodationFinderPage, ContactPage)
// into the existing Milestone 2 POST /api/enquiries handler as an ADDITIONAL
// destination alongside the untouched Google Sheets/email flow. Same style
// as scripts/verify-business-api.js: a standalone Node script exercising the
// real handler functions and the real test database, not Jest.
//
// This script does NOT re-test authorization/pagination/CRUD breadth already
// covered by scripts/verify-business-api.js (45/45 passing) — it only
// verifies the specific Milestone 3 behaviors: anonymous capture, session-
// derived identity (never a client-supplied userId), lead reuse on repeat
// enquiries, the ENQUIRY_SUBMITTED event, and that the frontend forms still
// carry their existing Sheets/email code paths untouched.
//
// REDIS: forced into in-memory fallback for this run (mirrors
// verify-business-api.js) — the throwaway test account created here has no
// business touching the real Upstash instance.
//
// MONGODB: uses the real MONGODB_URI from .env.local, guarded by the same
// "database name must contain 'test'" check as the other verify-* scripts.
"use strict";

const assert = require("assert");
const fs = require("fs");
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

// ── Static checks: confirm the frontend still carries its existing
// Sheets/email code paths, and that supply-side forms were NOT wired into
// /api/enquiries. Run before any DB connection, and independent of it — if
// a real Sheets round-trip isn't safe/possible from this script (it would
// require a live Google Apps Script URL and would write real spam rows to
// the production sheet), this is the documented, safe substitute.
function runStaticFrontendChecks() {
    console.log("=== Static frontend checks (Sheets coexistence, supply-side isolation) ===");
    const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

    const checks = [
        {
            name: "STATIC: AccommodationFinderPage still fetches REACT_APP_SHEETS_URL",
            ok: /fetch\(SHEETS_URL/.test(read("src/pages/AccommodationFinderPage.js")),
        },
        {
            name: "STATIC: AccommodationFinderPage now also posts to /api/enquiries",
            ok: /submitEnquiryToMongo/.test(read("src/pages/AccommodationFinderPage.js")) && /\/api\/enquiries/.test(read("src/lib/enquiryApi.js")),
        },
        {
            name: "STATIC: ContactPage still fetches REACT_APP_SHEETS_URL",
            ok: /fetch\(SHEETS_URL/.test(read("src/pages/ContactPage.js")),
        },
        {
            name: "STATIC: ContactPage now also posts to /api/enquiries",
            ok: /submitEnquiryToMongo/.test(read("src/pages/ContactPage.js")),
        },
        {
            name: "STATIC: PartnerPage (supply-side) is NOT wired to /api/enquiries",
            ok: !/submitEnquiryToMongo|\/api\/enquiries/.test(read("src/pages/PartnerPage.js")) && /fetch\(SHEETS_URL/.test(read("src/pages/PartnerPage.js")),
        },
        {
            name: "STATIC: ListYourStayPage (supply-side) is NOT wired to /api/enquiries",
            ok: !/submitEnquiryToMongo|\/api\/enquiries/.test(read("src/pages/ListYourStayPage.js")) && /fetch\(SHEETS_URL/.test(read("src/pages/ListYourStayPage.js")),
        },
        {
            name: "STATIC: api/enquire.js (email flow) is untouched by this milestone's imports",
            ok: read("api/_lib/routes/content/enquire.js").includes('require("../../mailer")') && !/require\(.*(mongodb|models\/Enquiry|models\/Lead)/.test(read("api/_lib/routes/content/enquire.js")),
        },
        {
            name: "STATIC: no REACT_APP_MONGODB_URI / MongoDB credentials anywhere in src/",
            ok: !fs.readdirSync(path.join(ROOT, "src"), { recursive: true })
                .filter((f) => typeof f === "string" && /\.(js|jsx|ts|tsx)$/.test(f))
                .some((f) => /MONGODB_URI/.test(read(path.join("src", f)))),
        },
    ];

    for (const c of checks) {
        if (c.ok) { passed++; console.log(`  PASS  ${c.name}`); }
        else { failed++; failures.push({ name: c.name, message: "static assertion failed" }); console.log(`  FAIL  ${c.name}`); }
    }
    console.log("");
}

async function main() {
    console.log("=== IvyHuts Enquiry Capture Verification (Milestone 3) ===");
    console.log("Redis: forced in-memory fallback for this run.\n");

    runStaticFrontendChecks();

    const MONGODB_URI = process.env.MONGODB_URI;
    if (!MONGODB_URI) {
        console.log("MONGODB_URI is not set — live DB verification cannot run.");
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

    const { connectToDatabase, disconnectFromDatabase } = require(path.join(ROOT, "api", "_lib", "mongodb"));
    const userStore = require(path.join(ROOT, "api", "_lib", "userStore"));
    const session = require(path.join(ROOT, "api", "_lib", "session"));
    const { resolveMongoUser } = require(path.join(ROOT, "api", "_lib", "businessAuth"));
    const User = require(path.join(ROOT, "api", "_lib", "models", "User"));
    const Lead = require(path.join(ROOT, "api", "_lib", "models", "Lead"));
    const Enquiry = require(path.join(ROOT, "api", "_lib", "models", "Enquiry"));
    const UserEvent = require(path.join(ROOT, "api", "_lib", "models", "UserEvent"));
    const enquiriesIndex = require(path.join(ROOT, "api", "_lib", "routes", "enquiries", "index.js"));

    await connectToDatabase();
    console.log("=== Live MongoDB verification ===");
    console.log("MongoDB connection established.\n");

    const runId = `m3-verify-${Date.now()}`;
    const createdUserIds = [];
    const createdLeadIds = [];
    const createdEnquiryIds = [];

    async function createActor(tag) {
        const email = `${runId}-${tag}@example.test`;
        const redisUser = await userStore.createUser({ name: `Test ${tag}`, email, password: "TestPassword123!", phone: "9876543210" });
        const sessionId = await session.createSession(redisUser.id);
        const mongoUser = await resolveMongoUser(redisUser);
        createdUserIds.push(mongoUser._id);
        return { redisUser, mongoUser, cookie: `${session.COOKIE_NAME}=${sessionId}` };
    }

    const loggedInUser = await createActor("student");
    const otherUser = await createActor("other-student");

    // ══════════════════════════ ANONYMOUS ENQUIRY ══════════════════════════
    let anonEmail, anonLeadId, anonEnquiryId;
    await test("ANONYMOUS: POST /api/enquiries (find-rooms shaped payload) -> 201", async () => {
        anonEmail = `${runId}-anon@example.test`;
        const res = mockRes();
        await enquiriesIndex(mockReq({
            method: "POST",
            body: {
                contact: { name: "Anon Student", email: anonEmail, phone: "+44 7000 000001" },
                message: "Countries: UK\nRoom Type: Studio\nBudget: Not sure yet\nIntake: September 2026\nDuration: 1 year",
                source: "find-rooms",
            },
        }), res);
        assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
        anonEnquiryId = res.body.data.id;
        anonLeadId = res.body.data.leadId;
        createdEnquiryIds.push(anonEnquiryId);
        createdLeadIds.push(anonLeadId);
    });
    await test("ANONYMOUS: Enquiry.userId is null for an anonymous submission", async () => {
        const doc = await Enquiry.findById(anonEnquiryId);
        assert.ok(doc, "enquiry should exist in MongoDB");
        assert.strictEqual(doc.userId, null);
    });
    await test("ANONYMOUS: a Lead was created and linked, with userId null and matching contact.email", async () => {
        const lead = await Lead.findById(anonLeadId);
        assert.ok(lead, "lead should exist in MongoDB");
        assert.strictEqual(lead.userId, null);
        assert.strictEqual(lead.contact.email, anonEmail.toLowerCase());
    });

    // ══════════════════════════ REPEAT ENQUIRY / LEAD REUSE ══════════════════════════
    await test("REPEAT: a second anonymous enquiry from the same email reuses the same open Lead", async () => {
        const res = mockRes();
        await enquiriesIndex(mockReq({
            method: "POST",
            body: {
                contact: { name: "Anon Student", email: anonEmail, phone: "+44 7000 000001" },
                message: "Follow-up enquiry",
                source: "find-rooms",
            },
        }), res);
        assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
        assert.strictEqual(res.body.data.leadId, anonLeadId, "repeat enquiry from the same contact must reuse the existing open Lead, not create a duplicate");
        createdEnquiryIds.push(res.body.data.id);
    });
    await test("REPEAT: exactly one Lead document exists for that email (no duplicate created)", async () => {
        const count = await Lead.countDocuments({ "contact.email": anonEmail.toLowerCase() });
        assert.strictEqual(count, 1, `expected exactly 1 Lead for ${anonEmail}, found ${count}`);
    });
    await test("REPEAT: two separate Enquiry documents exist (each real submission is its own record)", async () => {
        const count = await Enquiry.countDocuments({ leadId: anonLeadId });
        assert.strictEqual(count, 2, `expected 2 enquiries tied to leadId ${anonLeadId}, found ${count}`);
    });

    // ══════════════════════════ AUTHENTICATED ENQUIRY ══════════════════════════
    let authEnquiryId, authLeadId;
    await test("AUTHENTICATED: POST /api/enquiries with session cookie -> 201, userId = session user", async () => {
        const res = mockRes();
        await enquiriesIndex(mockReq({
            method: "POST",
            cookie: loggedInUser.cookie,
            body: {
                contact: { name: "Logged In Student", email: `${runId}-loggedin-form-email@example.test`, phone: "+44 7000 000002" },
                message: "Subject: Enquiry about Parkside Studios\n\nIs this still available?",
                source: "contact",
            },
        }), res);
        assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
        assert.strictEqual(res.body.data.userId, String(loggedInUser.mongoUser._id));
        authEnquiryId = res.body.data.id;
        authLeadId = res.body.data.leadId;
        createdEnquiryIds.push(authEnquiryId);
        createdLeadIds.push(authLeadId);
    });
    await test("AUTHENTICATED: Enquiry.userId persisted as the real MongoDB User._id", async () => {
        const doc = await Enquiry.findById(authEnquiryId);
        assert.strictEqual(String(doc.userId), String(loggedInUser.mongoUser._id));
    });

    // ══════════════════════════ CONTACT.EMAIL IS OPTIONAL ══════════════════════════
    // Enquiry.contact.email has no `required` on the schema (api/_lib/models/Enquiry.js)
    // — some forms (ContactPage) only collect name + phone. These tests prove the
    // whole path (validation, Mongo write, lead linking, serialization) tolerates that.
    let noEmailEnquiryId, noEmailLeadId;
    await test("VALID: an enquiry with contact.name + phone but no email succeeds (201), no crash", async () => {
        const res = mockRes();
        await enquiriesIndex(mockReq({
            method: "POST",
            body: { contact: { name: "No Email Person", phone: "9876543210" }, message: "Interested in accommodation", source: "find-rooms" },
        }), res);
        assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
        assert.strictEqual(res.body.data.contact.email, null, "email should serialize as null, never crash or get fabricated");
        assert.strictEqual(res.body.data.contact.name, "No Email Person");
        noEmailEnquiryId = res.body.data.id;
        noEmailLeadId = res.body.data.leadId;
        createdEnquiryIds.push(noEmailEnquiryId);
        createdLeadIds.push(noEmailLeadId);
    });
    await test("LEAD LINKING (no email): a second anonymous no-email enquiry gets its own fresh Lead — no dedupe key available", async () => {
        const res = mockRes();
        await enquiriesIndex(mockReq({
            method: "POST",
            body: { contact: { name: "No Email Person Two", phone: "9876543211" }, message: "Also interested, no email", source: "find-rooms" },
        }), res);
        assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
        assert.notStrictEqual(res.body.data.leadId, noEmailLeadId, "with no userId and no email there is nothing to dedupe on, so a fresh Lead is expected — matches the existing anonymous-enquiry behavior");
        createdEnquiryIds.push(res.body.data.id);
        createdLeadIds.push(res.body.data.leadId);
    });
    await test("LEAD LINKING (no email): an authenticated no-email enquiry still reuses the caller's existing Lead by userId", async () => {
        const res = mockRes();
        await enquiriesIndex(mockReq({
            method: "POST",
            cookie: loggedInUser.cookie,
            body: { contact: { name: "Logged In Student", phone: "9876543212" }, message: "Follow-up, no email this time", source: "contact" },
        }), res);
        assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
        assert.strictEqual(res.body.data.leadId, authLeadId, "userId-based Lead matching must work even when this particular enquiry has no email — email is only the fallback dedupe key for anonymous callers");
        createdEnquiryIds.push(res.body.data.id);
    });
    await test("SERIALIZATION: toSafeEnquiry on a document with no email does not crash and returns a clean shape", async () => {
        const { toSafeEnquiry } = require(path.join(ROOT, "api", "_lib", "enquiryView"));
        const doc = await Enquiry.findById(noEmailEnquiryId);
        const safe = toSafeEnquiry(doc);
        assert.strictEqual(safe.contact.email, null);
        assert.strictEqual(safe.contact.name, "No Email Person");
        assert.ok(safe.id);
    });

    // ══════════════════════════ IDENTITY SPOOFING ══════════════════════════
    await test("SECURITY: a client-supplied body.userId is never trusted (anonymous request)", async () => {
        const res = mockRes();
        await enquiriesIndex(mockReq({
            method: "POST",
            body: {
                userId: String(otherUser.mongoUser._id),
                contact: { name: "Spoofer", email: `${runId}-spoof1@example.test` },
                message: "trying to impersonate another user",
                source: "find-rooms",
            },
        }), res);
        assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
        assert.notStrictEqual(res.body.data.userId, String(otherUser.mongoUser._id), "an anonymous request's spoofed body.userId must never be honored");
        assert.strictEqual(res.body.data.userId, null, "an anonymous request must persist userId: null, not the spoofed value");
        createdEnquiryIds.push(res.body.data.id);
        createdLeadIds.push(res.body.data.leadId);
    });
    await test("SECURITY: a logged-in caller's spoofed body.userId is ignored in favor of their own session identity", async () => {
        const res = mockRes();
        await enquiriesIndex(mockReq({
            method: "POST",
            cookie: loggedInUser.cookie,
            body: {
                userId: String(otherUser.mongoUser._id),
                contact: { name: "Logged In Student", email: `${runId}-spoof2@example.test` },
                message: "trying to impersonate another user while logged in",
                source: "contact",
            },
        }), res);
        assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
        assert.strictEqual(res.body.data.userId, String(loggedInUser.mongoUser._id), "must use the session's own identity, never the spoofed body.userId");
        createdEnquiryIds.push(res.body.data.id);
        createdLeadIds.push(res.body.data.leadId);
    });

    // ══════════════════════════ INVALID INPUT ══════════════════════════
    await test("INVALID: missing contact -> 400, no document inserted", async () => {
        const beforeCount = await Enquiry.countDocuments({});
        const res = mockRes();
        await enquiriesIndex(mockReq({ method: "POST", body: { message: "no contact given", source: "find-rooms" } }), res);
        assert.strictEqual(res.statusCode, 400);
        const afterCount = await Enquiry.countDocuments({});
        assert.strictEqual(afterCount, beforeCount, "a 400 response must not have inserted any Enquiry document");
    });
    await test("INVALID: missing contact.name -> 400, no document inserted (contact.email alone is not enough)", async () => {
        const beforeCount = await Enquiry.countDocuments({});
        const res = mockRes();
        await enquiriesIndex(mockReq({ method: "POST", body: { contact: { email: `${runId}-noname@example.test` }, source: "find-rooms" } }), res);
        assert.strictEqual(res.statusCode, 400);
        const afterCount = await Enquiry.countDocuments({});
        assert.strictEqual(afterCount, beforeCount);
    });
    await test("INVALID: malformed JSON body -> 400, not a 500", async () => {
        const res = mockRes();
        await enquiriesIndex(mockReq({ method: "POST", body: "{not valid json" }), res);
        assert.strictEqual(res.statusCode, 400);
    });

    // ══════════════════════════ EVENT TRACKING ══════════════════════════
    await test("EVENT: a successful anonymous enquiry records ENQUIRY_SUBMITTED with anonymous identity", async () => {
        const evt = await UserEvent.findOne({ event: "ENQUIRY_SUBMITTED", "properties.enquiryId": String(anonEnquiryId) });
        assert.ok(evt, "expected an ENQUIRY_SUBMITTED UserEvent for the anonymous enquiry");
        assert.strictEqual(evt.userId, null);
    });
    await test("EVENT: a successful authenticated enquiry records ENQUIRY_SUBMITTED with userId set", async () => {
        const evt = await UserEvent.findOne({ event: "ENQUIRY_SUBMITTED", "properties.enquiryId": String(authEnquiryId) });
        assert.ok(evt, "expected an ENQUIRY_SUBMITTED UserEvent for the authenticated enquiry");
        assert.strictEqual(String(evt.userId), String(loggedInUser.mongoUser._id));
    });
    await test("EVENT: recorded event never contains password/session data", async () => {
        const evt = await UserEvent.findOne({ event: "ENQUIRY_SUBMITTED", "properties.enquiryId": String(authEnquiryId) });
        const serialized = JSON.stringify(evt.toObject());
        assert.ok(!/passwordHash|sessionId|ivyhuts_session/i.test(serialized), "event document must not leak auth/session data");
    });

    // ══════════════════════════ MONGODB FAILURE STRATEGY (documented) ══════════════════════════
    // A real MongoDB outage cannot be safely induced against a live test
    // database from this script. The failure strategy itself is enforced by
    // code inspection instead (src/lib/enquiryApi.js): the POST to
    // /api/enquiries is fired without `await` and wrapped in try/catch with
    // its own .then/.catch chain, called AFTER the Sheets fetch and the
    // api/enquire fetch, and setStatus("success") is reached unconditionally
    // regardless of its outcome — so a MongoDB-side failure/timeout can
    // never delay, duplicate, or fail the pre-existing Sheets/email path.
    await test("STRATEGY: withErrorHandling maps a simulated Mongoose ValidationError to 400, not a 500/stack trace", async () => {
        // Exercises the exact error-mapping path that would fire if Mongo
        // rejected a write (e.g. schema validation) mid-outage-recovery —
        // confirms failures never leak internals to the client.
        const { withErrorHandling } = require(path.join(ROOT, "api", "_lib", "validation"));
        const handler = withErrorHandling(async () => {
            const err = new Error("Enquiry validation failed: contact.name: Path `contact.name` is required.");
            err.name = "ValidationError";
            throw err;
        });
        const res = mockRes();
        await handler(mockReq({ method: "POST" }), res);
        assert.strictEqual(res.statusCode, 400);
        assert.strictEqual(res.body.error.code, "VALIDATION_ERROR");
    });

    // ══════════════════════════ CLEANUP ══════════════════════════
    console.log("\nCleaning up test records...");
    const leadEventFilter = { "properties.leadId": { $in: createdLeadIds.map(String) } };
    const enquiryEventFilter = { "properties.enquiryId": { $in: createdEnquiryIds.map(String) } };
    await UserEvent.deleteMany({ $or: [{ userId: { $in: createdUserIds } }, leadEventFilter, enquiryEventFilter] });
    await Enquiry.deleteMany({ _id: { $in: createdEnquiryIds } });
    await Lead.deleteMany({ _id: { $in: createdLeadIds } });
    await User.deleteMany({ _id: { $in: createdUserIds } });

    const remaining = {
        users: await User.countDocuments({ _id: { $in: createdUserIds } }),
        leads: await Lead.countDocuments({ _id: { $in: createdLeadIds } }),
        enquiries: await Enquiry.countDocuments({ _id: { $in: createdEnquiryIds } }),
    };
    await test("CLEANUP: all test documents removed (verified by re-query)", async () => {
        assert.deepStrictEqual(remaining, { users: 0, leads: 0, enquiries: 0 }, `residual test data found: ${JSON.stringify(remaining)}`);
    });
    console.log(`Cleanup complete. Created during this run: ${createdUserIds.length} users, ${createdLeadIds.length} leads, ${createdEnquiryIds.length} enquiries (all removed).`);

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
