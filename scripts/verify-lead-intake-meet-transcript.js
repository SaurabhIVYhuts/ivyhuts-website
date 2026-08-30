#!/usr/bin/env node
// Milestone 23.14 — Unified Lead Intake + Google Meet + Transcript-Driven
// Discovery verification. Same standalone-Node-script convention,
// throwaway-MongoDB guard, and in-memory Redis fallback as every other
// scripts/verify-*.js in this repo.
//
// ANTHROPIC_API_KEY is deliberately deleted AFTER dotenv loads it (same
// single-process pattern verify-business-api.js already uses for the
// UPSTASH_* vars) so the fail-closed extraction tests are genuine, not
// accidentally hitting the real configured key. No GOOGLE_* vars exist in
// .env.local at all (only documented in .env.example) so the Google Meet
// NOT_CONFIGURED tests are real without any extra scrubbing needed.
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
delete process.env.ANTHROPIC_API_KEY;

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

function mockReq({ method = "GET", body, cookie, query = {}, headers = {} } = {}) {
    return { method, body, query: { ...query }, headers: { ...headers, ...(cookie ? { cookie } : {}) }, socket: { remoteAddress: "127.0.0.1" } };
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

// Same signed-webhook-request pattern as verify-meta-webhook.js, reused here
// only for the cross-source dedup test below (webhook delivery + sheet
// import of the SAME underlying Meta lead must resolve to one Lead).
function signWebhook(bodyBuffer, secret) {
    return `sha256=${crypto.createHmac("sha256", secret).update(bodyBuffer).digest("hex")}`;
}
function mockWebhookPostReq({ bodyBuffer, signature }) {
    const req = new EventEmitter();
    req.method = "POST";
    req.query = {};
    req.headers = { "x-hub-signature-256": signature };
    req.destroy = () => {};
    process.nextTick(() => {
        req.emit("data", bodyBuffer);
        req.emit("end");
    });
    return req;
}

async function main() {
    console.log("=== IvyHuts Lead Intake + Meet + Transcript Verification (Milestone 23.14) ===");
    console.log("Redis: forced in-memory fallback. ANTHROPIC_API_KEY scrubbed for fail-closed tests. No real Google credentials anywhere in this run.\n");

    const MONGODB_URI = process.env.MONGODB_URI;
    if (!MONGODB_URI) {
        skip("ALL (this script only runs against a real, throwaway MongoDB)", "MONGODB_URI is not set.");
        console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
        return;
    }
    const dbName = getDbNameFromUri(MONGODB_URI);
    const looksLikeTestDb = /test/i.test(dbName);
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
    const { normalizeMetaSheetRow, computeFillMissingUpdate, isMetaTestLead, isPermissionErrorText, stripIdPrefix } = require(path.join(ROOT, "api", "_lib", "leadIntake"));
    const googleSheetsClient = require(path.join(ROOT, "api", "_lib", "googleSheetsClient"));

    // Require the provider/extraction modules FIRST (before the routes that
    // destructure from them) so this script can substitute a deterministic
    // fake implementation for the "provider succeeds" happy-path tests —
    // the exact "deterministic fake ... only inside tests" pattern this
    // milestone's own instructions call for when real Google/AI credentials
    // are unavailable. Never used in any production code path — only here.
    const googleMeetProvider = require(path.join(ROOT, "api", "_lib", "providers", "meeting", "googleMeetProvider"));
    const transcriptExtraction = require(path.join(ROOT, "api", "_lib", "transcriptExtraction"));

    const leadHandler = require(path.join(ROOT, "api", "leads", "[id].js"));
    const assignmentHandler = require(path.join(ROOT, "api", "leads", "[id]", "assignment.js"));
    const meetingsListHandler = require(path.join(ROOT, "api", "leads", "[id]", "meetings", "index.js"));
    const meetingsSingleHandler = require(path.join(ROOT, "api", "leads", "[id]", "meetings", "[meetingId]", "index.js"));
    const extractRequirementsHandler = require(path.join(ROOT, "api", "leads", "[id]", "meetings", "[meetingId]", "extract-requirements.js"));
    const discoveryHandler = require(path.join(ROOT, "api", "leads", "[id]", "discovery.js"));
    const curationHandler = require(path.join(ROOT, "api", "leads", "[id]", "accommodation-curation.js"));
    const presentationsListHandler = require(path.join(ROOT, "api", "leads", "[id]", "presentations", "index.js"));
    const workQueueHandler = require(path.join(ROOT, "api", "leads", "work-queue.js"));
    const sheetImportHandler = require(path.join(ROOT, "api", "leads", "import", "google-sheet.js"));
    const notificationsListHandler = require(path.join(ROOT, "api", "notifications", "index.js"));
    const notificationsSingleHandler = require(path.join(ROOT, "api", "notifications", "[id]", "index.js"));

    await connectToDatabase();
    console.log("MongoDB connection established for live verification.\n");

    const runId = `verify-m2314-${Date.now()}`;
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

    // Milestone 23.16 — GET /api/leads/:id, for asserting `journey` flags
    // (hasPendingTranscriptReview / hasConfirmedRequirements) the same way
    // Sales Journey/Work Queue actually read them.
    async function getLeadDetail(id, cookie) {
        const res = mockRes();
        await leadHandler(mockReq({ method: "GET", query: { id: String(id) }, cookie }), res);
        assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
        return res.body.data;
    }

    const agent = await createActor("MARKETING_AGENT", "agent");
    const agent2 = await createActor("MARKETING_AGENT", "agent2");
    const manager = await createActor("MARKETING_MANAGER", "manager");

    // ══════════════════════ leadIntake.js — pure normalizer unit tests ══════════════════════
    // Fixtures below are the REAL row shapes captured while inspecting the
    // actual Google Sheet during this milestone's audit phase — not
    // invented columns.
    await test("NORMALIZER: strips Meta's id-type prefixes (l:, ag:, p:, etc.)", () => {
        assert.strictEqual(stripIdPrefix("l:1750531792940141"), "1750531792940141");
        assert.strictEqual(stripIdPrefix("p:+919766903161"), "+919766903161");
        assert.strictEqual(stripIdPrefix("ag:120248909078920413"), "120248909078920413");
        assert.strictEqual(stripIdPrefix(""), "");
    });

    await test("NORMALIZER: detects Facebook's own permission-error boilerplate", () => {
        assert.strictEqual(isPermissionErrorText("c:You don't have enough permission. Please refer to this help: https://www.facebook.com/business/help/766393076839635"), true);
        assert.strictEqual(isPermissionErrorText("IVYhuts Leads v2"), false);
        assert.strictEqual(isPermissionErrorText(null), false);
    });

    await test("NORMALIZER: detects Meta's own synthetic test lead (real observed row shape)", () => {
        const testRow = {
            id: "l:1551614156644017", created_time: "2026-08-14T13:09:09-05:00", ad_id: "", ad_name: "", adset_id: "", adset_name: "",
            campaign_id: "", campaign_name: "", form_id: "f:1756360982374778", form_name: "Generated form 08/14/2026 6:45am",
            is_organic: "true", platform: "", email: "test@meta.com", phone_number: "p:<test lead: dummy data for phone_number>",
            first_name: "<test lead: dummy data for first_name>", last_name: "<test lead: dummy data for last_name>", lead_status: "Done",
        };
        assert.strictEqual(isMetaTestLead(testRow), true);
        assert.strictEqual(normalizeMetaSheetRow(testRow), null, "the test lead must be skipped entirely, never imported");
    });

    await test("NORMALIZER: a real row (observed shape) normalizes correctly, ids stripped, source=facebook_lead_ads", () => {
        const realRow = {
            id: "l:1750531792940141", created_time: "2026-08-14T14:27:47-05:00", ad_id: "ag:120248909078920413", ad_name: "Housing to hiring",
            adset_id: "as:120248909078900413", adset_name: "100 leads v2", campaign_id: "c:120248909078910413", campaign_name: "IVYhuts Leads v2",
            form_id: "f:1756360982374778", form_name: "Generated form 08/14/2026 6:45am", is_organic: "false", platform: "ig",
            email: "pratikpoule@gmail.com", phone_number: "p:+919766903161", first_name: "Adv Pratik", last_name: "Poule", lead_status: "CREATED",
        };
        const normalized = normalizeMetaSheetRow(realRow);
        assert.ok(normalized, "a real row must normalize, not be skipped");
        assert.strictEqual(normalized.externalLeadId, "1750531792940141", "id prefix must be stripped to match the raw leadgen_id the live webhook stores");
        assert.strictEqual(normalized.contact.name, "Adv Pratik Poule");
        assert.strictEqual(normalized.contact.email, "pratikpoule@gmail.com");
        assert.strictEqual(normalized.contact.phone, "+919766903161");
        assert.strictEqual(normalized.source, "facebook_lead_ads");
        assert.strictEqual(normalized.sourceDetails.campaignId, "120248909078910413");
        assert.strictEqual(normalized.sourceDetails.adId, "120248909078920413");
        assert.strictEqual(normalized.sourceDetails.formId, "1756360982374778");
        assert.strictEqual(normalized.sourceDetails.pageId, null, "the sheet has no page_id column at all — must stay null, never fabricated");
        assert.strictEqual(normalized.sourceDetails.platform, "ig");
        assert.strictEqual(normalized.sourceDetails.isOrganic, false);
        assert.strictEqual(normalized.sourceDetails.importedVia, "google_sheet");
    });

    await test("NORMALIZER: a row with Facebook's permission-error text nulls that field, still imports the real lead data", () => {
        const errorRow = {
            id: "l:1822570328724534", created_time: "2026-08-15T03:34:54-05:00",
            ad_id: "ag:You don't have enough permission. Please refer to this help: https://www.facebook.com/business/help/766393076839635",
            ad_name: "You don't have enough permission. Please refer to this help: https://www.facebook.com/business/help/766393076839635",
            adset_id: "as:You don't have enough permission. Please refer to this help: https://www.facebook.com/business/help/766393076839635",
            adset_name: "You don't have enough permission. Please refer to this help: https://www.facebook.com/business/help/766393076839635",
            campaign_id: "c:You don't have enough permission. Please refer to this help: https://www.facebook.com/business/help/766393076839635",
            campaign_name: "You don't have enough permission. Please refer to this help: https://www.facebook.com/business/help/766393076839635",
            form_id: "f:1756360982374778", form_name: "Generated form 08/14/2026 6:45am", is_organic: "false", platform: "ig",
            email: "yananya610@gmail.com", phone_number: "p:+917380472443", first_name: "LikeGupta", last_name: "ji", lead_status: "CREATED",
        };
        const normalized = normalizeMetaSheetRow(errorRow);
        assert.ok(normalized);
        assert.strictEqual(normalized.contact.email, "yananya610@gmail.com", "the real lead data must still import");
        assert.strictEqual(normalized.sourceDetails.adId, null, "permission-error text must never be stored as a real ad id");
        assert.strictEqual(normalized.sourceDetails.campaignName, null, "permission-error text must never be stored as a real campaign name");
    });

    await test("NORMALIZER: a row with no usable id is not importable (returns null)", () => {
        assert.strictEqual(normalizeMetaSheetRow({ email: "noid@example.test", first_name: "No", last_name: "Id" }), null);
    });

    await test("MERGE: fill-missing-only — fills a genuinely missing field, never touches an existing one", () => {
        const existingLead = { contact: { name: "Existing Name", email: null, phone: null }, source: "facebook_lead_ads", sourceDetails: { formId: "abc" } };
        const incoming = { contact: { name: "Different Name From Sheet", email: "new@example.test", phone: "+11111111111" }, source: "facebook_lead_ads", sourceDetails: { formId: "xyz", campaignId: "camp1" } };
        const update = computeFillMissingUpdate(existingLead, incoming);
        assert.ok(update);
        assert.strictEqual(update["contact.name"], undefined, "an existing name must never be overwritten");
        assert.strictEqual(update["contact.email"], "new@example.test", "a missing email must be filled");
        assert.strictEqual(update["contact.phone"], "+11111111111", "a missing phone must be filled");
        assert.strictEqual(update.sourceDetails.formId, "abc", "an existing sourceDetails key must never be overwritten");
        assert.strictEqual(update.sourceDetails.campaignId, "camp1", "a missing sourceDetails key must be filled");
    });

    await test("MERGE: nothing missing -> null (no update)", () => {
        const existingLead = { contact: { name: "Full Name", email: "full@example.test", phone: "+1" }, source: "facebook_lead_ads", sourceDetails: { formId: "abc" } };
        const incoming = { contact: { name: "Other", email: "other@example.test", phone: "+2" }, source: "facebook_lead_ads", sourceDetails: { formId: "xyz" } };
        assert.strictEqual(computeFillMissingUpdate(existingLead, incoming), null);
    });

    // ══════════════════════ Sheet import endpoint — fail-closed (real) ══════════════════════
    await test("SHEET IMPORT: unauthenticated -> 401", async () => {
        const res = mockRes();
        await sheetImportHandler(mockReq({ method: "POST" }), res);
        assert.strictEqual(res.statusCode, 401);
    });
    await test("SHEET IMPORT: not configured (no GOOGLE_SHEETS_LEADS_SPREADSHEET_ID) -> 503, honest, no fabricated rows", async () => {
        const res = mockRes();
        await sheetImportHandler(mockReq({ method: "POST", cookie: agent.cookie }), res);
        assert.strictEqual(res.statusCode, 503, JSON.stringify(res.body));
        assert.strictEqual(res.body.success, false);
    });

    // ══════════════════════ Milestone 23.22 — public Google Sheet read fallback ══════════════════════
    await test("PUBLIC SHEET: parseCsv handles quoted fields with embedded commas, escaped quotes, and CRLF line endings", () => {
        const csv = 'id,name,note\r\n1,"Smith, John","She said ""hi"""\r\n2,Plain,NoQuotes\r\n';
        const table = googleSheetsClient.parseCsv(csv);
        assert.deepStrictEqual(table, [
            ["id", "name", "note"],
            ["1", "Smith, John", 'She said "hi"'],
            ["2", "Plain", "NoQuotes"],
        ]);
    });

    await test("PUBLIC SHEET CONFIG (A): disabled by default in this environment — neither authenticated nor public mode is configured", () => {
        assert.strictEqual(googleSheetsClient.isAuthenticatedImportConfigured(), false, "no real Google credentials exist anywhere in this test run");
        assert.strictEqual(googleSheetsClient.isPublicImportConfigured(), false, "GOOGLE_SHEETS_PUBLIC_IMPORT_ENABLED is not set in .env.local");
        assert.strictEqual(googleSheetsClient.isSheetsImportConfigured(), false);
    });

    await test("STRUCTURAL (L): fetchLeadSheetRows checks authenticated config BEFORE public config — authenticated always wins when both happen to be configured", () => {
        const fs = require("fs");
        const src = fs.readFileSync(path.join(ROOT, "api", "_lib", "googleSheetsClient.js"), "utf8");
        const fnMatch = src.match(/async function fetchLeadSheetRows\(\)[\s\S]*?\n\}/);
        assert.ok(fnMatch);
        const authIdx = fnMatch[0].indexOf("isAuthenticatedImportConfigured()");
        const pubIdx = fnMatch[0].indexOf("isPublicImportConfigured()");
        assert.ok(authIdx >= 0 && pubIdx >= 0 && authIdx < pubIdx, "authenticated check must appear (and therefore be evaluated) before the public check");
    });

    await test("STRUCTURAL (N): exactly two Google Sheet import TRIGGERS (manual + scheduled), sharing one sync core and one client — no second/parallel import system", () => {
        const fs = require("fs");
        const importDir = path.join(ROOT, "api", "leads", "import");
        const files = fs.readdirSync(importDir).filter((f) => f.endsWith(".js")).sort();
        // Two thin trigger routes are legitimate (manual, from the CRM's
        // Refresh button; scheduled, from Vercel Cron) — this milestone's
        // own original header comment explicitly designed for exactly this
        // ("manual sync, scheduled sync... sharing this same pipeline").
        // What must stay singular is the actual sync IMPLEMENTATION, so
        // this test also proves both routes delegate to the same
        // leadSheetSync.js core rather than each re-implementing the loop.
        assert.deepStrictEqual(files, ["google-sheet.js", "sync-cron.js"], "exactly the manual and scheduled trigger routes must exist — no third/parallel import route");
        const clientFiles = fs.readdirSync(path.join(ROOT, "api", "_lib")).filter((f) => /googlesheet/i.test(f));
        assert.deepStrictEqual(clientFiles, ["googleSheetsClient.js"], "exactly one Sheets client module must exist");
        assert.ok(fs.existsSync(path.join(ROOT, "api", "_lib", "leadSheetSync.js")), "the shared sync core module must exist");
        const manualSrc = fs.readFileSync(path.join(importDir, "google-sheet.js"), "utf8");
        const cronSrc = fs.readFileSync(path.join(importDir, "sync-cron.js"), "utf8");
        assert.ok(manualSrc.includes('require("../../_lib/leadSheetSync")'), "the manual route must delegate to the shared sync core, not re-implement it");
        assert.ok(cronSrc.includes('require("../../_lib/leadSheetSync")'), "the scheduled route must delegate to the SAME shared sync core, not a second implementation");
    });

    // Real network calls to Google are never made in this automated suite
    // (same "deterministic fake ... only inside tests" convention as the
    // googleMeetProvider/transcriptExtraction tests above) — global.fetch
    // is patched for the duration of this test only, and the module (plus
    // the route that destructures from it at require-time) is reloaded so
    // the newly-set env vars actually take effect, same technique
    // verify-lead-intake-meet-transcript.js already uses for the provider
    // deterministic-fake tests.
    const googleSheetsClientPath = require.resolve(path.join(ROOT, "api", "_lib", "googleSheetsClient"));
    // leadSheetSync.js destructures isSheetsImportConfigured/fetchLeadSheetRows
    // from googleSheetsClient at require-time (same convention as every
    // other require-time destructure in this codebase) — it must be
    // cache-cleared too, or it keeps its stale references to the
    // pre-reload googleSheetsClient module even after that module itself
    // is refreshed below, since nothing else would ever re-run its own
    // `require("./googleSheetsClient")` call.
    const leadSheetSyncPath = require.resolve(path.join(ROOT, "api", "_lib", "leadSheetSync"));
    const sheetImportHandlerPath = require.resolve(path.join(ROOT, "api", "leads", "import", "google-sheet.js"));
    const syncCronHandlerPath = require.resolve(path.join(ROOT, "api", "leads", "import", "sync-cron.js"));
    function reloadSheetsModules() {
        delete require.cache[googleSheetsClientPath];
        delete require.cache[leadSheetSyncPath];
        delete require.cache[sheetImportHandlerPath];
        delete require.cache[syncCronHandlerPath];
        return {
            patchedClient: require(googleSheetsClientPath),
            patchedHandler: require(sheetImportHandlerPath),
            patchedCronHandler: require(syncCronHandlerPath),
        };
    }

    const FAKE_PUBLIC_CSV =
        "id,created_time,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,form_id,form_name,is_organic,platform,email,phone_number,first_name,last_name,lead_status\n" +
        `l:${runId}-pub-1,2026-08-14T14:27:47-05:00,ag:1,Housing to hiring,as:1,100 leads,c:1,IVYhuts Leads,f:1,Generated form,false,ig,${runId}-pub1@example.test,p:+919000000001,Public,One,CREATED\n` +
        `l:${runId}-pub-2,2026-08-14T14:27:47-05:00,ag:c:You don't have enough permission. Please refer to this help: https://www.facebook.com/business/help/766393076839635,Housing,as:2,100 leads,c:2,IVYhuts Leads,f:1,Generated form,false,fb,${runId}-pub2@example.test,p:+919000000002,Public,Two,CREATED\n` +
        `l:1551614156644017,2026-08-14T13:09:09-05:00,,,,,,,f:1,Generated form,true,,test@meta.com,p:<test lead: dummy data for phone_number>,<test lead: dummy data for first_name>,<test lead: dummy data for last_name>,Done\n`;

    await test("PUBLIC SHEET (B): once GOOGLE_SHEETS_PUBLIC_IMPORT_ENABLED=true + a spreadsheet id are set, public mode is selected and fetches via plain CSV export (fetch mocked, deterministic)", async () => {
        const originalEnabled = process.env.GOOGLE_SHEETS_PUBLIC_IMPORT_ENABLED;
        const originalId = process.env.GOOGLE_SHEETS_LEADS_SPREADSHEET_ID;
        const originalFetch = global.fetch;
        process.env.GOOGLE_SHEETS_PUBLIC_IMPORT_ENABLED = "true";
        process.env.GOOGLE_SHEETS_LEADS_SPREADSHEET_ID = "fake-public-test-id";
        let requestedUrl = null;
        global.fetch = async (url) => {
            requestedUrl = String(url);
            return { ok: true, status: 200, text: async () => FAKE_PUBLIC_CSV };
        };
        try {
            const { patchedClient } = reloadSheetsModules();
            assert.strictEqual(patchedClient.isPublicImportConfigured(), true);
            const result = await patchedClient.fetchLeadSheetRows();
            assert.strictEqual(result.status, "OK", JSON.stringify(result));
            assert.ok(requestedUrl.includes("fake-public-test-id"), "must request the configured spreadsheet id, never a hardcoded/different one");
            assert.ok(requestedUrl.startsWith("https://docs.google.com/spreadsheets/d/"), "must use the plain public export endpoint, no credentials");
            assert.strictEqual(result.rows.length, 3, "all 3 raw rows returned, including the synthetic one — filtering happens in normalizeMetaSheetRow, not here");

            // Full pipeline proof: the SAME normalizer used by the
            // authenticated path correctly excludes the synthetic row and
            // cleans the permission-error field, regardless of which fetch
            // path supplied the raw rows.
            const normalized = result.rows.map(normalizeMetaSheetRow);
            assert.strictEqual(normalized.filter(Boolean).length, 2, "the synthetic Meta test row must be excluded");
            const row2 = normalized.find((n) => n && n.externalLeadId === `${runId}-pub-2`);
            assert.ok(row2);
            assert.strictEqual(row2.sourceDetails.adId, null, "permission-error text must never be stored as a real ad id, via the public path either");
        } finally {
            global.fetch = originalFetch;
            if (originalEnabled === undefined) delete process.env.GOOGLE_SHEETS_PUBLIC_IMPORT_ENABLED;
            else process.env.GOOGLE_SHEETS_PUBLIC_IMPORT_ENABLED = originalEnabled;
            if (originalId === undefined) delete process.env.GOOGLE_SHEETS_LEADS_SPREADSHEET_ID;
            else process.env.GOOGLE_SHEETS_LEADS_SPREADSHEET_ID = originalId;
            reloadSheetsModules(); // restore both modules to the real, unconfigured-wired versions
        }
    });

    await test("PUBLIC SHEET: an HTTP failure from the public export (e.g. sheet no longer publicly shared) is reported as an honest ERROR, never an empty-but-successful result", async () => {
        const originalEnabled = process.env.GOOGLE_SHEETS_PUBLIC_IMPORT_ENABLED;
        const originalId = process.env.GOOGLE_SHEETS_LEADS_SPREADSHEET_ID;
        const originalFetch = global.fetch;
        process.env.GOOGLE_SHEETS_PUBLIC_IMPORT_ENABLED = "true";
        process.env.GOOGLE_SHEETS_LEADS_SPREADSHEET_ID = "fake-now-private-id";
        global.fetch = async () => ({ ok: false, status: 403, text: async () => "" });
        try {
            const { patchedClient } = reloadSheetsModules();
            const result = await patchedClient.fetchLeadSheetRows();
            assert.strictEqual(result.status, "ERROR");
            assert.ok(result.reason.includes("403"));
            assert.strictEqual(result.rows.length, 0, "no fabricated rows on a real fetch failure");
        } finally {
            global.fetch = originalFetch;
            if (originalEnabled === undefined) delete process.env.GOOGLE_SHEETS_PUBLIC_IMPORT_ENABLED;
            else process.env.GOOGLE_SHEETS_PUBLIC_IMPORT_ENABLED = originalEnabled;
            if (originalId === undefined) delete process.env.GOOGLE_SHEETS_LEADS_SPREADSHEET_ID;
            else process.env.GOOGLE_SHEETS_LEADS_SPREADSHEET_ID = originalId;
            reloadSheetsModules();
        }
    });

    await test("PUBLIC SHEET (real route, real DB): POST /api/leads/import/google-sheet end-to-end via the public path creates real Leads, excludes the synthetic row, and stays idempotent on a second run", async () => {
        const originalEnabled = process.env.GOOGLE_SHEETS_PUBLIC_IMPORT_ENABLED;
        const originalId = process.env.GOOGLE_SHEETS_LEADS_SPREADSHEET_ID;
        const originalFetch = global.fetch;
        process.env.GOOGLE_SHEETS_PUBLIC_IMPORT_ENABLED = "true";
        process.env.GOOGLE_SHEETS_LEADS_SPREADSHEET_ID = "fake-public-test-id";
        global.fetch = async () => ({ ok: true, status: 200, text: async () => FAKE_PUBLIC_CSV });
        try {
            const { patchedHandler } = reloadSheetsModules();

            const firstRes = mockRes();
            await patchedHandler(mockReq({ method: "POST", cookie: agent.cookie }), firstRes);
            assert.strictEqual(firstRes.statusCode, 200, JSON.stringify(firstRes.body));
            assert.strictEqual(firstRes.body.data.summary.totalRows, 3);
            assert.strictEqual(firstRes.body.data.summary.created, 2, "2 real rows created, the 1 synthetic Meta test row skipped");
            assert.strictEqual(firstRes.body.data.summary.skipped, 1);

            const created = await Lead.find({ externalLeadId: { $in: [`${runId}-pub-1`, `${runId}-pub-2`] } });
            created.forEach((l) => createdLeadIds.push(l._id));
            assert.strictEqual(created.length, 2);
            assert.ok(created.every((l) => l.source === "facebook_lead_ads"));
            const neverCreated = await Lead.findOne({ externalLeadId: "1551614156644017" });
            assert.strictEqual(neverCreated, null, "the synthetic Meta test row must never become a real Lead");

            const secondRes = mockRes();
            await patchedHandler(mockReq({ method: "POST", cookie: agent.cookie }), secondRes);
            assert.strictEqual(secondRes.statusCode, 200, JSON.stringify(secondRes.body));
            assert.strictEqual(secondRes.body.data.summary.created, 0, "re-running the same sheet must never create duplicates");
            assert.strictEqual(secondRes.body.data.summary.unchanged, 2);
            const countAfter = await Lead.countDocuments({ externalLeadId: { $in: [`${runId}-pub-1`, `${runId}-pub-2`] } });
            assert.strictEqual(countAfter, 2, "still exactly 2 Leads after a second run — idempotent");
        } finally {
            global.fetch = originalFetch;
            if (originalEnabled === undefined) delete process.env.GOOGLE_SHEETS_PUBLIC_IMPORT_ENABLED;
            else process.env.GOOGLE_SHEETS_PUBLIC_IMPORT_ENABLED = originalEnabled;
            if (originalId === undefined) delete process.env.GOOGLE_SHEETS_LEADS_SPREADSHEET_ID;
            else process.env.GOOGLE_SHEETS_LEADS_SPREADSHEET_ID = originalId;
            reloadSheetsModules();
        }
    });

    // ══════════════════ SCHEDULED SYNC (GET /api/leads/import/sync-cron) ══════════════════
    // The second trigger over the SAME leadSheetSync.js core — keeps the
    // CRM's Lead list from ever going stale even if no one clicks "Refresh
    // Leads". Auth is CRON_SECRET (Vercel Cron's own bearer-token
    // convention, same as api/warm-amber-cache.js), never a session role.
    await test("SCHEDULED SYNC: GET without CRON_SECRET configured -> 503, never runs unauthenticated", async () => {
        const original = process.env.CRON_SECRET;
        delete process.env.CRON_SECRET;
        try {
            const res = mockRes();
            await require(syncCronHandlerPath)(mockReq({ method: "GET" }), res);
            assert.strictEqual(res.statusCode, 503, JSON.stringify(res.body));
        } finally {
            if (original === undefined) delete process.env.CRON_SECRET;
            else process.env.CRON_SECRET = original;
        }
    });

    await test("SCHEDULED SYNC: GET with a wrong/missing bearer secret -> 401", async () => {
        const original = process.env.CRON_SECRET;
        process.env.CRON_SECRET = "real-secret-for-this-test";
        try {
            const noAuthRes = mockRes();
            await require(syncCronHandlerPath)(mockReq({ method: "GET" }), noAuthRes);
            assert.strictEqual(noAuthRes.statusCode, 401);

            const wrongAuthRes = mockRes();
            await require(syncCronHandlerPath)(mockReq({ method: "GET", headers: { authorization: "Bearer wrong-secret" } }), wrongAuthRes);
            assert.strictEqual(wrongAuthRes.statusCode, 401);
        } finally {
            if (original === undefined) delete process.env.CRON_SECRET;
            else process.env.CRON_SECRET = original;
        }
    });

    await test("SCHEDULED SYNC: POST (or any non-GET) is rejected — Vercel Cron always sends GET", async () => {
        const res = mockRes();
        await require(syncCronHandlerPath)(mockReq({ method: "POST" }), res);
        assert.strictEqual(res.statusCode, 405);
    });

    await test("SCHEDULED SYNC (real route, real DB): the correct bearer secret runs the SAME sync as the manual button, reaches the SAME Lead collection, and stays idempotent alongside it", async () => {
        const originalSecret = process.env.CRON_SECRET;
        const originalEnabled = process.env.GOOGLE_SHEETS_PUBLIC_IMPORT_ENABLED;
        const originalId = process.env.GOOGLE_SHEETS_LEADS_SPREADSHEET_ID;
        const originalFetch = global.fetch;
        process.env.CRON_SECRET = "real-secret-for-this-test";
        process.env.GOOGLE_SHEETS_PUBLIC_IMPORT_ENABLED = "true";
        process.env.GOOGLE_SHEETS_LEADS_SPREADSHEET_ID = "fake-public-test-id";
        // Deliberately DIFFERENT externalLeadIds from FAKE_PUBLIC_CSV above
        // (-cron- vs -pub-) — that fixture's rows were already created by
        // the earlier "PUBLIC SHEET (real route, real DB)" test in this
        // same script run, so reusing it here would make this test's own
        // "created: 2" assertion fail (they'd already exist as
        // unchanged/merged, not newly created).
        const FAKE_CRON_CSV =
            "id,created_time,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,form_id,form_name,is_organic,platform,email,phone_number,first_name,last_name,lead_status\n" +
            `l:${runId}-cron-1,2026-08-14T14:27:47-05:00,ag:1,Housing to hiring,as:1,100 leads,c:1,IVYhuts Leads,f:1,Generated form,false,ig,${runId}-cron1@example.test,p:+919000000011,Cron,One,CREATED\n` +
            `l:${runId}-cron-2,2026-08-14T14:27:47-05:00,ag:2,Housing,as:2,100 leads,c:2,IVYhuts Leads,f:1,Generated form,false,fb,${runId}-cron2@example.test,p:+919000000012,Cron,Two,CREATED\n`;
        global.fetch = async () => ({ ok: true, status: 200, text: async () => FAKE_CRON_CSV });
        try {
            const { patchedCronHandler, patchedHandler } = reloadSheetsModules();

            // First run: the SCHEDULED trigger creates the leads.
            const cronRes = mockRes();
            await patchedCronHandler(mockReq({ method: "GET", headers: { authorization: "Bearer real-secret-for-this-test" } }), cronRes);
            assert.strictEqual(cronRes.statusCode, 200, JSON.stringify(cronRes.body));
            assert.strictEqual(cronRes.body.status, "OK");
            assert.strictEqual(cronRes.body.summary.created, 2, "2 real rows created");

            const created = await Lead.find({ externalLeadId: { $in: [`${runId}-cron-1`, `${runId}-cron-2`] } });
            created.forEach((l) => createdLeadIds.push(l._id));
            assert.strictEqual(created.length, 2, "the scheduled trigger must write real Leads, not a dry run");

            // Second run: the MANUAL trigger (the CRM's Refresh button) sees
            // the SAME Leads the cron already created and reports them
            // unchanged — proving both triggers share one source of truth,
            // not two independently-tracked import states.
            const manualRes = mockRes();
            await patchedHandler(mockReq({ method: "POST", cookie: agent.cookie }), manualRes);
            assert.strictEqual(manualRes.statusCode, 200, JSON.stringify(manualRes.body));
            assert.strictEqual(manualRes.body.data.summary.created, 0, "the manual trigger must not re-create what the cron trigger already synced");
            assert.strictEqual(manualRes.body.data.summary.unchanged, 2);
            assert.ok(manualRes.body.data.syncedAt, "the manual response must carry a real syncedAt timestamp for the CRM's 'Last synced' indicator");

            const countAfter = await Lead.countDocuments({ externalLeadId: { $in: [`${runId}-cron-1`, `${runId}-cron-2`] } });
            assert.strictEqual(countAfter, 2, "still exactly 2 Leads after both triggers ran — one pipeline, no duplicates");
        } finally {
            global.fetch = originalFetch;
            if (originalSecret === undefined) delete process.env.CRON_SECRET;
            else process.env.CRON_SECRET = originalSecret;
            if (originalEnabled === undefined) delete process.env.GOOGLE_SHEETS_PUBLIC_IMPORT_ENABLED;
            else process.env.GOOGLE_SHEETS_PUBLIC_IMPORT_ENABLED = originalEnabled;
            if (originalId === undefined) delete process.env.GOOGLE_SHEETS_LEADS_SPREADSHEET_ID;
            else process.env.GOOGLE_SHEETS_LEADS_SPREADSHEET_ID = originalId;
            reloadSheetsModules();
        }
    });

    // ══════════════════════ Notifications — created on assignment ══════════════════════
    let leadId;
    await test("SETUP: create a lead directly for assignment/notification tests", async () => {
        const lead = await Lead.create({ contact: { name: "Notification Test Student", email: `${runId}-notif@example.test` }, source: "manual" });
        createdLeadIds.push(lead._id);
        leadId = String(lead._id);
    });

    await test("ASSIGNMENT: assigning a lead creates a LEAD_ASSIGNED notification for the new agent", async () => {
        const res = mockRes();
        await assignmentHandler(mockReq({ method: "PATCH", query: { id: leadId }, cookie: manager.cookie, body: { assignedTo: String(agent.mongoUser._id) } }), res);
        assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));

        const notif = await Notification.findOne({ recipientUserId: agent.mongoUser._id, leadId, type: "LEAD_ASSIGNED" });
        assert.ok(notif, "expected a LEAD_ASSIGNED notification to have been created");
        assert.ok(notif.title.toLowerCase().includes("lead"));
        assert.strictEqual(notif.actionHref, `/dashboard/leads/${leadId}#meeting`);
        assert.strictEqual(notif.readAt, null);
    });

    await test("ASSIGNMENT: re-confirming the SAME assignee does not create a second notification", async () => {
        const before = await Notification.countDocuments({ recipientUserId: agent.mongoUser._id, leadId, type: "LEAD_ASSIGNED" });
        const res = mockRes();
        await assignmentHandler(mockReq({ method: "PATCH", query: { id: leadId }, cookie: manager.cookie, body: { assignedTo: String(agent.mongoUser._id) } }), res);
        assert.strictEqual(res.statusCode, 200);
        const after = await Notification.countDocuments({ recipientUserId: agent.mongoUser._id, leadId, type: "LEAD_ASSIGNED" });
        assert.strictEqual(after, before, "re-confirming the same assignee must not create a duplicate notification");
    });

    await test("NOTIFICATIONS: the assigned agent sees it in their own list, unread", async () => {
        const res = mockRes();
        await notificationsListHandler(mockReq({ method: "GET", cookie: agent.cookie }), res);
        assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
        assert.ok(res.body.data.some((n) => n.leadId === leadId && n.type === "LEAD_ASSIGNED"));
        assert.ok(res.body.unreadCount >= 1);
    });

    await test("NOTIFICATIONS ISOLATION: a DIFFERENT agent never sees agent's notification in their own list", async () => {
        const res = mockRes();
        await notificationsListHandler(mockReq({ method: "GET", cookie: agent2.cookie }), res);
        assert.strictEqual(res.statusCode, 200);
        assert.ok(!res.body.data.some((n) => n.leadId === leadId), "a different agent must never see another agent's notification");
    });

    let notificationId;
    await test("NOTIFICATIONS: mark as read", async () => {
        const listRes = mockRes();
        await notificationsListHandler(mockReq({ method: "GET", cookie: agent.cookie }), listRes);
        const notif = listRes.body.data.find((n) => n.leadId === leadId && n.type === "LEAD_ASSIGNED");
        notificationId = notif.id;

        const res = mockRes();
        await notificationsSingleHandler(mockReq({ method: "PATCH", query: { id: notificationId }, cookie: agent.cookie }), res);
        assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
        assert.ok(res.body.data.readAt);
    });

    await test("NOTIFICATIONS ISOLATION: a DIFFERENT agent cannot mark agent's notification read (404, not 403 — never reveals existence)", async () => {
        const res = mockRes();
        await notificationsSingleHandler(mockReq({ method: "PATCH", query: { id: notificationId }, cookie: agent2.cookie }), res);
        assert.strictEqual(res.statusCode, 404);
    });

    // ══════════════════════ Meetings — Google Meet NOT_CONFIGURED (real) ══════════════════════
    let meetingId;
    await test("MEETING: scheduling succeeds even with Google Meet NOT_CONFIGURED — no real credentials exist, meeting still tracks fine", async () => {
        const res = mockRes();
        const future = new Date(Date.now() + 3600_000).toISOString();
        await meetingsListHandler(mockReq({ method: "POST", query: { id: leadId }, cookie: manager.cookie, body: { scheduledAt: future, notes: "Intro call" } }), res);
        assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
        assert.strictEqual(res.body.data.provider, null, "no real Google credentials exist in this test run — provider must stay null, never fabricated");
        assert.strictEqual(res.body.data.meetingUrl, null);
        meetingId = res.body.data.id;
    });

    await test("MEETING PROVIDER: googleMeetProvider itself reports NOT_CONFIGURED honestly when called directly", async () => {
        const result = await googleMeetProvider.createMeeting({ scheduledAt: new Date(), leadId });
        assert.strictEqual(result.status, "NOT_CONFIGURED");
        assert.strictEqual(result.meetingUrl, null);
    });

    // ══════════════════════ Meeting provider — deterministic fake happy path (test-only) ══════════════════════
    // meetings/index.js destructures `createMeeting` from googleMeetProvider
    // at ITS OWN require-time, so mutating the provider's export after the
    // route is already cached does nothing to the route's already-bound
    // local reference. To exercise the "provider succeeds" wiring for real,
    // drop the route from the require cache, mutate the provider, then
    // re-require the route fresh so its top-level destructure picks up the
    // fake — then restore both so every other test keeps using the real,
    // unpatched wiring.
    const meetingsIndexPath = require.resolve(path.join(ROOT, "api", "leads", "[id]", "meetings", "index.js"));
    await test("MEETING PROVIDER (deterministic fake, test-only): when the provider succeeds, the real meeting record stores the real returned fields", async () => {
        const original = googleMeetProvider.createMeeting;
        googleMeetProvider.createMeeting = async () => ({ status: "OK", provider: "google_meet", providerMeetingId: "fake-test-event-id-123", meetingUrl: "https://meet.google.com/test-fake-abc" });
        delete require.cache[meetingsIndexPath];
        try {
            const patchedMeetingsListHandler = require(meetingsIndexPath);
            const res = mockRes();
            const future = new Date(Date.now() + 7200_000).toISOString();
            await patchedMeetingsListHandler(mockReq({ method: "POST", query: { id: leadId }, cookie: manager.cookie, body: { scheduledAt: future } }), res);
            assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
            assert.strictEqual(res.body.data.provider, "google_meet");
            assert.strictEqual(res.body.data.meetingUrl, "https://meet.google.com/test-fake-abc");
            assert.strictEqual(res.body.data.providerMeetingId, "fake-test-event-id-123");
            // This meeting stays "scheduled" and would otherwise shadow the
            // work-queue bucket tests below (a same-day scheduled meeting
            // legitimately outranks transcriptAvailableNeedsReview) — cancel
            // it immediately so it doesn't leak into later assertions.
            await Meeting.updateOne({ _id: res.body.data.id }, { $set: { status: "cancelled" } });
        } finally {
            googleMeetProvider.createMeeting = original;
            delete require.cache[meetingsIndexPath];
            require(meetingsIndexPath); // restore the cache to the real-provider-wired version
        }
    });

    await test("MEETING: mark completed", async () => {
        const res = mockRes();
        await meetingsSingleHandler(mockReq({ method: "PATCH", query: { id: leadId, meetingId }, cookie: agent.cookie, body: { status: "completed" } }), res);
        assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
        assert.ok(res.body.data.completedAt);
    });

    await test("MEETING: set transcriptText via PATCH", async () => {
        const res = mockRes();
        await meetingsSingleHandler(
            mockReq({
                method: "PATCH", query: { id: leadId, meetingId }, cookie: agent.cookie,
                body: { transcriptText: "Agent: What university are you looking at? Student: University of Hertfordshire, starting a Master's in September 2026. My budget is around 150 to 250 GBP per week and I'd prefer a single room, ideally within walking distance of campus." },
            }),
            res
        );
        assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
        assert.ok(res.body.data.transcriptText.includes("Hertfordshire"));
    });

    await test("MEETING: transcriptText exceeding the size cap is rejected (400)", async () => {
        const res = mockRes();
        await meetingsSingleHandler(mockReq({ method: "PATCH", query: { id: leadId, meetingId }, cookie: agent.cookie, body: { transcriptText: "x".repeat(60_000) } }), res);
        assert.strictEqual(res.statusCode, 400);
    });

    // ══════════════════════ Extraction — fail-closed (real, ANTHROPIC_API_KEY scrubbed) ══════════════════════
    await test("EXTRACTION: not configured (ANTHROPIC_API_KEY scrubbed for this test run) -> 503, no fabricated suggestion", async () => {
        const res = mockRes();
        await extractRequirementsHandler(mockReq({ method: "POST", query: { id: leadId, meetingId }, cookie: agent.cookie }), res);
        assert.strictEqual(res.statusCode, 503, JSON.stringify(res.body));
        const meeting = await Meeting.findById(meetingId);
        assert.strictEqual(meeting.extractedRequirements, null, "no suggestion may ever be stored when extraction is not configured");
    });

    // ══════════════════════ Extraction — deterministic fake happy path (test-only) ══════════════════════
    // Same require-cache issue as the meeting provider above:
    // extract-requirements.js destructures extractRequirementsFromTranscript
    // / isTranscriptExtractionConfigured at ITS require-time, so the module
    // must be dropped and re-required fresh after patching for the fake to
    // actually take effect. The cross-lead isolation check for THIS
    // endpoint is folded into the same scope — with the service genuinely
    // unconfigured (as it is everywhere else in this run) every call 404s
    // or 503s identically regardless of lead, so isolation is only a
    // meaningful check while a request could otherwise succeed.
    const extractRequirementsPath = require.resolve(path.join(ROOT, "api", "leads", "[id]", "meetings", "[meetingId]", "extract-requirements.js"));
    await test("EXTRACTION (deterministic fake, test-only): a successful extraction stores a suggestion on THIS meeting, notifies the assigned agent, and stays cross-lead isolated", async () => {
        const original = transcriptExtraction.extractRequirementsFromTranscript;
        const originalConfigured = transcriptExtraction.isTranscriptExtractionConfigured;
        transcriptExtraction.isTranscriptExtractionConfigured = () => true;
        transcriptExtraction.extractRequirementsFromTranscript = async () => ({
            university: "University of Hertfordshire", course: "Master's", intake: "September 2026",
            budgetMin: 150, budgetMax: 250, currency: "GBP", moveInDate: null, stayDurationMonths: null,
            preferredLocation: null, roomPreference: "single room", sharing: 1, distancePreference: "walking distance to campus",
            priorities: ["distance"], notes: "Prefers walking distance to campus.",
        });
        delete require.cache[extractRequirementsPath];
        try {
            const patchedExtractHandler = require(extractRequirementsPath);

            const res = mockRes();
            await patchedExtractHandler(mockReq({ method: "POST", query: { id: leadId, meetingId }, cookie: agent.cookie }), res);
            assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
            assert.strictEqual(res.body.data.extractedRequirements.university, "University of Hertfordshire");
            assert.strictEqual(res.body.data.extractedRequirements.status, "pending_review");
            assert.ok(res.body.data.extractedRequirements.extractedAt);

            const notif = await Notification.findOne({ recipientUserId: agent.mongoUser._id, leadId, type: "TRANSCRIPT_READY_FOR_REVIEW" });
            assert.ok(notif, "expected a TRANSCRIPT_READY_FOR_REVIEW notification");

            const otherLead = await Lead.create({ contact: { name: "Extraction Isolation Lead", email: `${runId}-extract-iso@example.test` }, source: "manual" });
            createdLeadIds.push(otherLead._id);
            const isoRes = mockRes();
            await patchedExtractHandler(mockReq({ method: "POST", query: { id: String(otherLead._id), meetingId }, cookie: agent.cookie }), isoRes);
            assert.strictEqual(isoRes.statusCode, 404, "a real, configured extraction call must still 404 for a meeting that doesn't belong to the given lead");

            const bareRes = mockRes();
            const bareMeetingRes = mockRes();
            await meetingsListHandler(mockReq({ method: "POST", query: { id: leadId }, cookie: manager.cookie, body: { scheduledAt: new Date().toISOString() } }), bareMeetingRes);
            const bareMeetingId = bareMeetingRes.body.data.id;
            await Meeting.updateOne({ _id: bareMeetingId }, { $set: { status: "cancelled" } }); // keep it out of the work-queue meetingToday check below
            await patchedExtractHandler(mockReq({ method: "POST", query: { id: leadId, meetingId: bareMeetingId }, cookie: agent.cookie }), bareRes);
            assert.strictEqual(bareRes.statusCode, 400, "a meeting with no transcript text must be rejected with 400 even when extraction IS configured, never silently succeed");
        } finally {
            transcriptExtraction.extractRequirementsFromTranscript = original;
            transcriptExtraction.isTranscriptExtractionConfigured = originalConfigured;
            delete require.cache[extractRequirementsPath];
            require(extractRequirementsPath); // restore the cache to the real-unconfigured-wired version
        }
    });

    await test("EXTRACTION: when genuinely unconfigured, the config check fails fast before ever reaching the transcript-text check", async () => {
        // The real "no transcript text -> 400" branch itself is exercised
        // above, inside the deterministic-fake (configured) test — that's
        // the only scope where reaching that branch is even possible. This
        // test instead confirms the two checks' real ORDER: an unconfigured
        // deployment must not leak past the config check just because a
        // meeting also happens to have no transcript.
        //
        // Uses a SEPARATE lead so the extra "scheduled" meeting created here
        // doesn't shadow the shared lead's work-queue bucket tests below (a
        // same-day scheduled meeting legitimately outranks
        // transcriptAvailableNeedsReview in the real bucket precedence).
        const noTextLead = await Lead.create({ contact: { name: "No Transcript Text Lead", email: `${runId}-notext@example.test` }, source: "manual" });
        createdLeadIds.push(noTextLead._id);
        const noTextLeadId = String(noTextLead._id);

        const noTextRes = mockRes();
        await meetingsListHandler(mockReq({ method: "POST", query: { id: noTextLeadId }, cookie: manager.cookie, body: { scheduledAt: new Date().toISOString() } }), noTextRes);
        const bareMeetingId = noTextRes.body.data.id;

        const res = mockRes();
        await extractRequirementsHandler(mockReq({ method: "POST", query: { id: noTextLeadId, meetingId: bareMeetingId }, cookie: agent.cookie }), res);
        assert.strictEqual(res.statusCode, 503, "extraction is genuinely unconfigured in this run — 503 fires before the transcript-text check, which is the correct fail-fast order");
    });

    // ══════════════════════ Work Queue — new bucket ══════════════════════
    await test("WORK QUEUE: a lead with a pending-review extraction buckets as transcriptAvailableNeedsReview", async () => {
        await Lead.updateOne({ _id: leadId }, { $set: { status: "contacted" } }); // must not be "new" or the new-bucket wins first
        const res = mockRes();
        await workQueueHandler(mockReq({ cookie: agent.cookie, query: { assignedTo: String(agent.mongoUser._id), limit: "50" } }), res);
        assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
        const row = res.body.data.leads.find((l) => l.id === leadId);
        assert.ok(row, "the lead must appear in its assigned agent's work queue");
        assert.strictEqual(row.bucket, "transcriptAvailableNeedsReview");
    });

    // ══════════════════════ Confirm into Discovery via the EXISTING endpoint ══════════════════════
    await test("DISCOVERY CONFIRMATION: the agent confirms the suggestion via the existing PUT /discovery, provenance = transcript", async () => {
        const res = mockRes();
        await discoveryHandler(
            mockReq({
                method: "PUT", query: { id: leadId }, cookie: agent.cookie,
                body: {
                    student: { university: "University of Hertfordshire", course: "Master's", intake: "September 2026" },
                    accommodation: { budgetMin: 150, budgetMax: 250, currency: "GBP", sharing: 1, roomPreference: "single room" },
                    requirementSources: { university: "transcript", budget: "transcript", sharing: "transcript" },
                },
            }),
            res
        );
        assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
        assert.strictEqual(res.body.data.requirementSources.university, "transcript");

        const discoveryCheck = await Discovery.findOne({ leadId });
        assert.ok(discoveryCheck);
        assert.strictEqual(discoveryCheck.student.university, "University of Hertfordshire");
    });

    await test("WORK QUEUE: after confirmation, the same lead no longer buckets as transcriptAvailableNeedsReview or discoveryIncomplete", async () => {
        // Mark the extraction reviewed via the real PATCH
        // .../meetings/:meetingId route (markExtractedRequirementsReviewed)
        // — the second half of what the Agent Review UI's "Confirm All"
        // must call, alongside the PUT /discovery confirmation already
        // exercised above.
        const reviewRes = mockRes();
        await meetingsSingleHandler(mockReq({ method: "PATCH", query: { id: leadId, meetingId }, cookie: agent.cookie, body: { markExtractedRequirementsReviewed: true } }), reviewRes);
        assert.strictEqual(reviewRes.statusCode, 200, JSON.stringify(reviewRes.body));
        assert.strictEqual(reviewRes.body.data.extractedRequirements.status, "reviewed");

        const res = mockRes();
        await workQueueHandler(mockReq({ cookie: agent.cookie, query: { assignedTo: String(agent.mongoUser._id), limit: "50" } }), res);
        const row = res.body.data.leads.find((l) => l.id === leadId);
        assert.ok(row);
        assert.notStrictEqual(row.bucket, "transcriptAvailableNeedsReview");
        assert.notStrictEqual(row.bucket, "discoveryIncomplete", "requirements are now confirmed — must not still read as incomplete");
    });

    // ══════════════════════ Milestone 23.16 — partial re-confirmation never clears earlier confirmed fields ══════════════════════
    // Reproduces the exact real bug found in the CRM's extractionToPayload/
    // extractionToFormValues (src/components/discovery/DiscoverySection.tsx):
    // a SECOND meeting's transcript only supports `course` this time (the
    // student re-confirmed their course on a follow-up call; university/
    // budget/sharing weren't discussed again). The confirmation PUT body
    // below is deliberately SPARSE — only the field the transcript actually
    // supported — mirroring exactly what the now-fixed CRM sends (it OMITS
    // unsupported fields rather than sending them as null). This proves the
    // full real chain end-to-end: a correctly-built sparse confirmation
    // request must leave every previously-confirmed field on Discovery
    // untouched, relying on the backend's own partial dot-path merge
    // (already unit-tested in verify-discovery.js) actually holding up
    // under a real transcript-confirmation shaped request, not just a
    // hand-crafted one.
    let secondMeetingId;
    await test("SETUP: a second completed meeting on the same lead, with a partial (course-only) extraction pending review", async () => {
        const meetingRes = mockRes();
        await meetingsListHandler(mockReq({ method: "POST", query: { id: leadId }, cookie: manager.cookie, body: { scheduledAt: new Date().toISOString() } }), meetingRes);
        secondMeetingId = meetingRes.body.data.id;
        await Meeting.updateOne(
            { _id: secondMeetingId },
            { $set: { status: "completed", transcriptText: "Agent: Just confirming — still doing a PhD? Student: Yes, PhD now, not Master's.", extractedRequirements: { status: "pending_review", extractedAt: new Date(), course: "PhD" } } }
        );
        const detail = await getLeadDetail(leadId, agent.cookie);
        assert.strictEqual(detail.journey.hasPendingTranscriptReview, true, "the new pending extraction must be visible on the SAME journey flag used by Sales Journey/Work Queue");
    });

    await test("DISCOVERY PARTIAL RE-CONFIRMATION: a sparse, course-only PUT (mirroring the fixed CRM payload) leaves university/budget/sharing from the FIRST confirmation completely untouched", async () => {
        const before = await Discovery.findOne({ leadId });
        assert.strictEqual(before.student.university, "University of Hertfordshire");
        assert.strictEqual(before.accommodation.budgetMin, 150);
        assert.strictEqual(before.accommodation.sharing, 1);

        const res = mockRes();
        await discoveryHandler(mockReq({ method: "PUT", query: { id: leadId }, cookie: agent.cookie, body: { student: { course: "PhD" } } }), res);
        assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
        assert.strictEqual(res.body.data.student.course, "PhD");

        const after = await Discovery.findOne({ leadId });
        assert.strictEqual(after.student.university, "University of Hertfordshire", "THE BUG: a sparse confirmation must never clear a field it didn't mention");
        assert.strictEqual(after.accommodation.budgetMin, 150, "THE BUG: budget from the FIRST confirmation must survive a later, unrelated partial confirmation");
        assert.strictEqual(after.accommodation.budgetMax, 250);
        assert.strictEqual(after.accommodation.currency, "GBP");
        assert.strictEqual(after.accommodation.sharing, 1, "THE BUG: sharing from the FIRST confirmation must survive a later, unrelated partial confirmation");
        assert.strictEqual(after.requirementSources.university, "transcript", "provenance for the untouched university field must survive too");
        assert.strictEqual(after.requirementSources.budget, "transcript");
    });

    await test("WORK QUEUE / JOURNEY: marking the second extraction reviewed clears hasPendingTranscriptReview again", async () => {
        const reviewRes = mockRes();
        await meetingsSingleHandler(mockReq({ method: "PATCH", query: { id: leadId, meetingId: secondMeetingId }, cookie: agent.cookie, body: { markExtractedRequirementsReviewed: true } }), reviewRes);
        assert.strictEqual(reviewRes.statusCode, 200, JSON.stringify(reviewRes.body));

        const detail = await getLeadDetail(leadId, agent.cookie);
        assert.strictEqual(detail.journey.hasPendingTranscriptReview, false);
        assert.strictEqual(detail.journey.hasConfirmedRequirements, true, "reviewing the second suggestion must not disturb the already-confirmed requirements state");

        const wqRes = mockRes();
        await workQueueHandler(mockReq({ cookie: agent.cookie, query: { assignedTo: String(agent.mongoUser._id), limit: "50" } }), wqRes);
        const row = wqRes.body.data.leads.find((l) => l.id === leadId);
        assert.ok(row);
        assert.notStrictEqual(row.bucket, "transcriptAvailableNeedsReview");
    });

    // ══════════════════════ Cross-lead isolation (new resources) ══════════════════════
    await test("CROSS-LEAD ISOLATION: a second, unrelated lead cannot access this lead's meeting", async () => {
        // The extraction-specific isolation check (with the service
        // genuinely configured, so a 404 actually means isolation rather
        // than uniform 503-for-everyone) already ran above, inside the
        // deterministic-fake extraction test.
        const otherLead = await Lead.create({ contact: { name: "Unrelated Lead", email: `${runId}-other@example.test` }, source: "manual" });
        createdLeadIds.push(otherLead._id);
        const otherLeadId = String(otherLead._id);

        const meetingRes = mockRes();
        await meetingsSingleHandler(mockReq({ method: "GET", query: { id: otherLeadId, meetingId }, cookie: agent.cookie }), meetingRes);
        assert.strictEqual(meetingRes.statusCode, 404);
    });

    // ══════════════════════ Idempotent sheet-row import via the shared pipeline directly ══════════════════════
    await test("IDEMPOTENCY: importing the same normalized row twice (direct pipeline call) never creates a duplicate Lead", async () => {
        const row = {
            id: `l:${runId}-idem-1`, created_time: new Date().toISOString(), ad_id: "ag:1", ad_name: "Test Ad", adset_id: "as:1", adset_name: "Test Adset",
            campaign_id: "c:1", campaign_name: "Test Campaign", form_id: "f:1", form_name: "Test Form", is_organic: "false", platform: "fb",
            email: `${runId}-idem@example.test`, phone_number: "p:+919999999999", first_name: "Idem", last_name: "Potent", lead_status: "CREATED",
        };
        const normalized = normalizeMetaSheetRow(row);
        const first = await Lead.create({ externalLeadId: normalized.externalLeadId, contact: normalized.contact, status: "new", source: normalized.source, sourceDetails: normalized.sourceDetails });
        createdLeadIds.push(first._id);

        const existing = await Lead.findOne({ externalLeadId: normalized.externalLeadId });
        assert.ok(existing);
        const update = computeFillMissingUpdate(existing, normalized);
        assert.strictEqual(update, null, "re-importing the identical row must find nothing missing to fill");

        const count = await Lead.countDocuments({ externalLeadId: normalized.externalLeadId });
        assert.strictEqual(count, 1, "must never create a second Lead for the same externalLeadId");
    });

    // ══════════════════════ Cross-source dedup: real Meta webhook + sheet import, same lead ══════════════════════
    await test("CROSS-SOURCE DEDUP: a lead delivered via the real Meta webhook AND later present in a sheet row resolves to exactly one Lead", async () => {
        const leadgenId = `${runId}-crosssource-1`;
        const webhookSecret = "fake-local-secret-for-this-test-only";
        const webhookHandler = require(path.join(ROOT, "api", "leads", "meta", "webhook.js"));

        const originalSecret = process.env.META_APP_SECRET;
        process.env.META_APP_SECRET = webhookSecret;
        try {
            // 1. The real Meta webhook delivers this lead first (HMAC-verified,
            // the exact same handler verify-meta-webhook.js exercises).
            const payload = {
                entry: [{ changes: [{ field: "leadgen", value: {
                    leadgen_id: leadgenId, form_id: "form_1", ad_id: "ad_1", campaign_id: "camp_1", page_id: "page_1",
                    created_time: 1700000000,
                    field_data: [
                        { name: "full_name", values: ["Cross Source Student"] },
                        { name: "email", values: [`${runId}-crosssource@example.test`] },
                        { name: "phone_number", values: ["+919000000000"] },
                    ],
                } }] }],
            };
            const bodyBuffer = Buffer.from(JSON.stringify(payload));
            const webhookRes = mockRes();
            await webhookHandler(mockWebhookPostReq({ bodyBuffer, signature: signWebhook(bodyBuffer, webhookSecret) }), webhookRes);
            assert.strictEqual(webhookRes.statusCode, 200, JSON.stringify(webhookRes.body));

            const afterWebhook = await Lead.findOne({ externalLeadId: leadgenId });
            assert.ok(afterWebhook, "the webhook must have created the Lead");
            createdLeadIds.push(afterWebhook._id);

            // 2. The SAME underlying Meta lead later shows up as a sheet row —
            // the sheet's own "l:" prefix must strip down to the identical raw
            // leadgen_id the webhook stored, so the two sources resolve to one
            // Lead rather than each minting their own.
            const sheetRow = {
                id: `l:${leadgenId}`, created_time: new Date().toISOString(), ad_id: "ag:ad_1", ad_name: "Cross Source Ad",
                adset_id: "as:1", adset_name: "Adset", campaign_id: "c:camp_1", campaign_name: "Campaign",
                form_id: "f:form_1", form_name: "Form", is_organic: "false", platform: "fb",
                email: `${runId}-crosssource@example.test`, phone_number: "p:+919000000000",
                first_name: "Cross", last_name: "Source (sheet)", lead_status: "CREATED",
            };
            const normalized = normalizeMetaSheetRow(sheetRow);
            assert.strictEqual(normalized.externalLeadId, leadgenId, "the sheet's prefixed id must strip down to exactly the webhook's raw leadgen_id");

            const matchedByImporter = await Lead.findOne({ externalLeadId: normalized.externalLeadId });
            assert.strictEqual(String(matchedByImporter._id), String(afterWebhook._id), "the sheet importer must find the SAME Lead the webhook already created, not miss it");

            const update = computeFillMissingUpdate(matchedByImporter, normalized);
            // The webhook-created lead already has a name/email/phone — the
            // importer's fill-missing-only merge must not overwrite them with
            // the sheet row's own (differently-formatted) values.
            if (update) {
                await Lead.updateOne({ _id: matchedByImporter._id }, { $set: update });
            }
            const finalLead = await Lead.findById(matchedByImporter._id);
            assert.strictEqual(finalLead.contact.name, "Cross Source Student", "the webhook's original name must survive the later sheet import untouched");

            const totalCount = await Lead.countDocuments({ externalLeadId: leadgenId });
            assert.strictEqual(totalCount, 1, "webhook delivery + sheet import of the same Meta lead must never produce two Leads");
        } finally {
            if (originalSecret === undefined) delete process.env.META_APP_SECRET;
            else process.env.META_APP_SECRET = originalSecret;
        }
    });

    // ══════════════════════ FULL END-TO-END SCENARIO ══════════════════════
    // The milestone's own success bar: the CONTRACTS actually CONNECT
    // end-to-end, not just pass in isolation. Chains every stage through
    // the real handlers on one lead: raw sheet row -> normalized -> Lead
    // (exactly as the real import route would create it) -> Assignment ->
    // Notification -> Meeting (Google Meet provider, deterministic fake) ->
    // transcript text -> requirement extraction (deterministic fake) ->
    // agent confirmation via the existing Discovery PUT -> Find Rooms
    // readiness (hasConfirmedRequirements, same rule work-queue.js and
    // api/leads/[id].js's buildJourneyFlags both use) -> Curation ->
    // Presentation. This is "PATH B" (transcript-confirmed Discovery); its
    // presentation's discoverySnapshot is captured below and compared
    // against "PATH A" (manual Discovery, same underlying requirement
    // values) in the PATH EQUIVALENCE test right after this one.
    let pathBPresentationSnapshot = null;
    let pathBLeadId = null;
    await test("END-TO-END: Sheet lead -> Lead -> Assignment -> Notification -> Meeting -> Meet provider -> Transcript -> Extraction -> Discovery confirmation -> Find Rooms readiness -> Curation -> Presentation", async () => {
        // 1. Raw sheet row (real observed shape) -> normalized exactly as
        // the real POST /api/leads/import/google-sheet route would.
        const rawRow = {
            id: `l:${runId}-e2e-1`, created_time: new Date().toISOString(), ad_id: "ag:e2e1", ad_name: "E2E Ad", adset_id: "as:e2e1", adset_name: "E2E Adset",
            campaign_id: "c:e2e1", campaign_name: "E2E Campaign", form_id: "f:e2e1", form_name: "E2E Form", is_organic: "false", platform: "fb",
            email: `${runId}-e2e@example.test`, phone_number: "p:+919888888888", first_name: "End", last_name: "ToEnd", lead_status: "CREATED",
        };
        const normalized = normalizeMetaSheetRow(rawRow);
        assert.ok(normalized, "the E2E fixture row must normalize");

        const e2eLead = await Lead.create({ externalLeadId: normalized.externalLeadId, contact: normalized.contact, status: "new", source: normalized.source, sourceDetails: normalized.sourceDetails });
        createdLeadIds.push(e2eLead._id);
        const e2eLeadId = String(e2eLead._id);
        pathBLeadId = e2eLeadId;
        assert.strictEqual(e2eLead.status, "new", "partial lead creation — no requirement fields invented at intake");

        // 2. Assign -> Notification.
        const assignRes = mockRes();
        await assignmentHandler(mockReq({ method: "PATCH", query: { id: e2eLeadId }, cookie: manager.cookie, body: { assignedTo: String(agent.mongoUser._id) } }), assignRes);
        assert.strictEqual(assignRes.statusCode, 200, JSON.stringify(assignRes.body));
        const assignNotif = await Notification.findOne({ recipientUserId: agent.mongoUser._id, leadId: e2eLeadId, type: "LEAD_ASSIGNED" });
        assert.ok(assignNotif, "expected a LEAD_ASSIGNED notification for the E2E lead");

        // 3. Schedule a meeting, with a deterministic fake Google Meet
        // provider active (require-cache-refreshed, same technique as the
        // isolated meeting-provider test above) -> real provider/meetingUrl
        // fields stored on the Meeting record.
        const originalCreateMeeting = googleMeetProvider.createMeeting;
        googleMeetProvider.createMeeting = async () => ({ status: "OK", provider: "google_meet", providerMeetingId: "e2e-fake-event-id", meetingUrl: "https://meet.google.com/e2e-fake-xyz" });
        delete require.cache[meetingsIndexPath];
        let e2eMeetingId;
        try {
            const patchedMeetingsListHandler = require(meetingsIndexPath);
            const meetingRes = mockRes();
            const future = new Date(Date.now() + 3600_000).toISOString();
            await patchedMeetingsListHandler(mockReq({ method: "POST", query: { id: e2eLeadId }, cookie: manager.cookie, body: { scheduledAt: future } }), meetingRes);
            assert.strictEqual(meetingRes.statusCode, 201, JSON.stringify(meetingRes.body));
            assert.strictEqual(meetingRes.body.data.provider, "google_meet");
            assert.strictEqual(meetingRes.body.data.meetingUrl, "https://meet.google.com/e2e-fake-xyz");
            e2eMeetingId = meetingRes.body.data.id;
        } finally {
            googleMeetProvider.createMeeting = originalCreateMeeting;
            delete require.cache[meetingsIndexPath];
            require(meetingsIndexPath);
        }

        // 4. Hold the meeting, capture the transcript.
        const completeRes = mockRes();
        await meetingsSingleHandler(mockReq({ method: "PATCH", query: { id: e2eLeadId, meetingId: e2eMeetingId }, cookie: agent.cookie, body: { status: "completed" } }), completeRes);
        assert.strictEqual(completeRes.statusCode, 200, JSON.stringify(completeRes.body));

        const transcriptRes = mockRes();
        await meetingsSingleHandler(
            mockReq({
                method: "PATCH", query: { id: e2eLeadId, meetingId: e2eMeetingId }, cookie: agent.cookie,
                body: { transcriptText: "Agent: Which university? Student: University of Leeds, MSc Data Science, January 2027 intake. Budget is 180-220 GBP weekly, ensuite room, 1 person sharing." },
            }),
            transcriptRes
        );
        assert.strictEqual(transcriptRes.statusCode, 200, JSON.stringify(transcriptRes.body));

        // 5. Extract requirements (deterministic fake) -> suggestion stored
        // on the Meeting, agent notified.
        const originalExtract = transcriptExtraction.extractRequirementsFromTranscript;
        const originalExtractConfigured = transcriptExtraction.isTranscriptExtractionConfigured;
        transcriptExtraction.isTranscriptExtractionConfigured = () => true;
        transcriptExtraction.extractRequirementsFromTranscript = async () => ({
            university: "University of Leeds", course: "MSc Data Science", intake: "January 2027",
            budgetMin: 180, budgetMax: 220, currency: "GBP", moveInDate: null, stayDurationMonths: null,
            preferredLocation: null, roomPreference: "ensuite room", sharing: 1, distancePreference: null,
            priorities: [], notes: null,
        });
        delete require.cache[extractRequirementsPath];
        try {
            const patchedExtractHandler = require(extractRequirementsPath);
            const extractRes = mockRes();
            await patchedExtractHandler(mockReq({ method: "POST", query: { id: e2eLeadId, meetingId: e2eMeetingId }, cookie: agent.cookie }), extractRes);
            assert.strictEqual(extractRes.statusCode, 200, JSON.stringify(extractRes.body));
            assert.strictEqual(extractRes.body.data.extractedRequirements.university, "University of Leeds");

            const extractNotif = await Notification.findOne({ recipientUserId: agent.mongoUser._id, leadId: e2eLeadId, type: "TRANSCRIPT_READY_FOR_REVIEW" });
            assert.ok(extractNotif, "expected a TRANSCRIPT_READY_FOR_REVIEW notification for the E2E lead");
        } finally {
            transcriptExtraction.extractRequirementsFromTranscript = originalExtract;
            transcriptExtraction.isTranscriptExtractionConfigured = originalExtractConfigured;
            delete require.cache[extractRequirementsPath];
            require(extractRequirementsPath);
        }

        // 6. Agent reviews and confirms into Discovery via the EXISTING PUT
        // — automation never wrote Discovery directly; this is the explicit
        // agent action the milestone requires.
        const confirmRes = mockRes();
        await discoveryHandler(
            mockReq({
                method: "PUT", query: { id: e2eLeadId }, cookie: agent.cookie,
                body: {
                    student: { university: "University of Leeds", course: "MSc Data Science", intake: "January 2027" },
                    accommodation: { budgetMin: 180, budgetMax: 220, currency: "GBP", sharing: 1, roomPreference: "ensuite room" },
                    requirementSources: { university: "transcript", budget: "transcript", sharing: "transcript" },
                },
            }),
            confirmRes
        );
        assert.strictEqual(confirmRes.statusCode, 200, JSON.stringify(confirmRes.body));

        // 7. Find Rooms readiness — the exact hasConfirmedRequirements bar
        // (university set, a budget bound + currency set, sharing > 0), the
        // same rule work-queue.js's aggregation and buildJourneyFlags both
        // use. Proven here by re-fetching the Discovery document directly.
        const finalDiscovery = await Discovery.findOne({ leadId: e2eLeadId });
        assert.ok(finalDiscovery);
        const hasConfirmedRequirements = Boolean(
            finalDiscovery.student.university &&
            (finalDiscovery.accommodation.budgetMin != null || finalDiscovery.accommodation.budgetMax != null) &&
            finalDiscovery.accommodation.currency &&
            finalDiscovery.accommodation.sharing != null &&
            finalDiscovery.accommodation.sharing > 0
        );
        assert.strictEqual(hasConfirmedRequirements, true, "the E2E lead must now be Find-Rooms-ready, unlocked purely by the agent's own confirmation");

        // 7b. Explicit curation save (never automatic) -> explicit
        // presentation generation, using a real, non-Amber property fixture
        // — the same "PATH B" data used by the PATH EQUIVALENCE test below.
        const curationRes = mockRes();
        await curationHandler(
            mockReq({
                method: "PUT", query: { id: e2eLeadId }, cookie: agent.cookie,
                body: {
                    criteriaSnapshot: { university: { name: "University of Leeds", city: "Leeds", country: "United Kingdom" }, sharing: 1, currency: "GBP", budgetMin: 180, budgetMax: 220 },
                    properties: [{
                        provider: "uhomes", providerPropertyId: "path-equiv-1", propertyId: "uhomes:id:path-equiv-1", name: "Leeds Student Quarter",
                        url: "https://uhomes.com/p/path-equiv-1", rent: 200, currency: "GBP", rentPeriod: "week", sharing: 1, availability: "available",
                        advantages: "Ensuite, 10 min walk to campus", disadvantages: "No parking",
                    }],
                    recommendedPropertyId: "uhomes:id:path-equiv-1",
                    recommendationReason: "Matches the confirmed budget and ensuite preference.",
                },
            }),
            curationRes
        );
        assert.strictEqual(curationRes.statusCode, 200, JSON.stringify(curationRes.body));

        const presRes = mockRes();
        await presentationsListHandler(mockReq({ method: "POST", query: { id: e2eLeadId }, cookie: agent.cookie, body: { title: "Path B Presentation" } }), presRes);
        assert.strictEqual(presRes.statusCode, 201, JSON.stringify(presRes.body));
        const storedPresentation = await Presentation.findById(presRes.body.data.id);
        assert.ok(storedPresentation.snapshot.discoverySnapshot, "the presentation must snapshot confirmed Discovery for personalization");
        pathBPresentationSnapshot = storedPresentation.snapshot.discoverySnapshot;
        assert.strictEqual(pathBPresentationSnapshot.university, "University of Leeds", "personalization must reflect the transcript-confirmed Discovery, never fabricated");

        // 8. The other half of "Confirm All": mark the meeting's suggestion
        // reviewed so it stops showing as pending forever.
        const reviewRes = mockRes();
        await meetingsSingleHandler(mockReq({ method: "PATCH", query: { id: e2eLeadId, meetingId: e2eMeetingId }, cookie: agent.cookie, body: { markExtractedRequirementsReviewed: true } }), reviewRes);
        assert.strictEqual(reviewRes.statusCode, 200, JSON.stringify(reviewRes.body));

        // Cross-check via the real work-queue aggregation too, not just a
        // hand-rolled re-derivation of the rule.
        await Lead.updateOne({ _id: e2eLeadId }, { $set: { status: "contacted" } });
        const wqRes = mockRes();
        await workQueueHandler(mockReq({ cookie: agent.cookie, query: { assignedTo: String(agent.mongoUser._id), limit: "50" } }), wqRes);
        const e2eRow = wqRes.body.data.leads.find((l) => l.id === e2eLeadId);
        assert.ok(e2eRow, "the E2E lead must appear in its assigned agent's work queue");
        assert.notStrictEqual(e2eRow.bucket, "discoveryIncomplete", "requirements are confirmed — work queue must not still call this discoveryIncomplete");
        assert.notStrictEqual(e2eRow.bucket, "transcriptAvailableNeedsReview", "the extraction was reviewed — must not still flag as pending review");
    });

    // ══════════════════════ PATH EQUIVALENCE ══════════════════════
    // "PATH A" (manual Discovery, no meeting/transcript involved at all)
    // must converge on the SAME presentation personalization as "PATH B"
    // above (transcript -> AI suggestion -> agent confirmation), given the
    // identical underlying requirement values — proving Discovery, not its
    // origin, is what the rest of the pipeline actually depends on.
    await test("PATH EQUIVALENCE: manual Discovery produces the same presentation personalization as transcript-confirmed Discovery, given identical requirements", async () => {
        assert.ok(pathBPresentationSnapshot, "PATH B's presentation must have already run and captured a snapshot");

        const manualLead = await Lead.create({ contact: { name: "Manual Path Student", email: `${runId}-manual-path@example.test` }, source: "verify-script" });
        createdLeadIds.push(manualLead._id);
        const manualLeadId = String(manualLead._id);

        const assignRes = mockRes();
        await assignmentHandler(mockReq({ method: "PATCH", query: { id: manualLeadId }, cookie: manager.cookie, body: { assignedTo: String(agent.mongoUser._id) } }), assignRes);
        assert.strictEqual(assignRes.statusCode, 200, JSON.stringify(assignRes.body));

        // No meeting, no transcript, no extraction — the agent types these
        // in directly, tagged with requirementSources = "agent" rather than
        // "transcript", using the EXACT SAME underlying values PATH B's
        // transcript produced above.
        const discoveryRes = mockRes();
        await discoveryHandler(
            mockReq({
                method: "PUT", query: { id: manualLeadId }, cookie: agent.cookie,
                body: {
                    student: { university: "University of Leeds", course: "MSc Data Science", intake: "January 2027" },
                    accommodation: { budgetMin: 180, budgetMax: 220, currency: "GBP", sharing: 1, roomPreference: "ensuite room" },
                    requirementSources: { university: "agent", budget: "agent", sharing: "agent" },
                },
            }),
            discoveryRes
        );
        assert.strictEqual(discoveryRes.statusCode, 200, JSON.stringify(discoveryRes.body));
        assert.strictEqual(discoveryRes.body.data.requirementSources.university, "agent", "PATH A's provenance must honestly say 'agent', never fabricate a transcript origin");

        const curationRes = mockRes();
        await curationHandler(
            mockReq({
                method: "PUT", query: { id: manualLeadId }, cookie: agent.cookie,
                body: {
                    criteriaSnapshot: { university: { name: "University of Leeds", city: "Leeds", country: "United Kingdom" }, sharing: 1, currency: "GBP", budgetMin: 180, budgetMax: 220 },
                    properties: [{
                        provider: "uhomes", providerPropertyId: "path-equiv-1", propertyId: "uhomes:id:path-equiv-1", name: "Leeds Student Quarter",
                        url: "https://uhomes.com/p/path-equiv-1", rent: 200, currency: "GBP", rentPeriod: "week", sharing: 1, availability: "available",
                        advantages: "Ensuite, 10 min walk to campus", disadvantages: "No parking",
                    }],
                    recommendedPropertyId: "uhomes:id:path-equiv-1",
                    recommendationReason: "Matches the confirmed budget and ensuite preference.",
                },
            }),
            curationRes
        );
        assert.strictEqual(curationRes.statusCode, 200, JSON.stringify(curationRes.body));

        const presRes = mockRes();
        await presentationsListHandler(mockReq({ method: "POST", query: { id: manualLeadId }, cookie: agent.cookie, body: { title: "Path A Presentation" } }), presRes);
        assert.strictEqual(presRes.statusCode, 201, JSON.stringify(presRes.body));
        const storedPresentation = await Presentation.findById(presRes.body.data.id);
        const pathASnapshot = storedPresentation.snapshot.discoverySnapshot;
        assert.ok(pathASnapshot, "PATH A's presentation must also snapshot confirmed Discovery");

        // The equivalence claim itself: same personalization fields, given
        // the same confirmed Discovery values, regardless of which path
        // (manual vs transcript-confirmed) produced them.
        for (const field of ["university", "course", "intake", "budgetMin", "budgetMax", "currency", "sharing", "roomPreference"]) {
            assert.strictEqual(pathASnapshot[field], pathBPresentationSnapshot[field], `discoverySnapshot.${field} must match between PATH A and PATH B — the presentation must not care which path produced the confirmed Discovery`);
        }
        // The one thing that must legitimately differ is client identity —
        // these are two different leads/students, never conflated.
        assert.notStrictEqual(storedPresentation.leadId.toString(), pathBLeadId, "PATH A and PATH B must remain two genuinely separate leads, never conflated");
    });

    await test("MEETING: markExtractedRequirementsReviewed rejected (400) when there is no extraction to review", async () => {
        const bareRes = mockRes();
        await meetingsListHandler(mockReq({ method: "POST", query: { id: leadId }, cookie: manager.cookie, body: { scheduledAt: new Date().toISOString() } }), bareRes);
        const bareId = bareRes.body.data.id;
        await Meeting.updateOne({ _id: bareId }, { $set: { status: "cancelled" } });

        const res = mockRes();
        await meetingsSingleHandler(mockReq({ method: "PATCH", query: { id: leadId, meetingId: bareId }, cookie: agent.cookie, body: { markExtractedRequirementsReviewed: true } }), res);
        assert.strictEqual(res.statusCode, 400);
    });

    // ══════════════════════ CLEANUP ══════════════════════
    console.log("\nCleaning up test records...");
    await Notification.deleteMany({ $or: [{ recipientUserId: { $in: createdUserIds } }, { leadId: { $in: createdLeadIds } }] });
    await Meeting.deleteMany({ leadId: { $in: createdLeadIds } });
    await Discovery.deleteMany({ leadId: { $in: createdLeadIds } });
    await AccommodationCuration.deleteMany({ leadId: { $in: createdLeadIds } });
    await Presentation.deleteMany({ leadId: { $in: createdLeadIds } });
    await Lead.deleteMany({ _id: { $in: createdLeadIds } });
    await User.deleteMany({ _id: { $in: createdUserIds } });
    console.log(`Cleanup complete. Created during this run: ${createdUserIds.length} users, ${createdLeadIds.length} leads (all removed).`);

    await require(path.join(ROOT, "api", "_lib", "mongodb")).disconnectFromDatabase();

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
