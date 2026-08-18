#!/usr/bin/env node
// Milestone 23.3 — CRM <-> backend CORS/session foundation verification.
// Same standalone-Node-script convention as every other scripts/verify-*.js
// in this repo (Jest is broken repo-wide for an unrelated pre-existing
// reason — see scripts/verify-auth-backend.js's own header comment).
//
// Deliberately does NOT load .env.local/.env (same reasoning as
// verify-auth-backend.js) — runs against sharedStore's in-memory fallback,
// never the real production Upstash Redis instance. CRM_ORIGIN is left
// unset so these tests exercise the documented default
// (http://localhost:3000) rather than whatever a real .env happens to
// contain.
"use strict";

const assert = require("assert");
const path = require("path");
const ROOT = path.join(__dirname, "..");

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

function mockReq({ method = "GET", origin, body, cookie } = {}) {
    const headers = {};
    if (origin !== undefined) headers.origin = origin;
    if (cookie) headers.cookie = cookie;
    return { method, headers, body, query: {}, socket: { remoteAddress: "127.0.0.1" } };
}

function mockRes() {
    const res = { statusCode: 200, headers: {}, body: undefined, ended: false };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (body) => { res.body = body; return res; };
    res.setHeader = (key, value) => { res.headers[key] = value; return res; };
    res.end = () => { res.ended = true; return res; };
    return res;
}

async function main() {
    console.log("=== IvyHuts CRM <-> Backend CORS Verification (Milestone 23.3) ===\n");

    const { withCors, DEFAULT_DEV_ORIGIN, ALLOWED_METHODS, ALLOWED_HEADERS } = require(path.join(ROOT, "api", "_lib", "cors"));
    const loginHandler = require(path.join(ROOT, "api", "auth", "login"));
    const userStore = require(path.join(ROOT, "api", "_lib", "userStore"));

    const TRUSTED_ORIGIN = DEFAULT_DEV_ORIGIN; // no CRM_ORIGIN set -> default applies
    const EVIL_ORIGIN = "https://evil.example.com";

    // ═══════════════════════ 1. TRUSTED CRM ORIGIN ═══════════════════════
    await test("1. trusted CRM origin: Access-Control-Allow-Origin echoes it back exactly", () => {
        const req = mockReq({ method: "GET", origin: TRUSTED_ORIGIN });
        const res = mockRes();
        const stopped = withCors(req, res);
        assert.strictEqual(stopped, false, "a non-OPTIONS request must not be short-circuited");
        assert.strictEqual(res.headers["Access-Control-Allow-Origin"], TRUSTED_ORIGIN);
        assert.strictEqual(res.headers["Vary"], "Origin", "must vary the cache on Origin — this response differs per caller");
    });

    // ═══════════════════════ 2. EVIL ORIGIN ═══════════════════════
    await test("2. evil/untrusted origin: no CORS headers are set at all", () => {
        const req = mockReq({ method: "GET", origin: EVIL_ORIGIN });
        const res = mockRes();
        withCors(req, res);
        assert.strictEqual(res.headers["Access-Control-Allow-Origin"], undefined, "an untrusted origin must never be echoed back");
        assert.strictEqual(res.headers["Access-Control-Allow-Credentials"], undefined);
    });

    // ═══════════════════════ 3. NO ORIGIN HEADER ═══════════════════════
    await test("3. no Origin header (same-origin/curl/server-to-server): no CORS headers, request proceeds normally", () => {
        const req = mockReq({ method: "GET" });
        const res = mockRes();
        const stopped = withCors(req, res);
        assert.strictEqual(stopped, false);
        assert.strictEqual(res.headers["Access-Control-Allow-Origin"], undefined);
    });

    // ═══════════════════════ 4. OPTIONS PREFLIGHT ═══════════════════════
    await test("4. OPTIONS preflight from a trusted origin: 204, no body, Allow-Methods/Allow-Headers set", () => {
        const req = mockReq({ method: "OPTIONS", origin: TRUSTED_ORIGIN });
        const res = mockRes();
        const stopped = withCors(req, res);
        assert.strictEqual(stopped, true, "OPTIONS must be fully handled by withCors, never reach real handler logic");
        assert.strictEqual(res.statusCode, 204);
        assert.ok(res.ended, "response must be ended, never left hanging");
        assert.strictEqual(res.body, undefined, "a 204 must carry no body");
        assert.ok(res.headers["Access-Control-Allow-Methods"].includes("GET"));
        assert.ok(res.headers["Access-Control-Allow-Headers"].includes("Content-Type"));
    });

    await test("4b. OPTIONS preflight from an untrusted origin: still 204 (browser blocks it client-side via the missing Allow-Origin header, not a bespoke 403)", () => {
        const req = mockReq({ method: "OPTIONS", origin: EVIL_ORIGIN });
        const res = mockRes();
        withCors(req, res);
        assert.strictEqual(res.statusCode, 204);
        assert.strictEqual(res.headers["Access-Control-Allow-Origin"], undefined);
    });

    // ═══════════════════════ 5. CREDENTIALED REQUEST ═══════════════════════
    await test("5. credentialed request: Allow-Credentials is 'true', and Allow-Origin is NEVER '*' when credentials are involved", () => {
        const req = mockReq({ method: "GET", origin: TRUSTED_ORIGIN });
        const res = mockRes();
        withCors(req, res);
        assert.strictEqual(res.headers["Access-Control-Allow-Credentials"], "true");
        assert.notStrictEqual(res.headers["Access-Control-Allow-Origin"], "*", "wildcard + credentials is exactly the combination this module exists to prevent");
    });

    // ═══════════════════════ 6/7. AUTH FAILURE / SUCCESS THROUGH CORS ═══════════════════════
    const suffix = Date.now();
    const testEmail = `verify-cors-${suffix}@example.test`;
    const testPassword = "correct-horse-battery-staple";
    await userStore.createUser({ name: "CORS Test User", email: testEmail, password: testPassword, phone: "+91 98765 43210" });

    await test("6. authentication failure (wrong password) from a trusted origin: 401, but CORS headers are still present", async () => {
        const req = mockReq({ method: "POST", origin: TRUSTED_ORIGIN, body: { email: testEmail, password: "wrong-password" } });
        const res = mockRes();
        await loginHandler(req, res);
        assert.strictEqual(res.statusCode, 401);
        assert.strictEqual(res.headers["Access-Control-Allow-Origin"], TRUSTED_ORIGIN, "CORS must apply before/regardless of auth outcome, or the browser hides even the 401 body from the CRM");
    });

    await test("7. authentication success from a trusted origin: 200, session cookie set, CORS headers present", async () => {
        const req = mockReq({ method: "POST", origin: TRUSTED_ORIGIN, body: { email: testEmail, password: testPassword } });
        const res = mockRes();
        await loginHandler(req, res);
        assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
        assert.ok(res.headers["Set-Cookie"] && res.headers["Set-Cookie"].startsWith("ivyhuts_session="));
        assert.strictEqual(res.headers["Access-Control-Allow-Origin"], TRUSTED_ORIGIN);
        assert.strictEqual(res.headers["Access-Control-Allow-Credentials"], "true");
    });

    // ═══════════════════════ 8. PUT ═══════════════════════
    await test("8. PUT is an allowed method (advertised on preflight, and a real PUT request still gets CORS headers set)", () => {
        const preflight = mockReq({ method: "OPTIONS", origin: TRUSTED_ORIGIN });
        const preflightRes = mockRes();
        withCors(preflight, preflightRes);
        assert.ok(preflightRes.headers["Access-Control-Allow-Methods"].includes("PUT"));

        const putReq = mockReq({ method: "PUT", origin: TRUSTED_ORIGIN });
        const putRes = mockRes();
        const stopped = withCors(putReq, putRes);
        assert.strictEqual(stopped, false, "a real PUT request is not a preflight and must reach the real handler");
        assert.strictEqual(putRes.headers["Access-Control-Allow-Origin"], TRUSTED_ORIGIN);
    });

    // ═══════════════════════ 9. IDEMPOTENCY-KEY ═══════════════════════
    await test("9. Idempotency-Key: confirmed NOT required — no such mechanism exists anywhere in this backend (grepped repo-wide before writing cors.js); ALLOWED_HEADERS stays minimal", () => {
        assert.deepStrictEqual(ALLOWED_HEADERS, ["Content-Type"], "only add a header here when a real caller actually needs it — see cors.js's own comment");
    });

    console.log(`\n${passed} passed, ${failed} failed`);
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
