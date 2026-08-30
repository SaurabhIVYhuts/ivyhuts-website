#!/usr/bin/env node
// Verification for the three routes built to fix a live CRM console error
// (Dashboard Overview calling GET /api/staff, /api/leads/assignment-summary,
// /api/leads/work-queue — none of which existed backend-side). Same
// standalone-Node-script convention as every other scripts/verify-*.js in
// this repo (Jest is broken repo-wide for an unrelated pre-existing
// reason).
//
// REDIS: forced into in-memory fallback (same reasoning as
// scripts/verify-business-api.js).
// MONGODB: uses the real MONGODB_URI, guarded by the same "database name
// must contain 'test'" check as scripts/verify-business-api.js.
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
    console.log("=== Staff / Assignment-Summary / Work-Queue Verification ===");
    console.log("Redis: forced in-memory fallback for this run.\n");

    const staffHandler = require(path.join(ROOT, "api", "_lib", "routes", "crm-tools", "staff.js"));
    const assignmentSummaryHandler = require(path.join(ROOT, "api", "_lib", "routes", "leads", "assignment-summary.js"));
    const workQueueHandler = require(path.join(ROOT, "api", "_lib", "routes", "leads", "work-queue.js"));

    await test("STRUCTURAL: all three call withCors", () => {
        const fs = require("fs");
        for (const f of ["api/_lib/routes/crm-tools/staff.js", "api/_lib/routes/leads/assignment-summary.js", "api/_lib/routes/leads/work-queue.js"]) {
            const src = fs.readFileSync(path.join(ROOT, f), "utf8");
            assert.ok(src.includes("withCors("), `${f} must call withCors`);
            assert.ok(src.includes("requireRole("), `${f} must call requireRole`);
        }
    });

    const MONGODB_URI = process.env.MONGODB_URI;
    const dbName = MONGODB_URI ? getDbNameFromUri(MONGODB_URI) : "";
    const looksLikeTestDb = /test/i.test(dbName);

    if (!MONGODB_URI) {
        skip("Everything else", "MONGODB_URI is not set.");
    } else if (!looksLikeTestDb && process.env.ALLOW_MONGODB_LIVE_TEST !== "true") {
        skip("Everything else", `MONGODB_URI points at database "${dbName}", which doesn't look like a test database.`);
    } else {
        const { connectToDatabase } = require(path.join(ROOT, "api", "_lib", "mongodb"));
        const userStore = require(path.join(ROOT, "api", "_lib", "userStore"));
        const session = require(path.join(ROOT, "api", "_lib", "session"));
        const { resolveMongoUser } = require(path.join(ROOT, "api", "_lib", "businessAuth"));
        const Lead = require(path.join(ROOT, "api", "_lib", "models", "Lead"));
        const User = require(path.join(ROOT, "api", "_lib", "models", "User"));
        const FollowUp = require(path.join(ROOT, "api", "_lib", "models", "FollowUp"));
        const Communication = require(path.join(ROOT, "api", "_lib", "models", "Communication"));
        const Meeting = require(path.join(ROOT, "api", "_lib", "models", "Meeting"));
        const Discovery = require(path.join(ROOT, "api", "_lib", "models", "Discovery"));
        const AccommodationCuration = require(path.join(ROOT, "api", "_lib", "models", "AccommodationCuration"));
        const Presentation = require(path.join(ROOT, "api", "_lib", "models", "Presentation"));

        await connectToDatabase();
        console.log("\nMongoDB connection established for live verification.\n");

        const runId = `verify-swq-${Date.now()}`;
        const createdUserIds = [];
        const createdLeadIds = [];
        const createdFollowUpIds = [];
        const createdCommIds = [];

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
        const agentId = String(agent.mongoUser._id);

        // ═══════════ /api/staff ═══════════
        await test("STAFF AUTH: unauthenticated -> 401", async () => {
            const res = mockRes();
            await staffHandler(mockReq({}), res);
            assert.strictEqual(res.statusCode, 401);
        });
        await test("STAFF AUTH: plain USER -> 403", async () => {
            const res = mockRes();
            await staffHandler(mockReq({ cookie: plainUser.cookie }), res);
            assert.strictEqual(res.statusCode, 403);
        });
        await test("STAFF: internal role -> 200, returns internal-role users only, shaped {id,name,email,role}", async () => {
            const res = mockRes();
            await staffHandler(mockReq({ cookie: agent.cookie }), res);
            assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
            const ids = res.body.data.map((s) => s.id);
            assert.ok(ids.includes(String(agent.mongoUser._id)), "must include the agent");
            assert.ok(ids.includes(String(manager.mongoUser._id)), "must include the manager");
            assert.ok(!ids.includes(String(plainUser.mongoUser._id)), "must NOT include a plain USER");
            const entry = res.body.data.find((s) => s.id === agentId);
            assert.deepStrictEqual(Object.keys(entry).sort(), ["email", "id", "name", "role"]);
        });

        // ═══════════ /api/leads/assignment-summary ═══════════
        await createLead("active-1", { assignedTo: agentId, status: "new" });
        await createLead("active-2", { assignedTo: agentId, status: "contacted" });
        await createLead("nurturing-1", { assignedTo: agentId, status: "nurturing" });
        await createLead("converted-1", { assignedTo: agentId, status: "converted" });
        await createLead("unassigned-1", { assignedTo: null, status: "new" });

        const overdueFollowUp = await FollowUp.create({ leadId: createdLeadIds[0], assignedTo: agentId, type: "call", dueAt: new Date(Date.now() - 2 * 86400000), status: "pending" });
        createdFollowUpIds.push(overdueFollowUp._id);
        const todayFollowUp = await FollowUp.create({ leadId: createdLeadIds[1], assignedTo: agentId, type: "call", dueAt: new Date(), status: "pending" });
        createdFollowUpIds.push(todayFollowUp._id);
        const futureFollowUp = await FollowUp.create({ leadId: createdLeadIds[2], assignedTo: agentId, type: "call", dueAt: new Date(Date.now() + 5 * 86400000), status: "pending" });
        createdFollowUpIds.push(futureFollowUp._id);
        const completedOverdue = await FollowUp.create({ leadId: createdLeadIds[0], assignedTo: agentId, type: "call", dueAt: new Date(Date.now() - 5 * 86400000), status: "completed" });
        createdFollowUpIds.push(completedOverdue._id);

        await test("ASSIGNMENT-SUMMARY AUTH: unauthenticated -> 401", async () => {
            const res = mockRes();
            await assignmentSummaryHandler(mockReq({}), res);
            assert.strictEqual(res.statusCode, 401);
        });
        await test("ASSIGNMENT-SUMMARY: correct activeLeads/nurturingLeads/totalLeads/todayFollowUps/overdueFollowUps/unassigned", async () => {
            const res = mockRes();
            await assignmentSummaryHandler(mockReq({ cookie: agent.cookie }), res);
            assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
            const row = res.body.data.agents.find((a) => a.agentId === agentId);
            assert.ok(row, "agent must appear in the summary");
            assert.strictEqual(row.activeLeads, 2, "new + contacted");
            assert.strictEqual(row.nurturingLeads, 1);
            assert.strictEqual(row.totalLeads, 4, "active(2) + nurturing(1) + converted(1), unassigned lead excluded");
            assert.strictEqual(row.todayFollowUps, 1);
            assert.strictEqual(row.overdueFollowUps, 1, "completed follow-up must not count even though its dueAt is in the past");
            assert.ok(res.body.data.unassigned >= 1, "at least the one unassigned lead created above");
        });

        // ═══════════ /api/leads/work-queue ═══════════
        const inboundComm = await Communication.create({ leadId: createdLeadIds[1], channel: "whatsapp", direction: "inbound", type: "general" });
        createdCommIds.push(inboundComm._id);

        await test("WORK-QUEUE AUTH: unauthenticated -> 401", async () => {
            const res = mockRes();
            await workQueueHandler(mockReq({}), res);
            assert.strictEqual(res.statusCode, 401);
        });
        await test("WORK-QUEUE: bucket assignment is correct for overdue/today/upcoming/nurturing", async () => {
            const res = mockRes();
            await workQueueHandler(mockReq({ cookie: manager.cookie, query: { assignedTo: agentId, limit: "50" } }), res);
            assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
            const byId = new Map(res.body.data.leads.map((l) => [l.id, l]));
            assert.strictEqual(byId.get(String(createdLeadIds[0])).bucket, "overdue", "has an overdue pending follow-up, wins over its own 'new' status");
            assert.strictEqual(byId.get(String(createdLeadIds[1])).bucket, "today");
            assert.strictEqual(byId.get(String(createdLeadIds[2])).bucket, "upcoming", "has a future pending follow-up, wins over 'nurturing' status");
            assert.strictEqual(byId.get(String(createdLeadIds[3])).bucket, "noNextAction", "converted, no pending follow-up");
        });
        await test("WORK-QUEUE: summary reflects full (unfiltered-by-bucket) scope", async () => {
            const res = mockRes();
            await workQueueHandler(mockReq({ cookie: manager.cookie, query: { assignedTo: agentId } }), res);
            assert.strictEqual(res.body.data.summary.overdue, 1);
            assert.strictEqual(res.body.data.summary.today, 1);
            assert.strictEqual(res.body.data.summary.upcoming, 1);
            assert.strictEqual(res.body.data.summary.noNextAction, 1);
        });
        await test("WORK-QUEUE: bucket filter narrows leads[] but not summary", async () => {
            const res = mockRes();
            await workQueueHandler(mockReq({ cookie: manager.cookie, query: { assignedTo: agentId, bucket: "overdue" } }), res);
            assert.strictEqual(res.body.data.leads.length, 1);
            assert.strictEqual(res.body.data.leads[0].bucket, "overdue");
            assert.strictEqual(res.body.data.summary.today, 1, "summary must still show the full scope, not just the filtered bucket");
        });
        await test("WORK-QUEUE: lastInboundCommunicationAt is set only when the most recent communication was inbound", async () => {
            const res = mockRes();
            await workQueueHandler(mockReq({ cookie: manager.cookie, query: { assignedTo: agentId, limit: "50" } }), res);
            const withComm = res.body.data.leads.find((l) => l.id === String(createdLeadIds[1]));
            assert.ok(withComm.lastInboundCommunicationAt, "lead with an inbound communication must have it set");
            const withoutComm = res.body.data.leads.find((l) => l.id === String(createdLeadIds[0]));
            assert.strictEqual(withoutComm.lastInboundCommunicationAt, null);
        });
        await test("WORK-QUEUE: pagination meta is correct", async () => {
            const res = mockRes();
            await workQueueHandler(mockReq({ cookie: manager.cookie, query: { assignedTo: agentId, limit: "2", page: "1" } }), res);
            assert.strictEqual(res.body.data.leads.length, 2);
            assert.strictEqual(res.body.data.pagination.total, 4, "4 of the 5 created leads are assignedTo this agent — unassigned-1 correctly excluded");
            assert.strictEqual(res.body.data.pagination.totalPages, 2);
        });
        // ═══════════ WORK-QUEUE: Milestone 23.12 pipeline buckets ═══════════
        const createdMeetingIds = [];
        const createdDiscoveryIds = [];
        const createdCurationIds = [];
        const createdPresentationIds = [];

        const meetingTodayLead = await createLead("meeting-today", { assignedTo: agentId, status: "contacted" });
        const meetingToday = await Meeting.create({ leadId: meetingTodayLead._id, status: "scheduled", scheduledAt: new Date() });
        createdMeetingIds.push(meetingToday._id);

        const discoveryIncompleteLead = await createLead("discovery-incomplete", { assignedTo: agentId, status: "contacted" });
        const incompleteDiscovery = await Discovery.create({ leadId: discoveryIncompleteLead._id, student: { university: "University of Hertfordshire" } });
        createdDiscoveryIds.push(incompleteDiscovery._id);

        const readyForFindRoomsLead = await createLead("ready-find-rooms", { assignedTo: agentId, status: "qualified" });
        const confirmedDiscovery = await Discovery.create({
            leadId: readyForFindRoomsLead._id,
            student: { university: "University of Hertfordshire" },
            accommodation: { budgetMin: 150, budgetMax: 250, currency: "GBP", sharing: 2 },
        });
        createdDiscoveryIds.push(confirmedDiscovery._id);

        // A presentation can only realistically exist after Discovery +
        // curation (that's the actual product flow — see Presentation's own
        // model comment) — this fixture reflects that chain so it lands in
        // presentationNoFollowUp specifically, not an earlier pipeline gap.
        const presentationNoFollowUpLead = await createLead("presentation-no-followup", { assignedTo: agentId, status: "qualified" });
        const presDiscovery = await Discovery.create({
            leadId: presentationNoFollowUpLead._id,
            student: { university: "University of Hertfordshire" },
            accommodation: { budgetMin: 150, budgetMax: 250, currency: "GBP", sharing: 2 },
        });
        createdDiscoveryIds.push(presDiscovery._id);
        const presCuration = await AccommodationCuration.create({
            leadId: presentationNoFollowUpLead._id,
            criteriaSnapshot: { university: { name: "University of Hertfordshire" }, sharing: 2 },
            properties: [{ provider: "uhomes", propertyId: "uhomes:id:2", name: "Test Property 2", availability: "available" }],
        });
        createdCurationIds.push(presCuration._id);
        const readyPresentation = await Presentation.create({
            leadId: presentationNoFollowUpLead._id, version: 1, title: "V1", status: "READY",
            file: { filename: "x.pptx", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", sizeBytes: 10 },
        });
        createdPresentationIds.push(readyPresentation._id);

        // Control: a lead with confirmed requirements AND a curated shortlist
        // AND a READY presentation AND an existing follow-up must fall
        // through every new bucket to noNextAction — proving the pipeline
        // buckets are genuinely conditional, not always-on.
        const fullyHandledLead = await createLead("fully-handled", { assignedTo: agentId, status: "qualified" });
        const fullDiscovery = await Discovery.create({
            leadId: fullyHandledLead._id,
            student: { university: "University of Hertfordshire" },
            accommodation: { budgetMin: 150, budgetMax: 250, currency: "GBP", sharing: 2 },
        });
        createdDiscoveryIds.push(fullDiscovery._id);
        const fullCuration = await AccommodationCuration.create({
            leadId: fullyHandledLead._id,
            criteriaSnapshot: { university: { name: "University of Hertfordshire" }, sharing: 2 },
            properties: [{ provider: "uhomes", propertyId: "uhomes:id:1", name: "Test Property", availability: "available" }],
        });
        createdCurationIds.push(fullCuration._id);
        const fullPresentation = await Presentation.create({
            leadId: fullyHandledLead._id, version: 1, title: "V1", status: "READY",
            file: { filename: "x.pptx", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", sizeBytes: 10 },
        });
        createdPresentationIds.push(fullPresentation._id);
        const fullFollowUp = await FollowUp.create({ leadId: fullyHandledLead._id, assignedTo: agentId, type: "call", dueAt: new Date(Date.now() + 10 * 86400000), status: "completed", completedAt: new Date() });
        createdFollowUpIds.push(fullFollowUp._id);

        await test("WORK-QUEUE: a lead with a same-day scheduled meeting buckets as meetingToday, ahead of 'today' follow-ups", async () => {
            const res = mockRes();
            await workQueueHandler(mockReq({ cookie: manager.cookie, query: { assignedTo: agentId, limit: "50" } }), res);
            const lead = res.body.data.leads.find((l) => l.id === String(meetingTodayLead._id));
            assert.strictEqual(lead.bucket, "meetingToday");
            assert.ok(lead.nextMeeting, "nextMeeting must be populated for display");
        });

        await test("WORK-QUEUE: a contacted lead with an incomplete Discovery buckets as discoveryIncomplete", async () => {
            const res = mockRes();
            await workQueueHandler(mockReq({ cookie: manager.cookie, query: { assignedTo: agentId, limit: "50" } }), res);
            const lead = res.body.data.leads.find((l) => l.id === String(discoveryIncompleteLead._id));
            assert.strictEqual(lead.bucket, "discoveryIncomplete");
        });

        await test("WORK-QUEUE: a qualified lead with confirmed requirements but no curated properties buckets as readyForFindRooms", async () => {
            const res = mockRes();
            await workQueueHandler(mockReq({ cookie: manager.cookie, query: { assignedTo: agentId, limit: "50" } }), res);
            const lead = res.body.data.leads.find((l) => l.id === String(readyForFindRoomsLead._id));
            assert.strictEqual(lead.bucket, "readyForFindRooms");
        });

        await test("WORK-QUEUE: a READY presentation with NO follow-up ever recorded buckets as presentationNoFollowUp", async () => {
            const res = mockRes();
            await workQueueHandler(mockReq({ cookie: manager.cookie, query: { assignedTo: agentId, limit: "50" } }), res);
            const lead = res.body.data.leads.find((l) => l.id === String(presentationNoFollowUpLead._id));
            assert.strictEqual(lead.bucket, "presentationNoFollowUp");
        });

        await test("WORK-QUEUE: a fully-handled lead (requirements + curation + presentation + a completed follow-up) falls through every pipeline bucket to noNextAction", async () => {
            const res = mockRes();
            await workQueueHandler(mockReq({ cookie: manager.cookie, query: { assignedTo: agentId, limit: "50" } }), res);
            const lead = res.body.data.leads.find((l) => l.id === String(fullyHandledLead._id));
            assert.strictEqual(lead.bucket, "noNextAction", "everything is genuinely done — no pipeline gap left to surface");
        });

        await test("WORK-QUEUE: a converted lead with no Discovery is NOT reclassified into discoveryIncomplete (terminal leads are excluded from pipeline buckets)", async () => {
            const res = mockRes();
            await workQueueHandler(mockReq({ cookie: manager.cookie, query: { assignedTo: agentId, limit: "50" } }), res);
            const lead = res.body.data.leads.find((l) => l.id === String(createdLeadIds[3])); // converted-1
            assert.strictEqual(lead.bucket, "noNextAction");
        });

        await test("WORK-QUEUE: a nurturing lead with no Discovery is NOT reclassified into discoveryIncomplete", async () => {
            const nurturingNoDiscoveryLead = await createLead("nurturing-no-discovery", { assignedTo: agentId, status: "nurturing" });
            const res = mockRes();
            await workQueueHandler(mockReq({ cookie: manager.cookie, query: { assignedTo: agentId, limit: "50" } }), res);
            const lead = res.body.data.leads.find((l) => l.id === String(nurturingNoDiscoveryLead._id));
            assert.strictEqual(lead.bucket, "nurturing");
        });

        // Milestone 23.13 — found via end-to-end integration testing: a lead
        // whose `status` was never manually advanced past "new" (nothing in
        // this codebase auto-advances it) was bucketing as "new" forever,
        // even after being fully worked through presentation + follow-up.
        await test("WORK-QUEUE: a lead still literally status='new' but with real outbound contact is NEVER bucketed as 'new' again", async () => {
            const staleStatusLead = await createLead("stale-status-new", { assignedTo: agentId, status: "new" });
            const comm = await Communication.create({ leadId: staleStatusLead._id, channel: "phone", direction: "outbound", type: "call", agentId });
            createdCommIds.push(comm._id);
            const res = mockRes();
            await workQueueHandler(mockReq({ cookie: manager.cookie, query: { assignedTo: agentId, limit: "50" } }), res);
            const lead = res.body.data.leads.find((l) => l.id === String(staleStatusLead._id));
            assert.notStrictEqual(lead.bucket, "new", "outbound contact happened — this is no longer an untouched new lead, regardless of the literal status string");
            // No Discovery/curation/presentation exist for this lead either
            // — with real contact evidence but nothing else done, it must
            // now surface as needing Discovery.
            assert.strictEqual(lead.bucket, "discoveryIncomplete");
        });
        await test("WORK-QUEUE: a genuinely untouched status='new' lead (no outbound contact at all) still buckets as 'new'", async () => {
            const freshLead = await createLead("genuinely-new", { assignedTo: agentId, status: "new" });
            const res = mockRes();
            await workQueueHandler(mockReq({ cookie: manager.cookie, query: { assignedTo: agentId, limit: "50" } }), res);
            const lead = res.body.data.leads.find((l) => l.id === String(freshLead._id));
            assert.strictEqual(lead.bucket, "new", "sanity check — the fix must not make EVERY new lead stop bucketing as new");
        });

        await test("WORK-QUEUE: Lead.score is never referenced anywhere in the bucket/priority logic (structural — no invented scoring algorithm)", () => {
            const fs = require("fs");
            const src = fs.readFileSync(path.join(ROOT, "api", "_lib", "routes", "leads", "work-queue.js"), "utf8");
            const stripComments = src.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
            assert.ok(!/\$score|"\$?score"|\.score\b/.test(stripComments.replace(/lastInboundCommunicationAt|scoreMin|scoreMax/g, "")), "work-queue.js must never read Lead.score for bucket derivation");
        });

        await test("WORK-QUEUE: no N+1 — exactly one Lead.aggregate-driven response per call regardless of lead count (structural: only two aggregate() calls in the whole handler)", () => {
            const fs = require("fs");
            const src = fs.readFileSync(path.join(ROOT, "api", "_lib", "routes", "leads", "work-queue.js"), "utf8");
            const matches = src.match(/Lead\.aggregate\(/g) || [];
            assert.strictEqual(matches.length, 2, "exactly one aggregate for summary, one for the paginated leads — never one query per lead");
        });

        // ── CLEANUP ──
        await FollowUp.deleteMany({ _id: { $in: createdFollowUpIds } });
        await Communication.deleteMany({ _id: { $in: createdCommIds } });
        await Meeting.deleteMany({ _id: { $in: createdMeetingIds } });
        await Discovery.deleteMany({ _id: { $in: createdDiscoveryIds } });
        await AccommodationCuration.deleteMany({ _id: { $in: createdCurationIds } });
        await Presentation.deleteMany({ _id: { $in: createdPresentationIds } });
        await Lead.deleteMany({ _id: { $in: createdLeadIds } });
        await User.deleteMany({ _id: { $in: createdUserIds } });
        console.log(`\nCleanup complete. Created during this run: ${createdUserIds.length} users, ${createdLeadIds.length} leads, ${createdFollowUpIds.length} follow-ups, ${createdCommIds.length} communications (all removed).`);
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
