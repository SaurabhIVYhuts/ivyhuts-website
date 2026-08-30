#!/usr/bin/env node
// Milestone 23.13 — END-TO-END INTEGRATION VERIFICATION.
//
// Every piece of the Dream CRM workflow has been verified in isolation by
// its own scripts/verify-*.js (meta-webhook, meetings, discovery,
// accommodation-curation, presentations, communications, followups,
// staff-workqueue-assignment). What has never been proven is that the
// chain holds together end-to-end — that data created by one real route
// handler is correctly picked up by the next, all the way through to
// Sales Journey and Work Queue reflecting the CUMULATIVE state. That is
// exactly what this script drives, through the real handlers, in the real
// order an agent would actually work a lead:
//
//   Meta webhook (HMAC-verified) creates a Facebook lead
//     -> GET /api/leads/:id shows real source/sourceDetails/journey
//     -> PATCH assignment
//     -> POST/PATCH meeting (scheduled -> completed)
//     -> PUT discovery incrementally, with requirement provenance
//     -> PUT accommodation-curation (realistic, non-Amber property)
//     -> POST presentation (real .pptx, immutable snapshot)
//     -> POST communication (bumps lastContactAt)
//     -> POST/PATCH follow-up (pending -> completed)
//     -> GET /api/leads/work-queue picks up the SAME lead in the correct
//        bucket at each stage
//     -> PATCH lead status -> converted
//
// Same standalone-Node-script convention, throwaway-MongoDB guard, and
// in-memory Redis fallback as every other scripts/verify-*.js in this repo.
"use strict";

const assert = require("assert");
const crypto = require("crypto");
const path = require("path");
const { EventEmitter } = require("events");
const ROOT = path.join(__dirname, "..");

require("dotenv").config({ path: path.join(ROOT, ".env.local") });
require("dotenv").config({ path: path.join(ROOT, ".env") });
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
delete process.env.META_APP_SECRET;
delete process.env.META_WEBHOOK_VERIFY_TOKEN;

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
    const res = { statusCode: 200, headers: {}, body: undefined, endedWith: undefined };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (body) => { res.body = JSON.parse(JSON.stringify(body)); return res; };
    res.setHeader = (key, value) => { res.headers[key] = value; return res; };
    res.end = (payload) => { res.endedWith = payload; return res; };
    return res;
}
function mockWebhookPostReq(bodyBuffer, signature) {
    const req = new EventEmitter();
    req.method = "POST";
    req.query = {};
    req.headers = { "x-hub-signature-256": signature };
    req.destroy = () => {};
    process.nextTick(() => { req.emit("data", bodyBuffer); req.emit("end"); });
    return req;
}
function sign(bodyBuffer, secret) {
    return `sha256=${crypto.createHmac("sha256", secret).update(bodyBuffer).digest("hex")}`;
}
function getDbNameFromUri(uri) {
    const match = /\/([^/?]+)(\?|$)/.exec(uri.replace(/^mongodb(\+srv)?:\/\//, "mongodb://").split("@").pop());
    return match ? match[1] : "";
}

async function main() {
    console.log("=== IvyHuts END-TO-END Workflow Verification (Milestone 23.13) ===");
    console.log("Redis: forced in-memory fallback. No real Meta/provider credentials anywhere in this run.\n");

    const MONGODB_URI = process.env.MONGODB_URI;
    const dbName = MONGODB_URI ? getDbNameFromUri(MONGODB_URI) : "";
    const looksLikeTestDb = /test/i.test(dbName);

    if (!MONGODB_URI) {
        skip("ALL (this script only runs against a real, throwaway MongoDB)", "MONGODB_URI is not set.");
        console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
        return;
    }
    if (!looksLikeTestDb && process.env.ALLOW_MONGODB_LIVE_TEST !== "true") {
        skip("ALL", `MONGODB_URI points at database "${dbName}", which doesn't look like a test database — refusing to run against it.`);
        console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
        return;
    }

    const { connectToDatabase } = require(path.join(ROOT, "api", "_lib", "mongodb"));
    const userStore = require(path.join(ROOT, "api", "_lib", "userStore"));
    const session = require(path.join(ROOT, "api", "_lib", "session"));
    const { resolveMongoUser } = require(path.join(ROOT, "api", "_lib", "businessAuth"));
    const Lead = require(path.join(ROOT, "api", "_lib", "models", "Lead"));
    const User = require(path.join(ROOT, "api", "_lib", "models", "User"));
    const Meeting = require(path.join(ROOT, "api", "_lib", "models", "Meeting"));
    const Discovery = require(path.join(ROOT, "api", "_lib", "models", "Discovery"));
    const Notification = require(path.join(ROOT, "api", "_lib", "models", "Notification"));
    const AccommodationCuration = require(path.join(ROOT, "api", "_lib", "models", "AccommodationCuration"));
    const Presentation = require(path.join(ROOT, "api", "_lib", "models", "Presentation"));
    const Communication = require(path.join(ROOT, "api", "_lib", "models", "Communication"));
    const FollowUp = require(path.join(ROOT, "api", "_lib", "models", "FollowUp"));

    const webhookHandler = require(path.join(ROOT, "api", "leads", "meta", "webhook.js"));
    const leadHandler = require(path.join(ROOT, "api", "leads", "[id].js"));
    const assignmentHandler = require(path.join(ROOT, "api", "leads", "[id]", "assignment.js"));
    const meetingsListHandler = require(path.join(ROOT, "api", "leads", "[id]", "meetings", "index.js"));
    const meetingsSingleHandler = require(path.join(ROOT, "api", "leads", "[id]", "meetings", "[meetingId]", "index.js"));
    const discoveryHandler = require(path.join(ROOT, "api", "leads", "[id]", "discovery.js"));
    const curationHandler = require(path.join(ROOT, "api", "leads", "[id]", "accommodation-curation.js"));
    const presentationsListHandler = require(path.join(ROOT, "api", "leads", "[id]", "presentations", "index.js"));
    const communicationsListHandler = require(path.join(ROOT, "api", "leads", "[id]", "communications", "index.js"));
    const followUpsListHandler = require(path.join(ROOT, "api", "leads", "[id]", "follow-ups", "index.js"));
    const followUpsSingleHandler = require(path.join(ROOT, "api", "leads", "[id]", "follow-ups", "[followUpId]", "index.js"));
    const workQueueHandler = require(path.join(ROOT, "api", "leads", "work-queue.js"));
    const universitiesResolveHandler = require(path.join(ROOT, "api", "universities", "resolve.js"));
    const propertiesSearchHandler = require(path.join(ROOT, "api", "properties", "search.js"));

    await connectToDatabase();
    console.log("\nMongoDB connection established for live verification.\n");

    const runId = `verify-e2e-${Date.now()}`;
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

    const agent = await createActor("MARKETING_AGENT", "agent");
    const agentId = String(agent.mongoUser._id);
    // Scheduling authority is management-only (see .../meetings/index.js's
    // MANAGEMENT_ROLES check) — used below only for the meeting-creation
    // step; the agent still conducts/completes it and does everything else.
    const manager = await createActor("MARKETING_MANAGER", "manager");
    let leadId; // set once the webhook creates it
    let meetingId;
    let presentationV1Id;
    let followUpId;

    // ═══════════════════ STEP 1: Facebook lead arrives via the real webhook ═══════════════════
    await test("STEP 1: a real Meta webhook delivery (HMAC-verified) creates the lead", async () => {
        const secret = "e2e-fake-local-secret";
        process.env.META_APP_SECRET = secret;
        const payload = {
            entry: [{
                changes: [{
                    field: "leadgen",
                    value: {
                        leadgen_id: `${runId}-lg1`,
                        form_id: "form_e2e_1",
                        ad_id: "ad_e2e_1",
                        campaign_id: "campaign_e2e_1",
                        page_id: "page_e2e_1",
                        field_data: [
                            { name: "full_name", values: ["Priya E2E Student"] },
                            { name: "email", values: [`${runId}-priya@example.test`] },
                            { name: "phone_number", values: ["+919123456789"] },
                        ],
                    },
                }],
            }],
        };
        const body = Buffer.from(JSON.stringify(payload));
        const res = mockRes();
        await webhookHandler(mockWebhookPostReq(body, sign(body, secret)), res);
        assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
        assert.strictEqual(res.body.processed, 1);
        const lead = await Lead.findOne({ externalLeadId: `${runId}-lg1` });
        assert.ok(lead, "webhook must have created a real Lead document");
        leadId = String(lead._id);
        createdLeadIds.push(lead._id);
        delete process.env.META_APP_SECRET;
    });

    // ═══════════════════ STEP 2: the lead is visible with real source info + honest zero-journey ═══════════════════
    await test("STEP 2: GET /api/leads/:id shows the real Facebook source, sourceDetails, and an all-false journey", async () => {
        const res = mockRes();
        await leadHandler(mockReq({ method: "GET", query: { id: leadId }, cookie: agent.cookie }), res);
        assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
        const lead = res.body.data;
        assert.strictEqual(lead.source, "facebook_lead_ads");
        assert.strictEqual(lead.sourceDetails.campaignId, "campaign_e2e_1");
        assert.strictEqual(lead.sourceDetails.adId, "ad_e2e_1");
        assert.strictEqual(lead.sourceDetails.formId, "form_e2e_1");
        assert.strictEqual(lead.contact.name, "Priya E2E Student");
        assert.deepStrictEqual(lead.journey, {
            hasAssignment: false, hasOutboundCommunication: false, hasCompletedMeeting: false,
            hasConfirmedRequirements: false, hasCuratedProperties: false, hasReadyPresentation: false,
            hasAnyFollowUp: false, hasPendingFollowUp: false, hasPendingTranscriptReview: false,
        });
        assert.strictEqual(lead.lastInboundCommunicationAt, null);
    });

    // ═══════════════════ STEP 3: assignment ═══════════════════
    await test("STEP 3: assigning the lead is reflected in the SAME journey computation", async () => {
        const patchRes = mockRes();
        await assignmentHandler(mockReq({ method: "PATCH", query: { id: leadId }, cookie: agent.cookie, body: { assignedTo: agentId } }), patchRes);
        assert.strictEqual(patchRes.statusCode, 200, JSON.stringify(patchRes.body));

        const getRes = mockRes();
        await leadHandler(mockReq({ method: "GET", query: { id: leadId }, cookie: agent.cookie }), getRes);
        assert.strictEqual(getRes.body.data.assignedTo, agentId);
        assert.strictEqual(getRes.body.data.journey.hasAssignment, true);
    });

    // ═══════════════════ STEP 4: meeting scheduled -> completed ═══════════════════
    await test("STEP 4a: scheduling a meeting does NOT yet complete the Meeting journey stage", async () => {
        const res = mockRes();
        await meetingsListHandler(mockReq({ method: "POST", query: { id: leadId }, cookie: manager.cookie, body: { scheduledAt: new Date().toISOString(), notes: "Intro call" } }), res);
        assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
        meetingId = res.body.data.id;

        const getRes = mockRes();
        await leadHandler(mockReq({ method: "GET", query: { id: leadId }, cookie: agent.cookie }), getRes);
        assert.strictEqual(getRes.body.data.journey.hasCompletedMeeting, false, "scheduled != completed");

        const notification = await Notification.findOne({ recipientUserId: agentId, leadId, type: "MEETING_SCHEDULED" });
        assert.ok(notification, "the assigned agent must be notified when management schedules a meeting, wired into the full journey, not just in isolation");
    });

    await test("STEP 4b: completing the meeting DOES complete the Meeting journey stage", async () => {
        const patchRes = mockRes();
        await meetingsSingleHandler(mockReq({ method: "PATCH", query: { id: leadId, meetingId }, cookie: agent.cookie, body: { status: "completed" } }), patchRes);
        assert.strictEqual(patchRes.statusCode, 200, JSON.stringify(patchRes.body));

        const getRes = mockRes();
        await leadHandler(mockReq({ method: "GET", query: { id: leadId }, cookie: agent.cookie }), getRes);
        assert.strictEqual(getRes.body.data.journey.hasCompletedMeeting, true);
    });

    // ═══════════════════ STEP 5: Discovery, incrementally, with provenance ═══════════════════
    await test("STEP 5a: a partial Discovery save (university only, tagged source=meeting) leaves requirements incomplete", async () => {
        const res = mockRes();
        await discoveryHandler(
            mockReq({
                method: "PUT", query: { id: leadId }, cookie: agent.cookie,
                body: { student: { university: "University of Hertfordshire" }, requirementSources: { university: "meeting" } },
            }),
            res
        );
        assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
        assert.strictEqual(res.body.data.requirementSources.university, "meeting");

        const getRes = mockRes();
        await leadHandler(mockReq({ method: "GET", query: { id: leadId }, cookie: agent.cookie }), getRes);
        assert.strictEqual(getRes.body.data.journey.hasConfirmedRequirements, false, "budget/sharing still missing");
    });

    await test("STEP 5b: a second incremental PUT (budget+sharing) does not lose the first PUT's university, and completes requirements", async () => {
        const res = mockRes();
        await discoveryHandler(
            mockReq({
                method: "PUT", query: { id: leadId }, cookie: agent.cookie,
                body: { accommodation: { budgetMin: 150, budgetMax: 250, currency: "GBP", sharing: 2 }, requirementSources: { budget: "lead_form", sharing: "agent" } },
            }),
            res
        );
        assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
        assert.strictEqual(res.body.data.student.university, "University of Hertfordshire", "the earlier PUT's university must survive this later, unrelated PUT");
        assert.strictEqual(res.body.data.requirementSources.university, "meeting", "provenance from step 5a must also survive");
        assert.strictEqual(res.body.data.requirementSources.budget, "lead_form");
        assert.strictEqual(res.body.data.requirementSources.sharing, "agent");

        const getRes = mockRes();
        await leadHandler(mockReq({ method: "GET", query: { id: leadId }, cookie: agent.cookie }), getRes);
        assert.strictEqual(getRes.body.data.journey.hasConfirmedRequirements, true);
    });

    // ═══════════════════ STEP 6: Curation ═══════════════════
    await test("STEP 6: saving a curated shortlist (real provider, never Amber) completes the Curated journey stage", async () => {
        const res = mockRes();
        await curationHandler(
            mockReq({
                method: "PUT", query: { id: leadId }, cookie: agent.cookie,
                body: {
                    criteriaSnapshot: { university: { name: "University of Hertfordshire", city: "Hatfield", country: "United Kingdom" }, sharing: 2, currency: "GBP", budgetMin: 150, budgetMax: 250 },
                    properties: [{
                        provider: "uhomes", providerPropertyId: "e2e-1", propertyId: "uhomes:id:e2e-1", name: "Luna Hatfield",
                        url: "https://uhomes.com/p/e2e-1", rent: 190, currency: "GBP", rentPeriod: "week", sharing: 2, availability: "available",
                        advantages: "Cheapest, closest to campus", disadvantages: "Third floor, no lift",
                    }],
                    recommendedPropertyId: "uhomes:id:e2e-1",
                    recommendationReason: "Best balance of price and distance for this budget.",
                },
            }),
            res
        );
        assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
        assert.strictEqual(res.body.data.properties[0].provider, "uhomes");

        const getRes = mockRes();
        await leadHandler(mockReq({ method: "GET", query: { id: leadId }, cookie: agent.cookie }), getRes);
        assert.strictEqual(getRes.body.data.journey.hasCuratedProperties, true);
    });

    // ═══════════════════ STEP 7: Presentation ═══════════════════
    await test("STEP 7: generating a presentation from the saved curation produces a real, non-Amber .pptx and completes the Presentation journey stage", async () => {
        const res = mockRes();
        await presentationsListHandler(mockReq({ method: "POST", query: { id: leadId }, cookie: agent.cookie, body: { title: "E2E Round 1" } }), res);
        assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
        assert.strictEqual(res.body.data.status, "READY");
        presentationV1Id = res.body.data.id;

        const stored = await Presentation.findOne({ _id: presentationV1Id });
        assert.strictEqual(stored.file.data.slice(0, 2).toString("hex"), "504b", "a real .pptx is a zip archive");
        assert.strictEqual(stored.snapshot.properties[0].provider, "uhomes");
        const snapshotJson = JSON.stringify(stored.snapshot).toLowerCase();
        assert.ok(!snapshotJson.includes("amber"), "the immutable snapshot must never reference Amber");

        const getRes = mockRes();
        await leadHandler(mockReq({ method: "GET", query: { id: leadId }, cookie: agent.cookie }), getRes);
        assert.strictEqual(getRes.body.data.journey.hasReadyPresentation, true);
    });

    // ═══════════════════ STEP 8: Communication ═══════════════════
    await test("STEP 8: recording an outbound communication bumps lastContactAt and completes the Contacted journey stage", async () => {
        const before = await Lead.findById(leadId);
        await new Promise((r) => setTimeout(r, 5));
        const res = mockRes();
        await communicationsListHandler(
            mockReq({ method: "POST", query: { id: leadId }, cookie: agent.cookie, body: { channel: "phone", direction: "outbound", type: "call", content: "Shared the presentation, discussed next steps." } }),
            res
        );
        assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
        assert.strictEqual(res.body.data.agentId, agentId);

        const after = await Lead.findById(leadId);
        assert.ok(new Date(after.lastContactAt).getTime() > new Date(before.lastContactAt).getTime());

        const getRes = mockRes();
        await leadHandler(mockReq({ method: "GET", query: { id: leadId }, cookie: agent.cookie }), getRes);
        assert.strictEqual(getRes.body.data.journey.hasOutboundCommunication, true);
    });

    // ═══════════════════ STEP 9: Follow-up + Work Queue integration ═══════════════════
    await test("STEP 9a: creating a follow-up (due tomorrow) completes hasAnyFollowUp/hasPendingFollowUp, and Work Queue buckets this lead as 'upcoming'", async () => {
        const res = mockRes();
        await followUpsListHandler(
            mockReq({ method: "POST", query: { id: leadId }, cookie: agent.cookie, body: { type: "call", dueAt: new Date(Date.now() + 2 * 86400000).toISOString(), notes: "Confirm decision" } }),
            res
        );
        assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
        assert.strictEqual(res.body.data.assignedTo, agentId, "assignedTo must come from the Lead's own assignment");
        followUpId = res.body.data.id;

        const getRes = mockRes();
        await leadHandler(mockReq({ method: "GET", query: { id: leadId }, cookie: agent.cookie }), getRes);
        assert.strictEqual(getRes.body.data.journey.hasAnyFollowUp, true);
        assert.strictEqual(getRes.body.data.journey.hasPendingFollowUp, true);

        const wqRes = mockRes();
        await workQueueHandler(mockReq({ cookie: agent.cookie, query: { assignedTo: agentId, limit: "50" } }), wqRes);
        const row = wqRes.body.data.leads.find((l) => l.id === leadId);
        assert.ok(row, "the lead must appear in its assigned agent's work queue");
        assert.strictEqual(row.bucket, "upcoming", "a follow-up due in 2 days, with every earlier pipeline stage already complete, must bucket as upcoming — never re-flagged as a pipeline gap");
    });

    await test("STEP 9b: completing the follow-up clears hasPendingFollowUp, and Work Queue re-buckets this lead as noNextAction", async () => {
        const res = mockRes();
        await followUpsSingleHandler(mockReq({ method: "PATCH", query: { id: leadId, followUpId }, cookie: agent.cookie, body: { status: "completed", notes: "Confirmed, moving forward" } }), res);
        assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));

        const getRes = mockRes();
        await leadHandler(mockReq({ method: "GET", query: { id: leadId }, cookie: agent.cookie }), getRes);
        assert.strictEqual(getRes.body.data.journey.hasAnyFollowUp, true, "the follow-up still existed, it's just no longer pending");
        assert.strictEqual(getRes.body.data.journey.hasPendingFollowUp, false);

        const wqRes = mockRes();
        await workQueueHandler(mockReq({ cookie: agent.cookie, query: { assignedTo: agentId, limit: "50" } }), wqRes);
        const row = wqRes.body.data.leads.find((l) => l.id === leadId);
        assert.strictEqual(row.bucket, "noNextAction", "every real pipeline stage is genuinely complete — the fully-handled end state");
    });

    // ═══════════════════ STEP 10: a SECOND presentation version, proving immutability across the whole chain ═══════════════════
    await test("STEP 10: generating V2 after all this activity never mutates V1's already-generated snapshot", async () => {
        const res = mockRes();
        await presentationsListHandler(mockReq({ method: "POST", query: { id: leadId }, cookie: agent.cookie, body: { title: "E2E Round 2" } }), res);
        assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
        assert.strictEqual(res.body.data.version, 2);

        const v1After = await Presentation.findOne({ _id: presentationV1Id });
        assert.strictEqual(v1After.version, 1);
        assert.strictEqual(v1After.title, "E2E Round 1");
        assert.strictEqual(v1After.snapshot.properties[0].name, "Luna Hatfield", "V1 must be completely unaffected by everything that happened after it was generated");
    });

    // ═══════════════════ STEP 11: conversion ═══════════════════
    await test("STEP 11: marking the lead converted is reflected via the real Lead.status enum, not a fabricated journey field", async () => {
        const res = mockRes();
        await leadHandler(mockReq({ method: "PATCH", query: { id: leadId }, cookie: agent.cookie, body: { status: "converted" } }), res);
        assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
        assert.strictEqual(res.body.data.status, "converted");
        assert.ok(res.body.data.convertedAt);
    });

    // ═══════════════════ CROSS-LEAD ISOLATION across the whole chain ═══════════════════
    await test("CROSS-LEAD ISOLATION: a second, unrelated lead sees none of this lead's data through any of the routes exercised above", async () => {
        const otherLead = await Lead.create({ contact: { name: "Unrelated Lead", email: `${runId}-other@example.test` }, source: "verify-script" });
        createdLeadIds.push(otherLead._id);
        const otherLeadId = String(otherLead._id);

        const meetingRes = mockRes();
        await meetingsSingleHandler(mockReq({ method: "GET", query: { id: otherLeadId, meetingId }, cookie: agent.cookie }), meetingRes);
        assert.strictEqual(meetingRes.statusCode, 404);

        const discoveryRes = mockRes();
        await discoveryHandler(mockReq({ method: "GET", query: { id: otherLeadId }, cookie: agent.cookie }), discoveryRes);
        assert.strictEqual(discoveryRes.body.data, null);

        const curationRes = mockRes();
        await curationHandler(mockReq({ method: "GET", query: { id: otherLeadId }, cookie: agent.cookie }), curationRes);
        assert.strictEqual(curationRes.body.data, null);

        const presRes = mockRes();
        await presentationsListHandler(mockReq({ method: "GET", query: { id: otherLeadId }, cookie: agent.cookie }), presRes);
        assert.deepStrictEqual(presRes.body.data, []);

        const followUpRes = mockRes();
        await followUpsListHandler(mockReq({ method: "GET", query: { id: otherLeadId }, cookie: agent.cookie }), followUpRes);
        assert.deepStrictEqual(followUpRes.body.data, []);
    });

    // ═══════════════════ CLEANUP ═══════════════════
    await Notification.deleteMany({ leadId: { $in: createdLeadIds } });
    await Meeting.deleteMany({ leadId: { $in: createdLeadIds } });
    await Discovery.deleteMany({ leadId: { $in: createdLeadIds } });
    await AccommodationCuration.deleteMany({ leadId: { $in: createdLeadIds } });
    await Presentation.deleteMany({ leadId: { $in: createdLeadIds } });
    await Communication.deleteMany({ leadId: { $in: createdLeadIds } });
    await FollowUp.deleteMany({ leadId: { $in: createdLeadIds } });
    await Lead.deleteMany({ _id: { $in: createdLeadIds } });
    await User.deleteMany({ _id: { $in: createdUserIds } });
    console.log(`\nCleanup complete. Created during this run: ${createdUserIds.length} users, ${createdLeadIds.length} leads (all removed).`);

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
