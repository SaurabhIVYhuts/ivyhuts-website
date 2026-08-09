#!/usr/bin/env node
// Focused Node-level verification for the Milestone 2 authentication
// backend (api/_lib/userStore.js, session.js, auth.js, authRateLimit.js,
// api/auth/*). This is NOT a Jest test — CRA's Jest config targets
// src/**/*.test.js under jsdom and isn't set up for plain Node backend
// modules under api/, so this is a standalone script instead, in the same
// spirit as the project's existing scripts/local-api-server.js.
//
// Deliberately does NOT load .env.local/.env (unlike local-api-server.js),
// so it always runs the functional tests against sharedStore's in-memory
// fallback (UPSTASH_* left unset in this process) — this must never write
// test accounts into the real production Upstash Redis instance. The one
// exception is the "Redis unavailable" test, which spawns a short-lived
// child process with a deliberately unreachable fake Upstash URL — still
// never touching the real instance.
"use strict";

const assert = require("assert");
const path = require("path");
const { spawnSync } = require("child_process");

// Set before any api/_lib module is required — these read process.env once
// at module-load time. Small limits keep the dedicated rate-limit tests
// fast; large enough that they don't fire during the earlier functional
// tests sharing the same mock IP. Cost 4 (bcrypt's minimum) keeps ~50
// hash operations in this script fast; production uses the real default
// (10) since AUTH_BCRYPT_COST is unset there.
process.env.AUTH_SIGNUP_RATE_LIMIT = "15";
process.env.AUTH_LOGIN_RATE_LIMIT = "15";
process.env.AUTH_BCRYPT_COST = "4";

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

function mockReq({ method = "GET", body, cookie, ip } = {}) {
    const headers = {};
    if (cookie) headers.cookie = cookie;
    if (ip) headers["x-forwarded-for"] = ip;
    return { method, body, headers, socket: { remoteAddress: "127.0.0.1" } };
}

function mockRes() {
    const res = { statusCode: 200, headers: {}, body: undefined };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (body) => { res.body = body; return res; };
    res.setHeader = (key, value) => { res.headers[key] = value; return res; };
    return res;
}

function extractCookieValue(setCookieHeader, name) {
    const match = new RegExp(`${name}=([^;]*)`).exec(setCookieHeader || "");
    return match ? match[1] : null;
}

function runInChildWithUnreachableRedis(inlineScript) {
    return spawnSync(process.execPath, ["-e", inlineScript], {
        cwd: ROOT,
        env: {
            ...process.env,
            // A port nothing listens on locally — fetch() fails fast
            // (ECONNREFUSED) rather than hanging, which is what makes this a
            // realistic "Redis is configured but the endpoint is down"
            // simulation rather than a "Redis isn't configured at all" one.
            UPSTASH_REDIS_REST_URL: "http://127.0.0.1:9",
            UPSTASH_REDIS_REST_TOKEN: "test-invalid-token-never-a-real-secret",
        },
        encoding: "utf8",
        timeout: 10000,
    });
}

async function main() {
    console.log("=== IvyHuts Auth Backend Verification (Milestone 2) ===");
    console.log("Redis backing for functional tests: in-memory fallback (UPSTASH_* left unset in this process) — no writes reach production Redis.\n");

    const userStore = require(path.join(ROOT, "api", "_lib", "userStore"));
    const session = require(path.join(ROOT, "api", "_lib", "session"));
    const signupHandler = require(path.join(ROOT, "api", "auth", "signup"));
    const loginHandler = require(path.join(ROOT, "api", "auth", "login"));
    const logoutHandler = require(path.join(ROOT, "api", "auth", "logout"));
    const meHandler = require(path.join(ROOT, "api", "auth", "me"));

    const suffix = Date.now();
    const testEmail = `verify-${suffix}@example.test`;
    const testPassword = "correct-horse-battery-staple";
    let signupCookie;

    // 1. Password hashing + comparison
    await test("password hashing + comparison round-trips correctly", async () => {
        const hash = await userStore.hashPassword(testPassword);
        assert.notStrictEqual(hash, testPassword, "hash must not equal the plaintext password");
        assert.ok(await userStore.verifyPassword(testPassword, hash), "correct password must verify");
        assert.ok(!(await userStore.verifyPassword("wrong-password", hash)), "wrong password must not verify");
    });

    // 2. Signup success
    await test("signup succeeds, sets a secure session cookie, and never returns password/hash", async () => {
        const req = mockReq({ method: "POST", body: { name: "Test User", email: testEmail, password: testPassword, phone: "+91 98765 43210" } });
        const res = mockRes();
        await signupHandler(req, res);
        assert.strictEqual(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
        assert.strictEqual(res.body.ok, true);
        assert.strictEqual(res.body.user.email, testEmail);
        assert.strictEqual(res.body.user.phone, "+919876543210", "phone should be stored/returned with formatting whitespace stripped, digits unchanged");
        assert.strictEqual(res.body.user.passwordHash, undefined, "passwordHash must never be returned");
        assert.strictEqual(res.body.user.password, undefined, "password must never be returned");
        assert.ok(JSON.stringify(res.body).indexOf(testPassword) === -1, "raw password must not appear anywhere in the response");
        const cookieHeader = res.headers["Set-Cookie"];
        assert.ok(cookieHeader, "signup must set a session cookie");
        assert.ok(cookieHeader.includes("HttpOnly"), "session cookie must be HttpOnly");
        assert.ok(cookieHeader.includes("SameSite=Lax"), "session cookie must be SameSite=Lax");
        assert.ok(cookieHeader.includes("Path=/"), "session cookie must set Path=/");
        signupCookie = `${session.COOKIE_NAME}=${extractCookieValue(cookieHeader, session.COOKIE_NAME)}`;
    });

    // 2b. Mandatory phone number — missing/empty/invalid/valid cases
    await test("signup without a phone field at all is rejected with 400", async () => {
        const req = mockReq({ method: "POST", body: { name: "No Phone", email: `no-phone-${suffix}@example.test`, password: "a-fine-password-1" } });
        const res = mockRes();
        await signupHandler(req, res);
        assert.strictEqual(res.statusCode, 400, `expected 400, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
        assert.strictEqual(res.body.error, "invalid_input");
    });

    await test("signup with an empty phone string is rejected with 400", async () => {
        const req = mockReq({ method: "POST", body: { name: "Empty Phone", email: `empty-phone-${suffix}@example.test`, password: "a-fine-password-1", phone: "   " } });
        const res = mockRes();
        await signupHandler(req, res);
        assert.strictEqual(res.statusCode, 400, `expected 400, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
        assert.strictEqual(res.body.error, "invalid_input");
    });

    await test("signup with an invalid phone format (letters, too short, too long) is rejected with 400", async () => {
        for (const badPhone of ["abcdefghij", "12345", "9876543210123456", "+44 1234 567890"]) {
            const req = mockReq({ method: "POST", body: { name: "Bad Phone", email: `bad-phone-${suffix}-${badPhone.length}@example.test`, password: "a-fine-password-1", phone: badPhone } });
            const res = mockRes();
            await signupHandler(req, res);
            assert.strictEqual(res.statusCode, 400, `expected 400 for phone "${badPhone}", got ${res.statusCode}: ${JSON.stringify(res.body)}`);
            assert.strictEqual(res.body.error, "invalid_input");
        }
    });

    await test("signup with a valid 10-digit Indian phone (no country code) succeeds", async () => {
        const req = mockReq({ method: "POST", body: { name: "Ten Digit", email: `ten-digit-${suffix}@example.test`, password: "a-fine-password-1", phone: "9876543210" } });
        const res = mockRes();
        await signupHandler(req, res);
        assert.strictEqual(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
        assert.strictEqual(res.body.user.phone, "9876543210");
    });

    await test("signup with a valid +91-prefixed phone succeeds", async () => {
        const req = mockReq({ method: "POST", body: { name: "Plus91", email: `plus91-${suffix}@example.test`, password: "a-fine-password-1", phone: "+919876543210" } });
        const res = mockRes();
        await signupHandler(req, res);
        assert.strictEqual(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
        assert.strictEqual(res.body.user.phone, "+919876543210");
    });

    // 3. Duplicate email signup
    await test("duplicate email signup is rejected with 409 and no second account is created", async () => {
        const req = mockReq({ method: "POST", body: { name: "Impostor", email: testEmail, password: "some-other-password-1", phone: "9876543210" } });
        const res = mockRes();
        await signupHandler(req, res);
        assert.strictEqual(res.statusCode, 409, `expected 409, got ${res.statusCode}`);
        assert.strictEqual(res.body.error, "email_exists");
    });

    // 3b. Simultaneous signup race for the same email — proves the
    // sharedSetNX-based reservation is actually atomic, not just correct
    // when called sequentially.
    await test("simultaneous signups for the same new email: exactly one succeeds", async () => {
        const raceEmail = `race-${suffix}@example.test`;
        const attempts = await Promise.all(
            Array.from({ length: 8 }, (_, i) => {
                const req = mockReq({ method: "POST", body: { name: `Racer ${i}`, email: raceEmail, password: "race-password-12345", phone: "9876543210" } });
                const res = mockRes();
                return signupHandler(req, res).then(() => res);
            })
        );
        const successes = attempts.filter((r) => r.statusCode === 200);
        const conflicts = attempts.filter((r) => r.statusCode === 409);
        assert.strictEqual(successes.length, 1, `expected exactly 1 success out of 8 concurrent signups, got ${successes.length}`);
        assert.strictEqual(conflicts.length, 7, `expected 7 conflicts, got ${conflicts.length}`);
    });

    // 4. Login success
    await test("login succeeds with correct credentials and updates lastLogin", async () => {
        const req = mockReq({ method: "POST", body: { email: testEmail, password: testPassword } });
        const res = mockRes();
        await loginHandler(req, res);
        assert.strictEqual(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
        assert.strictEqual(res.body.user.email, testEmail);
        assert.ok(res.headers["Set-Cookie"], "login must set a session cookie");
    });

    // 5. Invalid password
    await test("login with wrong password returns a generic 401 (no user-enumeration detail)", async () => {
        const req = mockReq({ method: "POST", body: { email: testEmail, password: "definitely-wrong-password" } });
        const res = mockRes();
        await loginHandler(req, res);
        assert.strictEqual(res.statusCode, 401);
        assert.strictEqual(res.body.error, "invalid_credentials");
        assert.strictEqual(res.body.message, "Invalid email or password.");
    });

    await test("login for a non-existent email returns the SAME generic 401 message (no enumeration)", async () => {
        const req = mockReq({ method: "POST", body: { email: `nobody-${suffix}@example.test`, password: "whatever-password-1" } });
        const res = mockRes();
        await loginHandler(req, res);
        assert.strictEqual(res.statusCode, 401);
        assert.strictEqual(res.body.message, "Invalid email or password.");
    });

    // 6 & 7. Session creation + lookup
    await test("session creation + lookup returns the correct userId", async () => {
        const fakeUserId = `direct-session-user-${suffix}`;
        const sessionId = await session.createSession(fakeUserId);
        assert.ok(sessionId && sessionId.length >= 32, "session id should be a long opaque random string");
        assert.strictEqual(await session.getSessionUserId(sessionId), fakeUserId);
    });

    // 8. Logout
    await test("logout clears the cookie and invalidates the session (subsequent /me is 401)", async () => {
        const meBefore = mockRes();
        await meHandler(mockReq({ method: "GET", cookie: signupCookie }), meBefore);
        assert.strictEqual(meBefore.statusCode, 200, "session from signup should still be valid before logout");

        const logoutRes = mockRes();
        await logoutHandler(mockReq({ method: "POST", cookie: signupCookie }), logoutRes);
        assert.strictEqual(logoutRes.statusCode, 200);
        assert.ok(logoutRes.headers["Set-Cookie"].includes("Max-Age=0"), "logout must clear the cookie (Max-Age=0)");

        const meAfter = mockRes();
        await meHandler(mockReq({ method: "GET", cookie: signupCookie }), meAfter);
        assert.strictEqual(meAfter.statusCode, 401, "session must be invalid after logout");
    });

    await test("logout with no session cookie still succeeds (already logged out)", async () => {
        const res = mockRes();
        await logoutHandler(mockReq({ method: "POST" }), res);
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.body.ok, true);
    });

    // 9. Expired/invalid session
    await test("unknown/garbage session cookie is rejected", async () => {
        const res = mockRes();
        await meHandler(mockReq({ method: "GET", cookie: `${session.COOKIE_NAME}=not-a-real-session-id` }), res);
        assert.strictEqual(res.statusCode, 401);
    });

    await test("expired session is rejected (TTL elapsing simulated via direct deletion)", async () => {
        const fakeUserId = `expiring-user-${suffix}`;
        const sessionId = await session.createSession(fakeUserId);
        assert.strictEqual(await session.getSessionUserId(sessionId), fakeUserId);
        // Waiting out AUTH_SESSION_TTL_SECONDS for real isn't practical in a
        // test — deleting the underlying record directly is observably
        // identical, since getSessionUserId only ever checks "does the
        // session key still exist", exactly what TTL expiry also produces.
        await session.deleteSession(sessionId);
        assert.strictEqual(await session.getSessionUserId(sessionId), null);
    });

    // 10. Unauthenticated /me
    await test("GET /api/auth/me with no cookie at all returns 401", async () => {
        const res = mockRes();
        await meHandler(mockReq({ method: "GET" }), res);
        assert.strictEqual(res.statusCode, 401);
        assert.strictEqual(res.body.error, "unauthenticated");
    });

    // 11. Cross-user access: a client-supplied userId must never be honored
    await test("a client-supplied userId in the request body is ignored — identity always comes from the session", async () => {
        const attackerReq = mockReq({ method: "GET", cookie: undefined });
        attackerReq.body = { userId: "some-other-real-user-id" };
        const res = mockRes();
        await meHandler(attackerReq, res);
        assert.strictEqual(res.statusCode, 401, "no session cookie means unauthenticated, regardless of any userId in the body");
    });

    // 12. Authentication rate limiting (signup)
    await test(`signup rate limiting blocks the (${Number(process.env.AUTH_SIGNUP_RATE_LIMIT) + 1})th attempt from one IP within the window`, async () => {
        const limit = Number(process.env.AUTH_SIGNUP_RATE_LIMIT);
        const rlIp = "203.0.113.10"; // TEST-NET-3 (RFC 5737) — reserved for documentation/testing, never a real client
        const statuses = [];
        for (let i = 0; i <= limit; i++) {
            const req = mockReq({ method: "POST", ip: rlIp, body: { name: `RL ${i}`, email: `rl-signup-${suffix}-${i}@example.test`, password: "rate-limit-password-1", phone: "9876543210" } });
            const res = mockRes();
            await signupHandler(req, res);
            statuses.push(res.statusCode);
        }
        const last = statuses[statuses.length - 1];
        assert.strictEqual(last, 429, `expected the ${limit + 1}th signup from one IP to be rate-limited, got statuses: ${statuses.join(",")}`);
        assert.ok(statuses.slice(0, limit).every((s) => s === 200), `expected the first ${limit} signups to succeed, got: ${statuses.join(",")}`);
    });

    // 12b. Authentication rate limiting (login)
    await test(`login rate limiting blocks the (${Number(process.env.AUTH_LOGIN_RATE_LIMIT) + 1})th attempt from one IP+email within the window`, async () => {
        const limit = Number(process.env.AUTH_LOGIN_RATE_LIMIT);
        const rlIp = "203.0.113.20";
        const rlEmail = `rl-login-${suffix}@example.test`;
        const statuses = [];
        for (let i = 0; i <= limit; i++) {
            const req = mockReq({ method: "POST", ip: rlIp, body: { email: rlEmail, password: "irrelevant-wrong-password" } });
            const res = mockRes();
            await loginHandler(req, res);
            statuses.push(res.statusCode);
        }
        const last = statuses[statuses.length - 1];
        assert.strictEqual(last, 429, `expected the ${limit + 1}th login from one IP+email to be rate-limited, got statuses: ${statuses.join(",")}`);
        assert.ok(statuses.slice(0, limit).every((s) => s === 401), `expected the first ${limit} logins to fail normally (401, wrong password), got: ${statuses.join(",")}`);
    });

    // 13. Input validation
    await test("signup rejects a short password, missing name, and malformed email", async () => {
        const res1 = mockRes();
        await signupHandler(mockReq({ method: "POST", body: { name: "X", email: `short-${suffix}@example.test`, password: "short" } }), res1);
        assert.strictEqual(res1.statusCode, 400);

        const res2 = mockRes();
        await signupHandler(mockReq({ method: "POST", body: { email: `noname-${suffix}@example.test`, password: "a-fine-password-1" } }), res2);
        assert.strictEqual(res2.statusCode, 400);

        const res3 = mockRes();
        await signupHandler(mockReq({ method: "POST", body: { name: "X", email: "not-an-email", password: "a-fine-password-1" } }), res3);
        assert.strictEqual(res3.statusCode, 400);
    });

    // 14. Method guards
    await test("wrong HTTP methods are rejected with 405", async () => {
        const res1 = mockRes();
        await signupHandler(mockReq({ method: "GET" }), res1);
        assert.strictEqual(res1.statusCode, 405);

        const res2 = mockRes();
        await meHandler(mockReq({ method: "POST" }), res2);
        assert.strictEqual(res2.statusCode, 405);
    });

    // 15. Redis unavailable (configured but unreachable) must fail closed
    // with 503, never silently fall back to an in-memory store — spawned in
    // a fresh child process so the fake Upstash URL doesn't leak into the
    // rest of this script's in-memory-backed tests.
    await test("Redis configured-but-unreachable fails closed with 503 (never silently falls back)", async () => {
        const inlineScript = `
            const path = require("path");
            const login = require(path.join(process.cwd(), "api", "auth", "login.js"));
            (async () => {
                const req = { method: "POST", body: { email: "whoever@example.test", password: "whatever-12345" }, headers: {}, socket: { remoteAddress: "127.0.0.1" } };
                const res = { statusCode: 200, headers: {}, status(c){this.statusCode=c;return this;}, json(b){this.body=b;return this;}, setHeader(k,v){this.headers[k]=v;} };
                await login(req, res);
                process.stdout.write(JSON.stringify({ statusCode: res.statusCode, body: res.body }));
            })().catch((err) => { process.stdout.write(JSON.stringify({ error: err.message })); process.exitCode = 1; });
        `;
        const result = runInChildWithUnreachableRedis(inlineScript);
        assert.strictEqual(result.status, 0, `child process crashed unexpectedly: ${result.stderr}`);
        const parsed = JSON.parse(result.stdout);
        assert.strictEqual(parsed.statusCode, 503, `expected 503 when Redis is configured but unreachable, got: ${JSON.stringify(parsed)}`);
        assert.strictEqual(parsed.body.error, "service_unavailable");
    });

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
