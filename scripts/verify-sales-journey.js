#!/usr/bin/env node
// Milestone 23.11 — Sales Journey derivation verification.
//
// Tests GET /api/leads/:id's `journey` flags against REAL persisted state,
// built up incrementally on one lead (matching the milestone's own listed
// scenarios: new -> assigned -> contacted -> meeting completed -> discovery
// completed -> curation saved -> presentation generated -> follow-up
// pending -> converted), plus a separate lead for "lost". No provider/
// property data is fabricated — the curated property is the same kind of
// realistic test fixture verify-accommodation-curation.js already uses.
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
    console.log("=== IvyHuts Sales Journey Verification (Milestone 23.11) ===");
    console.log("Redis: forced in-memory fallback for this run.\n");

    const MONGODB_URI = process.env.MONGODB_URI;
    const dbName = MONGODB_URI ? getDbNameFromUri(MONGODB_URI) : "";
    const looksLikeTestDb = /test/i.test(dbName);

    if (!MONGODB_URI) {
        skip("ALL (journey derivation needs a real, incrementally-evolving Lead)", "MONGODB_URI is not set.");
    } else if (!looksLikeTestDb && process.env.ALLOW_MONGODB_LIVE_TEST !== "true") {
        skip("ALL", `MONGODB_URI points at database "${dbName}", which doesn't look like a test database — refusing to run against it.`);
    } else {
        const { connectToDatabase } = require(path.join(ROOT, "api", "_lib", "mongodb"));
        const userStore = require(path.join(ROOT, "api", "_lib", "userStore"));
        const session = require(path.join(ROOT, "api", "_lib", "session"));
        const { resolveMongoUser } = require(path.join(ROOT, "api", "_lib", "businessAuth"));
        const Lead = require(path.join(ROOT, "api", "_lib", "models", "Lead"));
        const User = require(path.join(ROOT, "api", "_lib", "models", "User"));
        const Meeting = require(path.join(ROOT, "api", "_lib", "models", "Meeting"));
        const Discovery = require(path.join(ROOT, "api", "_lib", "models", "Discovery"));
        const AccommodationCuration = require(path.join(ROOT, "api", "_lib", "models", "AccommodationCuration"));
        const Presentation = require(path.join(ROOT, "api", "_lib", "models", "Presentation"));
        const Communication = require(path.join(ROOT, "api", "_lib", "models", "Communication"));
        const FollowUp = require(path.join(ROOT, "api", "_lib", "models", "FollowUp"));
        const leadHandler = require(path.join(ROOT, "api", "_lib", "routes", "leads", "[id].js"));

        await connectToDatabase();
        console.log("\nMongoDB connection established for live verification.\n");

        const runId = `verify-journey-${Date.now()}`;
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
        async function getJourney(leadId, cookie) {
            const res = mockRes();
            await leadHandler(mockReq({ method: "GET", query: { id: String(leadId) }, cookie }), res);
            assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
            return res.body.data;
        }

        const agent = await createActor("MARKETING_AGENT", "agent");
        const lead = await createLead("journey");

        await test("SCENARIO: a brand-new lead has every journey flag false", async () => {
            const detail = await getJourney(lead._id, agent.cookie);
            assert.deepStrictEqual(detail.journey, {
                hasAssignment: false,
                hasOutboundCommunication: false,
                hasCompletedMeeting: false,
                hasConfirmedRequirements: false,
                hasCuratedProperties: false,
                hasReadyPresentation: false,
                hasAnyFollowUp: false,
                hasPendingFollowUp: false,
            });
            assert.strictEqual(detail.lastInboundCommunicationAt, null);
        });

        await test("SCENARIO: assigning the lead sets hasAssignment, nothing else", async () => {
            lead.assignedTo = String(agent.mongoUser._id);
            await lead.save();
            const detail = await getJourney(lead._id, agent.cookie);
            assert.strictEqual(detail.journey.hasAssignment, true);
            assert.strictEqual(detail.journey.hasOutboundCommunication, false);
        });

        await test("SCENARIO: an inbound-only communication does NOT set hasOutboundCommunication, but IS correctly reported as the most recent inbound contact", async () => {
            const comm = await Communication.create({ leadId: lead._id, channel: "whatsapp", direction: "inbound", type: "general" });
            const detail = await getJourney(lead._id, agent.cookie);
            assert.strictEqual(detail.journey.hasOutboundCommunication, false, "activity happened, but not the RIGHT kind — inbound alone never counts as 'Contacted'");
            assert.strictEqual(new Date(detail.lastInboundCommunicationAt).getTime(), new Date(comm.createdAt).getTime(), "it IS the most recent (and only) communication so far, so it must be reported");
        });

        await test("SCENARIO: an outbound communication sets hasOutboundCommunication (Contacted)", async () => {
            await Communication.create({ leadId: lead._id, channel: "phone", direction: "outbound", type: "call", agentId: String(agent.mongoUser._id) });
            const detail = await getJourney(lead._id, agent.cookie);
            assert.strictEqual(detail.journey.hasOutboundCommunication, true);
            assert.strictEqual(detail.lastInboundCommunicationAt, null, "most recent communication is now the outbound one");
        });

        await test("SCENARIO: a SCHEDULED (not yet completed) meeting does NOT set hasCompletedMeeting", async () => {
            const meeting = await Meeting.create({ leadId: lead._id, status: "scheduled", scheduledAt: new Date() });
            const detail = await getJourney(lead._id, agent.cookie);
            assert.strictEqual(detail.journey.hasCompletedMeeting, false);
            return meeting;
        });

        let meetingId;
        await test("SCENARIO: completing that meeting sets hasCompletedMeeting", async () => {
            const m = await Meeting.findOne({ leadId: lead._id });
            m.status = "completed";
            m.completedAt = new Date();
            await m.save();
            meetingId = m._id;
            const detail = await getJourney(lead._id, agent.cookie);
            assert.strictEqual(detail.journey.hasCompletedMeeting, true);
        });

        await test("SCENARIO: a Discovery with only university set does NOT complete hasConfirmedRequirements", async () => {
            await Discovery.create({ leadId: lead._id, student: { university: "University of Hertfordshire" } });
            const detail = await getJourney(lead._id, agent.cookie);
            assert.strictEqual(detail.journey.hasConfirmedRequirements, false);
        });

        await test("SCENARIO: filling in budget/currency/explicit sharing completes hasConfirmedRequirements", async () => {
            const discovery = await Discovery.findOne({ leadId: lead._id });
            discovery.accommodation = { budgetMin: 150, budgetMax: 250, currency: "GBP", sharing: 2 };
            await discovery.save();
            const detail = await getJourney(lead._id, agent.cookie);
            assert.strictEqual(detail.journey.hasConfirmedRequirements, true);
        });

        await test("SCENARIO: a saved-but-EMPTY curation does NOT set hasCuratedProperties", async () => {
            await AccommodationCuration.create({
                leadId: lead._id,
                criteriaSnapshot: { university: { name: "University of Hertfordshire" }, sharing: 2 },
                properties: [],
            });
            const detail = await getJourney(lead._id, agent.cookie);
            assert.strictEqual(detail.journey.hasCuratedProperties, false, "an empty shortlist is not the same as curated options");
        });

        await test("SCENARIO: adding a real property to the curation sets hasCuratedProperties", async () => {
            const curation = await AccommodationCuration.findOne({ leadId: lead._id });
            curation.properties = [{
                provider: "uhomes", providerPropertyId: "abc123", propertyId: "uhomes:id:abc123", name: "Luna Hatfield",
                rent: 190, currency: "GBP", rentPeriod: "week", sharing: 2, availability: "available",
            }];
            curation.recommendedPropertyId = "uhomes:id:abc123";
            await curation.save();
            const detail = await getJourney(lead._id, agent.cookie);
            assert.strictEqual(detail.journey.hasCuratedProperties, true);
        });

        await test("SCENARIO: a GENERATING/FAILED-only presentation does NOT set hasReadyPresentation", async () => {
            await Presentation.create({ leadId: lead._id, version: 1, title: "V1", status: "FAILED", errorMessage: "test" });
            const detail = await getJourney(lead._id, agent.cookie);
            assert.strictEqual(detail.journey.hasReadyPresentation, false, "existence alone is never enough — status must be READY");
        });

        await test("SCENARIO: a READY presentation sets hasReadyPresentation", async () => {
            await Presentation.create({ leadId: lead._id, version: 2, title: "V2", status: "READY", file: { filename: "x.pptx", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", sizeBytes: 10 } });
            const detail = await getJourney(lead._id, agent.cookie);
            assert.strictEqual(detail.journey.hasReadyPresentation, true);
        });

        let followUpId;
        await test("SCENARIO: creating a follow-up sets hasAnyFollowUp AND hasPendingFollowUp", async () => {
            const fu = await FollowUp.create({ leadId: lead._id, assignedTo: String(agent.mongoUser._id), type: "call", dueAt: new Date(Date.now() + 86_400_000) });
            followUpId = fu._id;
            const detail = await getJourney(lead._id, agent.cookie);
            assert.strictEqual(detail.journey.hasAnyFollowUp, true);
            assert.strictEqual(detail.journey.hasPendingFollowUp, true);
        });

        await test("SCENARIO: completing the follow-up keeps hasAnyFollowUp true but clears hasPendingFollowUp", async () => {
            const fu = await FollowUp.findById(followUpId);
            fu.status = "completed";
            fu.completedAt = new Date();
            await fu.save();
            const detail = await getJourney(lead._id, agent.cookie);
            assert.strictEqual(detail.journey.hasAnyFollowUp, true);
            assert.strictEqual(detail.journey.hasPendingFollowUp, false);
        });

        await test("SCENARIO: marking the lead converted is reflected in lead.status (the real, existing enum — not a fabricated journey field)", async () => {
            lead.status = "converted";
            lead.convertedAt = new Date();
            await lead.save();
            const detail = await getJourney(lead._id, agent.cookie);
            assert.strictEqual(detail.status, "converted");
        });

        // ── LOST scenario, a fresh lead ──
        await test("SCENARIO: a lost lead's status reflects 'lost'; earlier-stage flags remain honest (false), never fabricated as skipped-but-complete", async () => {
            const lostLead = await createLead("lost");
            lostLead.status = "lost";
            lostLead.lostAt = new Date();
            lostLead.lostReason = "Chose another provider";
            await lostLead.save();
            const detail = await getJourney(lostLead._id, agent.cookie);
            assert.strictEqual(detail.status, "lost");
            assert.strictEqual(detail.journey.hasAssignment, false);
            assert.strictEqual(detail.journey.hasConfirmedRequirements, false);
        });

        // ── CLEANUP ──
        await Promise.all([
            Meeting.deleteMany({ leadId: { $in: createdLeadIds } }),
            Discovery.deleteMany({ leadId: { $in: createdLeadIds } }),
            AccommodationCuration.deleteMany({ leadId: { $in: createdLeadIds } }),
            Presentation.deleteMany({ leadId: { $in: createdLeadIds } }),
            Communication.deleteMany({ leadId: { $in: createdLeadIds } }),
            FollowUp.deleteMany({ leadId: { $in: createdLeadIds } }),
        ]);
        await Lead.deleteMany({ _id: { $in: createdLeadIds } });
        await User.deleteMany({ _id: { $in: createdUserIds } });
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
