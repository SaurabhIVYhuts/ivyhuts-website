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

    await test("NORMALIZE 23.20 (THE COST BUG): 250 EUR/week and 900 EUR/month are NEVER merged into one range, even though both are EUR", () => {
        const summary = buildCostSummary([
            normalizeProperty(validProperty({ rent: 250, currency: "EUR", rentPeriod: "week" })),
            normalizeProperty(validProperty({ rent: 900, currency: "EUR", rentPeriod: "month" })),
        ]);
        assert.strictEqual(summary.groups.length, 2, "same currency but different rent periods must produce TWO separate groups, not one merged range");
        const weekGroup = summary.groups.find((g) => g.rentPeriod === "week");
        const monthGroup = summary.groups.find((g) => g.rentPeriod === "month");
        assert.strictEqual(weekGroup.rangeLabel, "EUR 250", "must never appear as part of a 250-900 range");
        assert.strictEqual(monthGroup.rangeLabel, "EUR 900", "must never appear as part of a 250-900 range");
        assert.strictEqual(summary.unknownCount, 0);
    });

    await test("NORMALIZE 23.20: a property with a genuinely unknown rent period is excluded from every range (counted, never guessed into a group)", () => {
        const summary = buildCostSummary([
            normalizeProperty(validProperty({ rent: 250, currency: "EUR", rentPeriod: "week" })),
            normalizeProperty(validProperty({ rent: 500, currency: "EUR", rentPeriod: "unknown" })),
        ]);
        assert.strictEqual(summary.groups.length, 1);
        assert.strictEqual(summary.groups[0].rangeLabel, "EUR 250");
        assert.strictEqual(summary.unknownCount, 1, "the unknown-period property must be excluded from the range, not silently merged in");
    });

    await test("NORMALIZE 23.20: the same currency+period across multiple properties still ranges correctly", () => {
        const summary = buildCostSummary([
            normalizeProperty(validProperty({ rent: 150, currency: "GBP", rentPeriod: "week" })),
            normalizeProperty(validProperty({ rent: 250, currency: "GBP", rentPeriod: "week" })),
            normalizeProperty(validProperty({ rent: 200, currency: "GBP", rentPeriod: "week" })),
        ]);
        assert.strictEqual(summary.groups.length, 1);
        assert.strictEqual(summary.groups[0].rangeLabel, "GBP 150 – GBP 250");
        assert.strictEqual(summary.groups[0].count, 3);
    });

    // ══════════════════ NORMALIZE — Milestone 23.18 personalization ══════════════════
    await test("NORMALIZE 23.18: Discovery wins over criteriaSnapshot for university/budget/sharing when both exist", () => {
        const normalized = normalizeAccommodationCurationForPresentation(
            { properties: [], criteriaSnapshot: validCriteriaSnapshot({ budgetMin: 999, budgetMax: 999 }), recommendedPropertyId: null, recommendationReason: null },
            {
                studentName: "Test Student", title: "t",
                discovery: {
                    student: { university: "Discovery University", universityResolved: null, course: "MSc Data Science", intake: "Sept 2026" },
                    accommodation: { budgetMin: 150, budgetMax: 250, currency: "GBP", moveInDate: "2026-09-01", stayDurationMonths: 10, preferredLocation: "City centre", roomPreference: "Ensuite", sharing: 2, distancePreference: "Walking distance" },
                    priorities: ["budget", "distance"], notes: "Prefers quiet building.",
                },
            }
        );
        assert.strictEqual(normalized.university.name, "Discovery University");
        assert.strictEqual(normalized.requirements.budgetLabel, "GBP 150 – GBP 250");
        assert.strictEqual(normalized.requirements.courseLabel, "MSc Data Science");
        assert.strictEqual(normalized.requirements.intakeLabel, "Sept 2026");
        assert.strictEqual(normalized.requirements.preferredLocationLabel, "City centre");
        assert.strictEqual(normalized.requirements.roomPreferenceLabel, "Ensuite");
        assert.strictEqual(normalized.requirements.distancePreferenceLabel, "Walking distance");
        assert.deepStrictEqual(normalized.requirements.priorities, ["Budget", "Distance to campus"]);
    });

    await test("NORMALIZE 23.18: falls back to criteriaSnapshot when Discovery is null (legacy curation)", () => {
        const normalized = normalizeAccommodationCurationForPresentation(
            { properties: [], criteriaSnapshot: validCriteriaSnapshot(), recommendedPropertyId: null, recommendationReason: null },
            { studentName: "Test Student", title: "t", discovery: null }
        );
        assert.strictEqual(normalized.university.name, "University of Hertfordshire");
        assert.strictEqual(normalized.requirements.budgetLabel, "GBP 150 – GBP 250");
        assert.strictEqual(normalized.requirements.courseLabel, NOT_AVAILABLE, "criteriaSnapshot has no course field — must never be invented");
    });

    await test("NORMALIZE 23.18: a genuinely unconfirmed field renders the literal 'Not available', never invented", () => {
        const normalized = normalizeAccommodationCurationForPresentation(
            { properties: [], criteriaSnapshot: null, recommendedPropertyId: null, recommendationReason: null },
            { studentName: null, title: "t", discovery: { student: { university: null, universityResolved: null, course: null, intake: null }, accommodation: { budgetMin: null, budgetMax: null, currency: null, moveInDate: null, stayDurationMonths: null, preferredLocation: null, roomPreference: null, sharing: null, distancePreference: null }, priorities: [], notes: null } }
        );
        assert.strictEqual(normalized.university.available, false);
        assert.strictEqual(normalized.requirements.budgetLabel, NOT_AVAILABLE);
        assert.strictEqual(normalized.requirements.roomPreferenceLabel, NOT_AVAILABLE);
        assert.strictEqual(normalized.student.name, null, "no fabricated client name when contact.name is genuinely absent");
    });

    await test("NORMALIZE 23.18: buildMatchEvidence never claims a match the data can't support (missing on either side)", () => {
        const { buildMatchEvidence, normalizeProperty } = require(path.join(ROOT, "api", "_lib", "pptNormalizeAccommodation"));
        const p = normalizeProperty(validProperty({ sharing: null, distanceFromUniversityKm: null }));
        const evidence = buildMatchEvidence(p, { available: true, budgetMinRaw: null, budgetMaxRaw: null, currencyRaw: null, sharingRaw: 2, distancePreferenceKm: 1, budgetLabel: NOT_AVAILABLE });
        assert.ok(!evidence.some((e) => e.toLowerCase().includes("budget")), "no budget evidence when either side lacks the number");
        assert.ok(!evidence.some((e) => e.toLowerCase().includes("sharing")), "no sharing evidence when the PROPERTY's own sharing is unknown, even though the requirement is known");
    });

    await test("NORMALIZE 23.18: buildMatchEvidence refuses a cross-currency budget match", () => {
        const { buildMatchEvidence, normalizeProperty } = require(path.join(ROOT, "api", "_lib", "pptNormalizeAccommodation"));
        const p = normalizeProperty(validProperty({ rent: 200, rentPerWeek: 200, currency: "USD" }));
        const evidence = buildMatchEvidence(p, { available: true, budgetMinRaw: 150, budgetMaxRaw: 250, currencyRaw: "GBP", budgetLabel: "GBP 150 – GBP 250", sharingRaw: null, distancePreferenceKm: null });
        assert.ok(!evidence.some((e) => e.toLowerCase().includes("budget")), "USD 200 is numerically inside 150-250 but GBP != USD — must never claim a match across currencies");
    });

    await test("STRUCTURAL 23.18: property ordering follows the saved curation's own array order (never re-ranked)", () => {
        const normalized = normalizeAccommodationCurationForPresentation(
            {
                properties: [validProperty({ propertyId: "c", providerPropertyId: "c" }), validProperty({ propertyId: "a", providerPropertyId: "a" }), validProperty({ propertyId: "b", providerPropertyId: "b" })],
                criteriaSnapshot: null, recommendedPropertyId: null, recommendationReason: null,
            },
            { studentName: "Test Student", title: "t" }
        );
        assert.deepStrictEqual(normalized.properties.map((p) => p.propertyId), ["c", "a", "b"], "must preserve curation order, never sort alphabetically");
    });

    await test("STRUCTURAL 23.18: neither normalizer nor builder reads Meeting.extractedRequirements directly", () => {
        const fs = require("fs");
        const src1 = fs.readFileSync(path.join(ROOT, "api", "_lib", "pptNormalizeAccommodation.js"), "utf8");
        const src2 = fs.readFileSync(path.join(ROOT, "api", "_lib", "pptBuilderAccommodation.js"), "utf8");
        const src3 = fs.readFileSync(path.join(ROOT, "api", "leads", "[id]", "presentations", "index.js"), "utf8");
        assert.ok(!src1.includes("extractedRequirements"));
        assert.ok(!src2.includes("extractedRequirements"));
        assert.ok(!src3.includes("extractedRequirements"), "the presentation route must fetch confirmed Discovery only, never a meeting's pending suggestion");
    });

    await test("STRUCTURAL 23.18: no reference-deck (Rajdev/Dubai/UOWD/Amber/AED) content OUTSIDE explanatory comments — same stripComments convention as the file's own 'no Amber' check above", () => {
        const fs = require("fs");
        const stripComments = (src) => src.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
        const src = stripComments(fs.readFileSync(path.join(ROOT, "api", "_lib", "pptBuilderAccommodation.js"), "utf8")) + stripComments(fs.readFileSync(path.join(ROOT, "api", "_lib", "pptNormalizeAccommodation.js"), "utf8"));
        ["Rajdev", "Dubai", "UOWD", "AED", "Makaan", "Al Sufouh", "Staybridge"].forEach((term) => {
            assert.ok(!src.includes(term), `reference-deck example content "${term}" must never leak into actual generator LOGIC (mentioning it in a comment explaining what was studied is fine) — the reference is a design study, not a data source`);
        });
    });

    // ══════════════════ Milestone 23.19 — dynamic slide count / reference-design audit (pure) ══════════════════
    await test("STRUCTURAL 23.19: slide count adapts to the number of curated properties (1 vs 3), never a fixed template", async () => {
        const { generateAccommodationPresentationPptxBuffer } = require(path.join(ROOT, "api", "_lib", "pptBuilderAccommodation"));
        const JSZip = require("jszip");

        async function slideCount(propertyCount) {
            const properties = Array.from({ length: propertyCount }, (_, i) => validProperty({ propertyId: `uhomes:id:p${i}`, providerPropertyId: `p${i}`, name: `Property ${i}` }));
            const normalized = normalizeAccommodationCurationForPresentation(
                { properties, criteriaSnapshot: validCriteriaSnapshot(), recommendedPropertyId: properties[0].propertyId, recommendationReason: "test" },
                { studentName: "Slide Count Student", title: "t" }
            );
            const buffer = await generateAccommodationPresentationPptxBuffer(normalized);
            const zip = await JSZip.loadAsync(buffer);
            return Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f)).length;
        }

        // cover + requirements + N property slides + comparison + recommendation + cost + why-ivyhuts + closing
        assert.strictEqual(await slideCount(1), 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1);
        assert.strictEqual(await slideCount(3), 1 + 1 + 3 + 1 + 1 + 1 + 1 + 1);
        const zeroNormalized = normalizeAccommodationCurationForPresentation({ properties: [], criteriaSnapshot: null, recommendedPropertyId: null, recommendationReason: null }, { studentName: "Zero", title: "t" });
        const zeroBuffer = await generateAccommodationPresentationPptxBuffer(zeroNormalized);
        const zeroZip = await new (require("jszip"))().loadAsync(zeroBuffer);
        // cover + requirements + (no properties => no comparison/recommendation) + cost + why-ivyhuts + closing
        assert.strictEqual(Object.keys(zeroZip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f)).length, 1 + 1 + 1 + 1 + 1);
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
        const Discovery = require(path.join(ROOT, "api", "_lib", "models", "Discovery"));
        const Meeting = require(path.join(ROOT, "api", "_lib", "models", "Meeting"));
        const accommodationCurationHandler = require(path.join(ROOT, "api", "leads", "[id]", "accommodation-curation.js"));
        const discoveryHandler = require(path.join(ROOT, "api", "leads", "[id]", "discovery.js"));
        const meetingsListHandler = require(path.join(ROOT, "api", "leads", "[id]", "meetings", "index.js"));
        const extractRequirementsHandler = require(path.join(ROOT, "api", "leads", "[id]", "meetings", "[meetingId]", "extract-requirements.js"));
        const transcriptExtraction = require(path.join(ROOT, "api", "_lib", "transcriptExtraction"));

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

        // ══════════════════ Milestone 23.21 — VERSION TRACEABILITY (via the real, CRM-facing API) ══════════════════
        // The tests above already prove the RAW Mongoose document's
        // snapshot never mutates. This section proves the same thing
        // through the actual API SHAPE the CRM consumes (toSafePresentation's
        // new `properties` field) — the exact claim Milestone 23.21 exists
        // to prove: "the properties displayed for Presentation V1 are the
        // exact historical properties used when V1 was generated, even
        // after the current curation changes."
        const leadG = await createLead("g-version-traceability");
        let g1Id, g2Id;
        await test("SETUP: leadG's V1 is generated from a ONE-property curation", async () => {
            await saveCuration(leadG._id, agent.cookie, {
                properties: [validProperty({ propertyId: "uhomes:id:g1", providerPropertyId: "g1", name: "Original Property" })],
                recommendedPropertyId: "uhomes:id:g1",
            });
            const res = mockRes();
            await listHandler(mockReq({ method: "POST", query: { id: String(leadG._id) }, cookie: agent.cookie, body: { title: "V1" } }), res);
            assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
            g1Id = res.body.data.id;
            assert.strictEqual(res.body.data.properties.length, 1);
            assert.strictEqual(res.body.data.properties[0].propertyId, "uhomes:id:g1");
            assert.strictEqual(res.body.data.properties[0].name, "Original Property");
        });

        await test("VERSION TRACEABILITY: after the curation grows to THREE different properties and V2 is generated, V1's API-exposed property list is completely unchanged", async () => {
            // The curation is now completely replaced with 3 NEW properties —
            // none of them share a propertyId with V1's own property.
            await saveCuration(leadG._id, agent.cookie, {
                properties: [
                    validProperty({ propertyId: "uhomes:id:g2", providerPropertyId: "g2", name: "New Property A" }),
                    validProperty({ propertyId: "uhomes:id:g3", providerPropertyId: "g3", name: "New Property B" }),
                    validProperty({ propertyId: "uhomes:id:g4", providerPropertyId: "g4", name: "New Property C", roomType: null, rent: null, currency: null }),
                ],
                recommendedPropertyId: "uhomes:id:g2",
            });

            // V1, fetched fresh through the real GET (not a cached reference):
            const v1Res = mockRes();
            await singleHandler(mockReq({ method: "GET", query: { id: String(leadG._id), presentationId: g1Id }, cookie: agent.cookie }), v1Res);
            assert.strictEqual(v1Res.statusCode, 200);
            assert.strictEqual(v1Res.body.data.properties.length, 1, "V1 must still show exactly ONE property — the live curation growing to 3 must never leak into it");
            assert.strictEqual(v1Res.body.data.properties[0].propertyId, "uhomes:id:g1");
            assert.strictEqual(v1Res.body.data.properties[0].name, "Original Property");

            // Now generate V2 — it must reflect the NEW 3-property curation.
            const v2Res = mockRes();
            await listHandler(mockReq({ method: "POST", query: { id: String(leadG._id) }, cookie: agent.cookie, body: { title: "V2" } }), v2Res);
            assert.strictEqual(v2Res.statusCode, 201, JSON.stringify(v2Res.body));
            g2Id = v2Res.body.data.id;
            assert.strictEqual(v2Res.body.data.properties.length, 3, "V2 must reflect the curation as it stood AT V2's OWN generation time");
            assert.deepStrictEqual(v2Res.body.data.properties.map((p) => p.propertyId), ["uhomes:id:g2", "uhomes:id:g3", "uhomes:id:g4"], "identity must be propertyId, in curation order — never re-sorted, never by name");

            // Honest missing-metadata handling — "New Property C" has no
            // roomType/rent/currency in the curation; the API must expose
            // that honestly (null), never a fabricated placeholder.
            const propertyC = v2Res.body.data.properties.find((p) => p.propertyId === "uhomes:id:g4");
            assert.strictEqual(propertyC.roomType, null);
            assert.strictEqual(propertyC.rent, null);
            assert.strictEqual(propertyC.currency, null);

            // V1 fetched AGAIN, after V2 now exists — still completely unchanged.
            const v1AfterV2 = mockRes();
            await singleHandler(mockReq({ method: "GET", query: { id: String(leadG._id), presentationId: g1Id }, cookie: agent.cookie }), v1AfterV2);
            assert.strictEqual(v1AfterV2.body.data.properties.length, 1);
            assert.strictEqual(v1AfterV2.body.data.properties[0].propertyId, "uhomes:id:g1");
        });

        await test("VERSION TRACEABILITY: the list endpoint shows BOTH versions, each with its own distinct, historically-accurate property list", async () => {
            const res = mockRes();
            await listHandler(mockReq({ method: "GET", query: { id: String(leadG._id) }, cookie: agent.cookie }), res);
            assert.strictEqual(res.statusCode, 200);
            const v1 = res.body.data.find((p) => p.id === g1Id);
            const v2 = res.body.data.find((p) => p.id === g2Id);
            assert.strictEqual(v1.properties.length, 1);
            assert.strictEqual(v2.properties.length, 3);
            assert.notDeepStrictEqual(v1.properties.map((p) => p.propertyId), v2.properties.map((p) => p.propertyId));
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

        // ══════════════════ Milestone 23.18 — PERSONALIZATION (real handlers, real DB) ══════════════════
        const leadD = await createLead("d-personalization");
        await test("SETUP: confirm Discovery manually for leadD, then save a matching curation", async () => {
            const discoveryRes = mockRes();
            await discoveryHandler(
                mockReq({
                    method: "PUT", query: { id: String(leadD._id) }, cookie: agent.cookie,
                    body: {
                        student: { university: "University of Hertfordshire", course: "MSc Data Science", intake: "September 2026" },
                        accommodation: { budgetMin: 150, budgetMax: 250, currency: "GBP", moveInDate: "2026-09-01", stayDurationMonths: 10, preferredLocation: "City centre", roomPreference: "Ensuite", sharing: 2, distancePreference: "Walking distance to campus" },
                        priorities: ["budget", "distance"], notes: "Prefers a quiet building.",
                        requirementSources: { university: "agent", budget: "agent", sharing: "agent" },
                    },
                }),
                discoveryRes
            );
            assert.strictEqual(discoveryRes.statusCode, 200, JSON.stringify(discoveryRes.body));
            await saveCuration(leadD._id, agent.cookie);
        });

        let manualPresentationSnapshot;
        await test("PERSONALIZATION (manual Discovery): generated presentation's stored discoverySnapshot matches confirmed Discovery exactly", async () => {
            const res = mockRes();
            await listHandler(mockReq({ method: "POST", query: { id: String(leadD._id) }, cookie: agent.cookie, body: { title: "Personalized" } }), res);
            assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
            const stored = await Presentation.findOne({ _id: res.body.data.id });
            assert.strictEqual(stored.snapshot.discoverySnapshot.university, "University of Hertfordshire");
            assert.strictEqual(stored.snapshot.discoverySnapshot.course, "MSc Data Science");
            assert.strictEqual(stored.snapshot.discoverySnapshot.budgetMin, 150);
            assert.strictEqual(stored.snapshot.discoverySnapshot.sharing, 2);
            assert.strictEqual(stored.snapshot.discoverySnapshot.roomPreference, "Ensuite");
            assert.strictEqual(stored.snapshot.discoverySnapshot.moveInDate, "2026-09-01");
            assert.deepStrictEqual(stored.snapshot.discoverySnapshot.priorities, ["budget", "distance"]);
            assert.ok(stored.generatedFrom.discoveryId, "generatedFrom must record which Discovery this deck was personalized from");

            const discovery = await Discovery.findOne({ leadId: leadD._id });
            assert.strictEqual(String(stored.generatedFrom.discoveryId), String(discovery._id));
            assert.strictEqual(new Date(stored.generatedFrom.discoveryUpdatedAt).getTime(), new Date(discovery.updatedAt).getTime());

            manualPresentationSnapshot = stored.snapshot;

            // Rendered-text proof (Part 21 — "inspect the pptx XML/content
            // programmatically" since visual PPT rendering isn't available
            // in this environment): unzip the real generated bytes and
            // confirm the client's name/university/budget actually appear
            // as real text in the deck, not just in the JSON snapshot.
            const JSZip = require("jszip");
            const zip = await JSZip.loadAsync(stored.file.data);
            const slideTexts = await Promise.all(
                Object.keys(zip.files)
                    .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
                    .map((f) => zip.files[f].async("string"))
            );
            const allText = slideTexts.join(" ");
            assert.ok(allText.includes("Test Lead d-personalization"), "client name must appear as real rendered text");
            assert.ok(allText.includes("University of Hertfordshire"), "university must appear as real rendered text");
            assert.ok(allText.includes("150") && allText.includes("250"), "confirmed budget figures must appear as real rendered text");
            assert.ok(!/\bundefined\b|\bNaN\b|\[object Object\]/.test(allText), "no undefined/NaN/[object Object] may ever appear in rendered slide text");
        });

        await test("NO-FABRICATION (real generated bytes): the reference deck's own example content never appears in a REAL client's generated presentation", async () => {
            const JSZip = require("jszip");
            const v1 = await Presentation.findOne({ leadId: leadD._id, version: 1 });
            const zip = await JSZip.loadAsync(v1.file.data);
            const slideTexts = await Promise.all(
                Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f)).map((f) => zip.files[f].async("string"))
            );
            const allText = slideTexts.join(" ");
            ["Rajdev", "Dubai", "UOWD", "AED", "Makaan", "Al Sufouh", "Staybridge"].forEach((term) => {
                assert.ok(!allText.includes(term), `reference-deck example content "${term}" must never appear in a real generated presentation`);
            });
        });

        await test("DYNAMIC PROPERTY COUNT (real DB flow): saving 3 properties and generating produces a deck with 3 property slides worth of real content", async () => {
            const leadF = await createLead("f-three-properties");
            await saveCuration(leadF._id, agent.cookie, {
                properties: [
                    validProperty({ propertyId: "uhomes:id:f1", providerPropertyId: "f1", name: "Northgate House" }),
                    validProperty({ propertyId: "uhomes:id:f2", providerPropertyId: "f2", name: "Riverside Court" }),
                    validProperty({ propertyId: "uhomes:id:f3", providerPropertyId: "f3", name: "Campus View Studios" }),
                ],
                recommendedPropertyId: "uhomes:id:f1",
            });
            const res = mockRes();
            await listHandler(mockReq({ method: "POST", query: { id: String(leadF._id) }, cookie: agent.cookie, body: { title: "Three Properties" } }), res);
            assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
            const stored = await Presentation.findOne({ _id: res.body.data.id });
            assert.strictEqual(stored.snapshot.properties.length, 3, "no property may be added or dropped during generation — exactly the 3 saved must appear");
            assert.deepStrictEqual(stored.snapshot.properties.map((p) => p.name), ["Northgate House", "Riverside Court", "Campus View Studios"], "must preserve curation order");

            const JSZip = require("jszip");
            const zip = await JSZip.loadAsync(stored.file.data);
            const slideFiles = Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f));
            assert.strictEqual(slideFiles.length, 1 + 1 + 3 + 1 + 1 + 1 + 1 + 1, "cover+requirements+3 property slides+comparison+recommendation+cost+why-ivyhuts+closing");
            const allText = (await Promise.all(slideFiles.map((f) => zip.files[f].async("string")))).join(" ");
            ["Northgate House", "Riverside Court", "Campus View Studios"].forEach((name) => assert.ok(allText.includes(name), `${name} must appear as real rendered text`));
        });

        // ══════════════════ Milestone 23.18 Part 22/23 — TRANSCRIPT-CONFIRMED REQUIREMENTS ══════════════════
        // Proves the architectural invariant Part 23 requires: manual
        // Discovery confirmation (Flow A, leadD above) and transcript ->
        // extraction -> agent-confirmation (Flow B, leadE here) must
        // produce the SAME canonical presentation data contract once both
        // are confirmed into Discovery — the source of a Discovery value
        // must never matter downstream.
        const leadE = await createLead("e-transcript-confirmed");
        let meetingId;
        await test("SETUP: leadE gets a meeting with a transcript and a PENDING (deterministic-fake) extraction", async () => {
            const meetingRes = mockRes();
            await meetingsListHandler(mockReq({ method: "POST", query: { id: String(leadE._id) }, cookie: manager.cookie, body: { scheduledAt: new Date().toISOString() } }), meetingRes);
            assert.strictEqual(meetingRes.statusCode, 201, JSON.stringify(meetingRes.body));
            meetingId = meetingRes.body.data.id;
            await Meeting.updateOne({ _id: meetingId }, { $set: { status: "completed", transcriptText: "Agent: Which university? Student: University of Hertfordshire, MSc Data Science, September 2026. Budget 150 to 250 GBP, ensuite, 2 sharing, walking distance to campus." } });

            const originalConfigured = transcriptExtraction.isTranscriptExtractionConfigured;
            const originalExtract = transcriptExtraction.extractRequirementsFromTranscript;
            transcriptExtraction.isTranscriptExtractionConfigured = () => true;
            transcriptExtraction.extractRequirementsFromTranscript = async () => ({
                university: "University of Hertfordshire", course: "MSc Data Science", intake: "September 2026",
                budgetMin: 150, budgetMax: 250, currency: "GBP", moveInDate: "2026-09-01", stayDurationMonths: 10,
                preferredLocation: "City centre", roomPreference: "Ensuite", sharing: 2, distancePreference: "Walking distance to campus",
                priorities: ["budget", "distance"], notes: "Prefers a quiet building.",
            });
            const extractPath = require.resolve(path.join(ROOT, "api", "leads", "[id]", "meetings", "[meetingId]", "extract-requirements.js"));
            delete require.cache[extractPath];
            try {
                const patchedHandler = require(extractPath);
                const res = mockRes();
                await patchedHandler(mockReq({ method: "POST", query: { id: String(leadE._id), meetingId }, cookie: agent.cookie }), res);
                assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
                assert.strictEqual(res.body.data.extractedRequirements.status, "pending_review");
            } finally {
                transcriptExtraction.isTranscriptExtractionConfigured = originalConfigured;
                transcriptExtraction.extractRequirementsFromTranscript = originalExtract;
                delete require.cache[extractPath];
                require(extractPath);
            }
        });

        await test("PART 22: a PENDING (unconfirmed) extraction never appears in a generated presentation — Discovery is still empty", async () => {
            await saveCuration(leadE._id, agent.cookie);
            const res = mockRes();
            await listHandler(mockReq({ method: "POST", query: { id: String(leadE._id) }, cookie: agent.cookie, body: { title: "Before confirmation" } }), res);
            assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
            const stored = await Presentation.findOne({ _id: res.body.data.id });
            assert.strictEqual(stored.snapshot.discoverySnapshot, null, "no Discovery exists yet for leadE — a pending transcript suggestion must never be read as if it were confirmed");
        });

        await test("PART 22: agent confirms the transcript suggestion into Discovery via the existing PUT /discovery — never auto-applied", async () => {
            const res = mockRes();
            await discoveryHandler(
                mockReq({
                    method: "PUT", query: { id: String(leadE._id) }, cookie: agent.cookie,
                    body: {
                        student: { university: "University of Hertfordshire", course: "MSc Data Science", intake: "September 2026" },
                        accommodation: { budgetMin: 150, budgetMax: 250, currency: "GBP", moveInDate: "2026-09-01", stayDurationMonths: 10, preferredLocation: "City centre", roomPreference: "Ensuite", sharing: 2, distancePreference: "Walking distance to campus" },
                        priorities: ["budget", "distance"], notes: "Prefers a quiet building.",
                        requirementSources: { university: "transcript", budget: "transcript", sharing: "transcript" },
                    },
                }),
                res
            );
            assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
        });

        await test("PART 23: manual-confirmation (Flow A) and transcript-confirmation (Flow B) produce the IDENTICAL presentation data contract once both are confirmed into Discovery", async () => {
            const res = mockRes();
            await listHandler(mockReq({ method: "POST", query: { id: String(leadE._id) }, cookie: agent.cookie, body: { title: "After confirmation" } }), res);
            assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
            const stored = await Presentation.findOne({ _id: res.body.data.id });
            const flowB = stored.snapshot.discoverySnapshot;
            const flowA = manualPresentationSnapshot.discoverySnapshot;
            // Compare every personalization field — the SOURCE (manual typing
            // vs transcript + agent confirmation) must be invisible to the
            // presentation layer once both are confirmed Discovery.
            ["university", "course", "intake", "budgetMin", "budgetMax", "currency", "moveInDate", "stayDurationMonths", "preferredLocation", "roomPreference", "sharing", "distancePreference", "notes"].forEach((key) => {
                assert.strictEqual(flowB[key], flowA[key], `field "${key}" must match between Flow A (manual) and Flow B (transcript-confirmed) — the canonical Discovery contract is source-agnostic`);
            });
            assert.deepStrictEqual(flowB.priorities, flowA.priorities);
        });

        // ── CLEANUP ──
        await Discovery.deleteMany({ leadId: { $in: createdLeadIds } });
        await Meeting.deleteMany({ leadId: { $in: createdLeadIds } });
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
