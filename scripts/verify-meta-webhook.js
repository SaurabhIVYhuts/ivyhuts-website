#!/usr/bin/env node
// Milestone 23.10 — Meta Lead Ads webhook verification.
// Same standalone-Node-script convention as every other scripts/verify-*.js
// in this repo. No real Meta App/credentials exist or are used here — every
// test either configures a FAKE local secret to exercise the real HMAC
// math, or deliberately leaves it unset to prove the fail-closed path.
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
// Never let a real value leak into this test run — every test controls
// these two explicitly per-case.
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

function mockRes() {
    const res = { statusCode: 200, headers: {}, body: undefined, endedWith: undefined };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (body) => { res.body = JSON.parse(JSON.stringify(body)); return res; };
    res.setHeader = (key, value) => { res.headers[key] = value; return res; };
    res.end = (payload) => { res.endedWith = payload; return res; };
    return res;
}

// A minimal fake IncomingMessage: an EventEmitter that emits 'data'/'end'
// for the handler's own readRawBody() to consume, exactly like a real
// Node http request stream would.
function mockPostReq({ bodyBuffer, signature, query = {} }) {
    const req = new EventEmitter();
    req.method = "POST";
    req.query = query;
    req.headers = signature !== undefined ? { "x-hub-signature-256": signature } : {};
    req.destroy = () => {};
    process.nextTick(() => {
        req.emit("data", bodyBuffer);
        req.emit("end");
    });
    return req;
}

function sign(bodyBuffer, secret) {
    return `sha256=${crypto.createHmac("sha256", secret).update(bodyBuffer).digest("hex")}`;
}

function leadgenPayload(overrides = {}) {
    return {
        entry: [
            {
                changes: [
                    {
                        field: "leadgen",
                        value: {
                            leadgen_id: "lg_test_1",
                            form_id: "form_1",
                            ad_id: "ad_1",
                            campaign_id: "camp_1",
                            page_id: "page_1",
                            created_time: 1700000000,
                            field_data: [
                                { name: "full_name", values: ["Priya Sharma"] },
                                { name: "email", values: ["priya@example.test"] },
                                { name: "phone_number", values: ["+919123456780"] },
                            ],
                            ...overrides,
                        },
                    },
                ],
            },
        ],
    };
}

async function main() {
    console.log("=== IvyHuts Meta Webhook Verification (Milestone 23.10) ===");
    console.log("Redis: forced in-memory fallback for this run. No real Meta credentials used anywhere.\n");

    const handler = require(path.join(ROOT, "api", "leads", "meta", "webhook.js"));

    // ══════════════════════ STRUCTURAL ══════════════════════
    await test("STRUCTURAL: no reference to Amber anywhere in this file (comments excluded)", () => {
        const fs = require("fs");
        const stripComments = (src) => src.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
        const src = stripComments(fs.readFileSync(path.join(ROOT, "api", "leads", "meta", "webhook.js"), "utf8"));
        assert.ok(!/\bamber\b/i.test(src));
    });

    await test("STRUCTURAL: bodyParser is disabled for raw-body HMAC verification", () => {
        assert.deepStrictEqual(handler.config, { api: { bodyParser: false } });
    });

    // ══════════════════ PURE: SIGNATURE VERIFICATION ══════════════════
    await test("SIGNATURE: a correctly-signed body verifies true", () => {
        const body = Buffer.from(JSON.stringify({ a: 1 }));
        const sig = sign(body, "test-secret");
        assert.strictEqual(handler.verifySignature(body, sig, "test-secret"), true);
    });
    await test("SIGNATURE: a tampered body fails verification", () => {
        const body = Buffer.from(JSON.stringify({ a: 1 }));
        const sig = sign(body, "test-secret");
        const tampered = Buffer.from(JSON.stringify({ a: 2 }));
        assert.strictEqual(handler.verifySignature(tampered, sig, "test-secret"), false);
    });
    await test("SIGNATURE: wrong secret fails verification", () => {
        const body = Buffer.from(JSON.stringify({ a: 1 }));
        const sig = sign(body, "test-secret");
        assert.strictEqual(handler.verifySignature(body, sig, "different-secret"), false);
    });
    await test("SIGNATURE: missing/malformed header fails verification, never throws", () => {
        const body = Buffer.from(JSON.stringify({ a: 1 }));
        assert.strictEqual(handler.verifySignature(body, undefined, "test-secret"), false);
        assert.strictEqual(handler.verifySignature(body, "not-a-signature", "test-secret"), false);
        assert.strictEqual(handler.verifySignature(body, "sha256=short", "test-secret"), false);
    });

    // ══════════════════ PURE: NORMALIZATION ══════════════════
    await test("NORMALIZE: extracts leadgen_id, contact, and sourceDetails from a real Meta shape", () => {
        const values = handler.extractLeadgenValues(leadgenPayload());
        assert.strictEqual(values.length, 1);
        const normalized = handler.normalizeLeadValue(values[0]);
        assert.strictEqual(normalized.externalLeadId, "lg_test_1");
        assert.strictEqual(normalized.contact.name, "Priya Sharma");
        assert.strictEqual(normalized.contact.email, "priya@example.test");
        assert.strictEqual(normalized.contact.phone, "+919123456780");
        assert.strictEqual(normalized.sourceDetails.formId, "form_1");
        assert.strictEqual(normalized.sourceDetails.campaignId, "camp_1");
    });

    await test("NORMALIZE: a value with no leadgen_id is skipped, never assigned a fabricated id", () => {
        const normalized = handler.normalizeLeadValue({ field_data: [] });
        assert.strictEqual(normalized, null);
    });

    await test("NORMALIZE: an unrecognized field_data name is dropped, never guessed into the wrong bucket", () => {
        const values = handler.extractLeadgenValues(
            leadgenPayload({ field_data: [{ name: "custom_question_1", values: ["some answer"] }] })
        );
        const normalized = handler.normalizeLeadValue(values[0]);
        assert.strictEqual(normalized.contact.name, null);
        assert.strictEqual(normalized.contact.email, null);
    });

    await test("NORMALIZE: extractLeadgenValues tolerates a malformed entry without throwing", () => {
        assert.deepStrictEqual(handler.extractLeadgenValues({}), []);
        assert.deepStrictEqual(handler.extractLeadgenValues({ entry: [{ changes: null }] }), []);
        assert.deepStrictEqual(handler.extractLeadgenValues(null), []);
    });

    // ══════════════════ GET: CHALLENGE VERIFICATION ══════════════════
    await test("GET CHALLENGE: fails closed (503) when META_WEBHOOK_VERIFY_TOKEN is not configured", async () => {
        delete process.env.META_WEBHOOK_VERIFY_TOKEN;
        const res = mockRes();
        await handler({ method: "GET", query: { "hub.mode": "subscribe", "hub.verify_token": "anything", "hub.challenge": "123" } }, res);
        assert.strictEqual(res.statusCode, 503);
    });

    await test("GET CHALLENGE: wrong token is rejected (403) even when configured", async () => {
        process.env.META_WEBHOOK_VERIFY_TOKEN = "real-token";
        const res = mockRes();
        await handler({ method: "GET", query: { "hub.mode": "subscribe", "hub.verify_token": "wrong-token", "hub.challenge": "123" } }, res);
        assert.strictEqual(res.statusCode, 403);
        delete process.env.META_WEBHOOK_VERIFY_TOKEN;
    });

    await test("GET CHALLENGE: correct token + mode echoes the challenge back verbatim", async () => {
        process.env.META_WEBHOOK_VERIFY_TOKEN = "real-token";
        const res = mockRes();
        await handler({ method: "GET", query: { "hub.mode": "subscribe", "hub.verify_token": "real-token", "hub.challenge": "echo-me-123" } }, res);
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.endedWith, "echo-me-123");
        delete process.env.META_WEBHOOK_VERIFY_TOKEN;
    });

    // ══════════════════ POST: FAIL-CLOSED / SIGNATURE (no Mongo needed) ══════════════════
    await test("POST: fails closed (503) when META_APP_SECRET is not configured", async () => {
        delete process.env.META_APP_SECRET;
        const body = Buffer.from(JSON.stringify(leadgenPayload()));
        const res = mockRes();
        await handler(mockPostReq({ bodyBuffer: body, signature: "sha256=irrelevant" }), res);
        assert.strictEqual(res.statusCode, 503);
    });

    await test("POST: invalid signature is rejected (401) even when a secret IS configured", async () => {
        process.env.META_APP_SECRET = "fake-local-secret";
        const body = Buffer.from(JSON.stringify(leadgenPayload()));
        const res = mockRes();
        await handler(mockPostReq({ bodyBuffer: body, signature: "sha256=deadbeef" }), res);
        assert.strictEqual(res.statusCode, 401);
        delete process.env.META_APP_SECRET;
    });

    // ══════════════════ MONGODB-DEPENDENT: END-TO-END DEDUP ══════════════════
    const MONGODB_URI = process.env.MONGODB_URI;
    function getDbNameFromUri(uri) {
        const match = /\/([^/?]+)(\?|$)/.exec(uri.replace(/^mongodb(\+srv)?:\/\//, "mongodb://").split("@").pop());
        return match ? match[1] : "";
    }
    const dbName = MONGODB_URI ? getDbNameFromUri(MONGODB_URI) : "";
    const looksLikeTestDb = /test/i.test(dbName);

    if (!MONGODB_URI) {
        skip("END-TO-END DEDUP (see below)", "MONGODB_URI is not set.");
    } else if (!looksLikeTestDb && process.env.ALLOW_MONGODB_LIVE_TEST !== "true") {
        skip("END-TO-END DEDUP (see below)", `MONGODB_URI points at database "${dbName}", which doesn't look like a test database — refusing to run against it.`);
    } else {
        const { connectToDatabase } = require(path.join(ROOT, "api", "_lib", "mongodb"));
        const Lead = require(path.join(ROOT, "api", "_lib", "models", "Lead"));
        await connectToDatabase();
        console.log("\nMongoDB connection established for live verification.\n");

        const runId = `verify-meta-webhook-${Date.now()}`;
        const secret = "fake-local-secret";
        process.env.META_APP_SECRET = secret;
        const createdLeadIds = [];

        function payloadFor(leadgenId, name) {
            const p = leadgenPayload({ leadgen_id: `${runId}-${leadgenId}`, field_data: [{ name: "full_name", values: [name] }] });
            return Buffer.from(JSON.stringify(p));
        }

        await test("POST E2E: a correctly-signed, valid lead creates exactly one Lead with source=facebook_lead_ads", async () => {
            const body = payloadFor("a", "First Delivery");
            const res = mockRes();
            await handler(mockPostReq({ bodyBuffer: body, signature: sign(body, secret) }), res);
            assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
            assert.strictEqual(res.body.processed, 1);
            const lead = await Lead.findOne({ externalLeadId: `${runId}-a` });
            assert.ok(lead);
            assert.strictEqual(lead.source, "facebook_lead_ads");
            assert.strictEqual(lead.contact.name, "First Delivery");
            createdLeadIds.push(lead._id);
        });

        await test("POST E2E: a redelivery of the SAME externalLeadId never creates a second Lead", async () => {
            const before = await Lead.countDocuments({ externalLeadId: `${runId}-a` });
            const body = payloadFor("a", "First Delivery"); // identical redelivery
            const res = mockRes();
            await handler(mockPostReq({ bodyBuffer: body, signature: sign(body, secret) }), res);
            assert.strictEqual(res.statusCode, 200);
            const after = await Lead.countDocuments({ externalLeadId: `${runId}-a` });
            assert.strictEqual(after, before, "redelivery must not create a duplicate Lead");
            assert.strictEqual(after, 1);
        });

        await test("POST E2E: a redelivery with DIFFERENT field values never overwrites the already-stored Lead", async () => {
            const body = payloadFor("a", "A Different Name Meta Might Resend"); // same externalLeadId, changed name
            const res = mockRes();
            await handler(mockPostReq({ bodyBuffer: body, signature: sign(body, secret) }), res);
            assert.strictEqual(res.statusCode, 200);
            const lead = await Lead.findOne({ externalLeadId: `${runId}-a` });
            assert.strictEqual(lead.contact.name, "First Delivery", "existing Lead data must be preserved on duplicate intake, never overwritten by a redelivery");
        });

        await test("POST E2E: a second, genuinely different externalLeadId creates a second, separate Lead", async () => {
            const body = payloadFor("b", "Second Person");
            const res = mockRes();
            await handler(mockPostReq({ bodyBuffer: body, signature: sign(body, secret) }), res);
            assert.strictEqual(res.statusCode, 200);
            const lead = await Lead.findOne({ externalLeadId: `${runId}-b` });
            assert.ok(lead);
            assert.notStrictEqual(String(lead._id), String((await Lead.findOne({ externalLeadId: `${runId}-a` }))._id));
            createdLeadIds.push(lead._id);
        });

        delete process.env.META_APP_SECRET;

        // ── CLEANUP ──
        await Lead.deleteMany({ _id: { $in: createdLeadIds } });
        const remaining = await Lead.countDocuments({ _id: { $in: createdLeadIds } });
        assert.strictEqual(remaining, 0, "cleanup must remove every Lead this run created");
        console.log(`\nCleanup complete. Created during this run: ${createdLeadIds.length} leads (all removed).`);
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
