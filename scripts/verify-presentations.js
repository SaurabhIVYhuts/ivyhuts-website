#!/usr/bin/env node
// Milestone 23.8 — Accommodation Curation → Presentation verification.
// Same standalone-Node-script convention as every other scripts/verify-*.js
// in this repo (Jest is broken repo-wide — see scripts/verify-auth-backend.js).
//
// REDIS: forced into in-memory fallback (see scripts/verify-business-api.js).
// MONGODB: uses the real MONGODB_URI from .env.local for the Auth/Generation/
// Security/Cross-lead/Version/Snapshot-integrity sections, guarded by the
// same "database name must contain 'test'" check every other live-Mongo
// verify script uses. The Normalize/Filename/Structural sections need no
// database at all (pure functions, always run).
//
// Never calls real UHomes/UniAcco/University Living/Gradding Homes, never
// touches Amber, never uses real credentials, never touches the real
// production Atlas database (refuses to run the live sections otherwise).
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
    const res = { statusCode: 200, headers: {}, body: undefined, endedWith: undefined };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (body) => { res.body = JSON.parse(JSON.stringify(body)); return res; };
    res.setHeader = (key, value) => { res.headers[key] = value; return res; };
    res.end = (payload) => { res.endedWith = payload; return res; };
    return res;
}

function getDbNameFromUri(uri) {
    const match = /\/([^/?]+)(\?|$)/.exec(uri.replace(/^mongodb(\+srv)?:\/\//, "mongodb://").split("@").pop());
    return match ? match[1] : "";
}

function validProperty(overrides = {}) {
    return {
        provider: "uhomes",
        providerPropertyId: "abc123",
        propertyId: "uhomes:id:abc123",
        name: "Luna Hatfield",
        url: "https://uhomes.com/p/abc123",
        image: "https://uhomes.com/p/abc123/photo.jpg",
        city: "Hatfield",
        country: "United Kingdom",
        rent: 190,
        rentPerWeek: 190,
        currency: "GBP",
        rentPeriod: "week",
        roomType: "Ensuite",
        sharing: 2,
        availability: "available",
        amenities: ["wifi", "gym"],
        distanceFromUniversityKm: 0.8,
        advantages: "Cheap and close to campus",
        disadvantages: "No lift",
        ...overrides,
    };
}

function validCriteriaSnapshot(overrides = {}) {
    return {
        university: { id: "university-of-hertfordshire", name: "University of Hertfordshire", city: "Hatfield", country: "United Kingdom", latitude: 51.7636, longitude: -0.2405 },
        budgetMin: 150,
        budgetMax: 250,
        currency: "GBP",
        sharing: 2,
        amenities: [],
        ...overrides,
    };
}

async function main() {
    console.log("=== IvyHuts Presentations Verification (Milestone 23.8) ===");
    console.log("Redis: forced in-memory fallback for this run.\n");

    const listHandler = require(path.join(ROOT, "api", "leads", "[id]", "presentations", "index.js"));
    const singleHandler = require(path.join(ROOT, "api", "leads", "[id]", "presentations", "[presentationId]", "index.js"));
    const downloadHandler = require(path.join(ROOT, "api", "leads", "[id]", "presentations", "[presentationId]", "download.js"));
    const {
        normalizeAccommodationCurationForPresentation,
        normalizeProperty,
        buildCostSummary,
        NOT_AVAILABLE,
    } = require(path.join(ROOT, "api", "_lib", "pptNormalizeAccommodation"));

    // ══════════════════════ STRUCTURAL ══════════════════════
    await test("STRUCTURAL: no reference to Amber anywhere in the model or routes (comments excluded)", () => {
        const fs = require("fs");
        const stripComments = (src) => src.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
        const files = [
            path.join(ROOT, "api", "_lib", "models", "Presentation.js"),
            path.join(ROOT, "api", "_lib", "pptNormalizeAccommodation.js"),
            path.join(ROOT, "api", "_lib", "pptBuilderAccommodation.js"),
            path.join(ROOT, "api", "leads", "[id]", "presentations", "index.js"),
            path.join(ROOT, "api", "leads", "[id]", "presentations", "[presentationId]", "index.js"),
            path.join(ROOT, "api", "leads", "[id]", "presentations", "[presentationId]", "download.js"),
        ];
        files.forEach((f) => assert.ok(!/\bamber\b/i.test(stripComments(fs.readFileSync(f, "utf8"))), `${f} must not reference Amber outside comments`));
    });

    await test("STRUCTURAL: toSafePresentation never includes the raw file buffer", () => {
        const safe = listHandler.toSafePresentation({
            _id: "000000000000000000000000", leadId: "000000000000000000000000", version: 1, title: "t", status: "READY", errorMessage: null,
            file: { data: Buffer.from("PK..."), filename: "x.pptx", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", sizeBytes: 5 },
            generatedFrom: { accommodationCurationId: null, accommodationCurationUpdatedAt: null },
            createdBy: null, createdAt: new Date(), updatedAt: new Date(),
        });
        assert.ok(!("data" in safe.file), "file.data (the raw pptx bytes) must never appear in the safe projection");
        assert.strictEqual(safe.file.filename, "x.pptx");
    });

    // ══════════════════ NORMALIZE (pure — no Mongo needed) ══════════════════
    await test("NORMALIZE: a fully-populated property never shows 'Not available' for a field that IS present", () => {
        const p = normalizeProperty(validProperty());
        assert.strictEqual(p.rentLabel, "GBP 190 / week");
        assert.strictEqual(p.sharingLabel, "2 sharing");
        assert.strictEqual(p.distanceLabel, "0.8 km");
        assert.strictEqual(p.availabilityLabel, "Available");
        assert.strictEqual(p.providerLabel, "U-Homes");
    });

    await test("NORMALIZE: every genuinely-missing field renders the literal 'Not available' — never fabricated", () => {
        const p = normalizeProperty(validProperty({ rent: null, currency: null, sharing: null, distanceFromUniversityKm: null, availability: undefined, roomType: null }));
        assert.strictEqual(p.rentLabel, NOT_AVAILABLE);
        assert.strictEqual(p.sharingLabel, NOT_AVAILABLE);
        assert.strictEqual(p.distanceLabel, NOT_AVAILABLE);
        assert.strictEqual(p.availabilityLabel, NOT_AVAILABLE);
        assert.strictEqual(p.roomType, NOT_AVAILABLE);
    });

    await test("NORMALIZE: recommendation resolves ONLY to a property actually present in the curation — a dangling recommendedPropertyId never fabricates a match", () => {
        const normalized = normalizeAccommodationCurationForPresentation(
            { properties: [validProperty()], recommendedPropertyId: "uhomes:id:does-not-exist", recommendationReason: "x", criteriaSnapshot: null },
            { studentName: "Test Student", title: "t" }
        );
        assert.strictEqual(normalized.recommendation, null, "a recommendedPropertyId with no matching property must never resolve to a fabricated recommendation");
    });

    await test("NORMALIZE: recommendation resolves to the correct property when it IS present", () => {
        const normalized = normalizeAccommodationCurationForPresentation(
            { properties: [validProperty()], recommendedPropertyId: "uhomes:id:abc123", recommendationReason: "Closest to campus", criteriaSnapshot: null },
            { studentName: "Test Student", title: "t" }
        );
        assert.ok(normalized.recommendation);
        assert.strictEqual(normalized.recommendation.property.propertyId, "uhomes:id:abc123");
        assert.strictEqual(normalized.recommendation.reason, "Closest to campus");
    });

    await test("NORMALIZE: cost summary groups by each property's OWN currency — no cross-currency conversion/summing", () => {
        const summary = buildCostSummary([
            normalizeProperty(validProperty({ rent: 100, currency: "GBP" })),
            normalizeProperty(validProperty({ rent: 200, currency: "GBP" })),
            normalizeProperty(validProperty({ rent: 900, currency: "USD" })),
            normalizeProperty(validProperty({ rent: null, currency: null })),
        ]);
        const gbp = summary.groups.find((g) => g.currency === "GBP");
        const usd = summary.groups.find((g) => g.currency === "USD");
        assert.strictEqual(gbp.rangeLabel, "GBP 100 – GBP 200");
        assert.strictEqual(usd.rangeLabel, "USD 900");
        assert.strictEqual(summary.unknownCount, 1);
        assert.strictEqual(summary.groups.length, 2, "GBP and USD must never be merged into one figure");
    });

    // ══════════════════ FILENAME (pure) ══════════════════
    await test("FILENAME: generated filename has no path separators or control characters", () => {
        const filename = listHandler.buildFilename(
            normalizeAccommodationCurationForPresentation({ properties: [], criteriaSnapshot: validCriteriaSnapshot(), recommendedPropertyId: null, recommendationReason: null }, { studentName: "A/../../etc", title: "t" }),
            3
        );
        assert.ok(!filename.includes("/") && !filename.includes("\\"));
        assert.ok(filename.endsWith("-v3.pptx"));
    });

    // ══════════════════ MONGODB-DEPENDENT ══════════════════
    const MONGODB_URI = process.env.MONGODB_URI;
    const dbName = MONGODB_URI ? getDbNameFromUri(MONGODB_URI) : "";
    const looksLikeTestDb = /test/i.test(dbName);

    if (!MONGODB_URI) {
        skip("AUTH/GENERATION/SECURITY/CROSS-LEAD/VERSION/SNAPSHOT INTEGRITY (see below)", "MONGODB_URI is not set.");
    } else if (!looksLikeTestDb && process.env.ALLOW_MONGODB_LIVE_TEST !== "true") {
        skip("AUTH/GENERATION/SECURITY/CROSS-LEAD/VERSION/SNAPSHOT INTEGRITY (see below)", `MONGODB_URI points at database "${dbName}", which doesn't look like a test database — refusing to run against it.`);
    } else {
        const { connectToDatabase } = require(path.join(ROOT, "api", "_lib", "mongodb"));
        const userStore = require(path.join(ROOT, "api", "_lib", "userStore"));
        const session = require(path.join(ROOT, "api", "_lib", "session"));
        const { resolveMongoUser } = require(path.join(ROOT, "api", "_lib", "businessAuth"));
        const Lead = require(path.join(ROOT, "api", "_lib", "models", "Lead"));
        const User = require(path.join(ROOT, "api", "_lib", "models", "User"));
        const AccommodationCuration = require(path.join(ROOT, "api", "_lib", "models", "AccommodationCuration"));
        const Presentation = require(path.join(ROOT, "api", "_lib", "models", "Presentation"));
        const accommodationCurationHandler = require(path.join(ROOT, "api", "leads", "[id]", "accommodation-curation.js"));

        await connectToDatabase();
        console.log("\nMongoDB connection established for live verification.\n");

        const runId = `verify-presentations-${Date.now()}`;
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
        async function saveCuration(leadId, cookie, overrides = {}) {
            const res = mockRes();
            await accommodationCurationHandler(
                mockReq({
                    method: "PUT", query: { id: String(leadId) }, cookie,
                    body: { criteriaSnapshot: validCriteriaSnapshot(), properties: [validProperty()], recommendedPropertyId: "uhomes:id:abc123", recommendationReason: "Closest to campus", ...overrides },
                }),
                res
            );
            assert.strictEqual(res.statusCode, 200, `saveCuration setup failed: ${JSON.stringify(res.body)}`);
            return res.body.data;
        }

        const agent = await createActor("MARKETING_AGENT", "agent");
        const manager = await createActor("MARKETING_MANAGER", "manager");
        const plainUser = await createActor("USER", "plain");

        const leadA = await createLead("a"); // will have a saved curation
        const leadB = await createLead("b"); // will NOT have a saved curation (generation-gate test)
        const leadC = await createLead("c"); // isolated lead for cross-lead-isolation checks

        await saveCuration(leadA._id, agent.cookie);

        // ── AUTH ──
        await test("AUTH: unauthenticated GET list -> 401", async () => {
            const res = mockRes();
            await listHandler(mockReq({ method: "GET", query: { id: String(leadA._id) } }), res);
            assert.strictEqual(res.statusCode, 401);
        });
        await test("AUTH: unauthenticated POST -> 401", async () => {
            const res = mockRes();
            await listHandler(mockReq({ method: "POST", query: { id: String(leadA._id) }, body: {} }), res);
            assert.strictEqual(res.statusCode, 401);
        });
        await test("AUTH: plain USER GET list -> 403", async () => {
            const res = mockRes();
            await listHandler(mockReq({ method: "GET", query: { id: String(leadA._id) }, cookie: plainUser.cookie }), res);
            assert.strictEqual(res.statusCode, 403);
        });
        await test("AUTH: MARKETING_AGENT GET list -> 200 (empty)", async () => {
            const res = mockRes();
            await listHandler(mockReq({ method: "GET", query: { id: String(leadA._id) }, cookie: agent.cookie }), res);
            assert.strictEqual(res.statusCode, 200);
            assert.deepStrictEqual(res.body.data, []);
        });

        // ── GENERATION GATE ──
        await test("GENERATION GATE: POST for a lead with NO saved curation -> 409 with the exact CRM-promised message", async () => {
            const res = mockRes();
            await listHandler(mockReq({ method: "POST", query: { id: String(leadB._id) }, cookie: agent.cookie, body: {} }), res);
            assert.strictEqual(res.statusCode, 409);
            assert.strictEqual(res.body.error.code, "NO_CURATION_SAVED");
            assert.strictEqual(res.body.error.message, "Save your curated accommodation options before generating the presentation.");
        });

        // ── GENERATION (V1) ──
        let v1Id;
        await test("GENERATION: POST for a lead WITH a saved curation -> 201, version 1, status READY, real .pptx bytes stored", async () => {
            const res = mockRes();
            await listHandler(mockReq({ method: "POST", query: { id: String(leadA._id) }, cookie: agent.cookie, body: { title: "Round 1" } }), res);
            assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
            assert.strictEqual(res.body.data.version, 1);
            assert.strictEqual(res.body.data.status, "READY");
            assert.strictEqual(res.body.data.title, "Round 1");
            assert.ok(res.body.data.file.sizeBytes > 0);
            assert.ok(!("data" in res.body.data.file));
            v1Id = res.body.data.id;
            const stored = await Presentation.findOne({ _id: v1Id });
            assert.ok(Buffer.isBuffer(stored.file.data));
            assert.strictEqual(stored.file.data.slice(0, 2).toString("hex"), "504b", "a real .pptx is a zip archive and must start with the PK signature");
        });

        await test("GENERATION: generatedFrom provenance records the source AccommodationCuration id/updatedAt", async () => {
            const curation = await AccommodationCuration.findOne({ leadId: leadA._id });
            const stored = await Presentation.findOne({ _id: v1Id });
            assert.strictEqual(String(stored.generatedFrom.accommodationCurationId), String(curation._id));
            assert.strictEqual(new Date(stored.generatedFrom.accommodationCurationUpdatedAt).getTime(), new Date(curation.updatedAt).getTime());
        });

        // ── SNAPSHOT INTEGRITY ──
        await test("SNAPSHOT INTEGRITY: editing the live curation after V1 does NOT change V1's already-generated snapshot", async () => {
            await saveCuration(leadA._id, agent.cookie, { properties: [validProperty({ name: "RENAMED PROPERTY", rent: 999999 })], recommendedPropertyId: "uhomes:id:abc123" });
            const stored = await Presentation.findOne({ _id: v1Id });
            assert.strictEqual(stored.snapshot.properties[0].name, "Luna Hatfield", "V1's snapshot must still show the property name as it was AT GENERATION TIME");
            assert.strictEqual(stored.snapshot.properties[0].rent, 190);
        });

        // ── VERSION INTEGRITY ──
        let v2Id;
        await test("VERSION INTEGRITY: generating V2 (after the live curation edit) never overwrites or mutates V1", async () => {
            const res = mockRes();
            await listHandler(mockReq({ method: "POST", query: { id: String(leadA._id) }, cookie: agent.cookie, body: { title: "Round 2" } }), res);
            assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
            assert.strictEqual(res.body.data.version, 2);
            v2Id = res.body.data.id;

            const v1After = await Presentation.findOne({ _id: v1Id });
            assert.strictEqual(v1After.version, 1);
            assert.strictEqual(v1After.title, "Round 1");
            assert.strictEqual(v1After.snapshot.properties[0].name, "Luna Hatfield", "V1 must survive V2's generation completely unchanged");

            const v2After = await Presentation.findOne({ _id: v2Id });
            assert.strictEqual(v2After.snapshot.properties[0].name, "RENAMED PROPERTY", "V2 must reflect the curation as it stood at V2's own generation time");
        });

        await test("VERSION INTEGRITY: list returns both versions, newest first, and both remain fetchable", async () => {
            const res = mockRes();
            await listHandler(mockReq({ method: "GET", query: { id: String(leadA._id) }, cookie: agent.cookie }), res);
            assert.strictEqual(res.body.data.length, 2);
            assert.deepStrictEqual(res.body.data.map((p) => p.version), [2, 1]);
        });

        // ── DOUBLE-CLICK / IDEMPOTENCY ──
        await test("IDEMPOTENCY: two concurrent POSTs for the same lead never create two documents with the same version", async () => {
            const before = await Presentation.countDocuments({ leadId: leadA._id });
            const resA = mockRes();
            const resB = mockRes();
            await Promise.all([
                listHandler(mockReq({ method: "POST", query: { id: String(leadA._id) }, cookie: agent.cookie, body: { title: "Concurrent A" } }), resA),
                listHandler(mockReq({ method: "POST", query: { id: String(leadA._id) }, cookie: manager.cookie, body: { title: "Concurrent B" } }), resB),
            ]);
            const statuses = [resA.statusCode, resB.statusCode].sort();
            assert.ok(statuses.every((s) => s === 201 || s === 409), `unexpected status pair: ${statuses}`);
            const successCount = statuses.filter((s) => s === 201).length;
            const after = await Presentation.countDocuments({ leadId: leadA._id });
            assert.strictEqual(after - before, successCount, "exactly one new document per successful (201) response, no silent extras or losses");
            if (successCount === 2) {
                assert.notStrictEqual(resA.body.data.version, resB.body.data.version, "two concurrently-successful generations must never share a version number");
            }
        });

        // ── SINGLE GET + CROSS-LEAD ISOLATION ──
        await test("SINGLE GET: fetching V1 by its own lead returns it", async () => {
            const res = mockRes();
            await singleHandler(mockReq({ method: "GET", query: { id: String(leadA._id), presentationId: v1Id }, cookie: agent.cookie }), res);
            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.body.data.id, v1Id);
        });

        await test("CROSS-LEAD ISOLATION: fetching leadA's presentation through leadC's URL -> 404, not leadA's data", async () => {
            const res = mockRes();
            await singleHandler(mockReq({ method: "GET", query: { id: String(leadC._id), presentationId: v1Id }, cookie: agent.cookie }), res);
            assert.strictEqual(res.statusCode, 404);
        });

        await test("CROSS-LEAD ISOLATION: leadC's presentation list is empty despite leadA having versions", async () => {
            const res = mockRes();
            await listHandler(mockReq({ method: "GET", query: { id: String(leadC._id) }, cookie: agent.cookie }), res);
            assert.strictEqual(res.statusCode, 200);
            assert.deepStrictEqual(res.body.data, []);
        });

        await test("CROSS-LEAD ISOLATION: download of leadA's presentation through leadC's URL -> 404", async () => {
            const res = mockRes();
            await downloadHandler(mockReq({ method: "GET", query: { id: String(leadC._id), presentationId: v1Id }, cookie: agent.cookie }), res);
            assert.strictEqual(res.statusCode, 404);
        });

        // ── DOWNLOAD ──
        await test("DOWNLOAD: a READY version streams real .pptx bytes with correct headers", async () => {
            const res = mockRes();
            await downloadHandler(mockReq({ method: "GET", query: { id: String(leadA._id), presentationId: v1Id }, cookie: agent.cookie }), res);
            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.headers["Content-Type"], "application/vnd.openxmlformats-officedocument.presentationml.presentation");
            assert.ok(res.headers["Content-Disposition"].startsWith("attachment;"));
            assert.ok(Buffer.isBuffer(res.endedWith));
            assert.strictEqual(res.endedWith.slice(0, 2).toString("hex"), "504b");
        });

        await test("DOWNLOAD: a FAILED version (no file) -> 404, not a broken/empty download", async () => {
            const failedDoc = await Presentation.create({
                leadId: leadA._id, version: 999, title: "Broken", status: "FAILED", errorMessage: "simulated failure",
                snapshot: { properties: [], recommendedPropertyId: null, recommendationReason: null, notes: null, criteriaSnapshot: null },
                generatedFrom: { accommodationCurationId: null, accommodationCurationUpdatedAt: null },
                createdBy: agent.mongoUser._id,
            });
            const res = mockRes();
            await downloadHandler(mockReq({ method: "GET", query: { id: String(leadA._id), presentationId: String(failedDoc._id) }, cookie: agent.cookie }), res);
            assert.strictEqual(res.statusCode, 404);
        });

        await test("DOWNLOAD: unauthenticated -> 401", async () => {
            const res = mockRes();
            await downloadHandler(mockReq({ method: "GET", query: { id: String(leadA._id), presentationId: v1Id } }), res);
            assert.strictEqual(res.statusCode, 401);
        });

        // ── CLEANUP ──
        await Presentation.deleteMany({ leadId: { $in: createdLeadIds } });
        await AccommodationCuration.deleteMany({ leadId: { $in: createdLeadIds } });
        await Lead.deleteMany({ _id: { $in: createdLeadIds } });
        await User.deleteMany({ _id: { $in: createdUserIds } });
        const remaining = await Presentation.countDocuments({ leadId: { $in: createdLeadIds } });
        assert.strictEqual(remaining, 0, "cleanup must remove every presentation document this run created");
        console.log(`\nCleanup complete. Created during this run: ${createdUserIds.length} users, ${createdLeadIds.length} leads, presentations generated and removed.`);
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
