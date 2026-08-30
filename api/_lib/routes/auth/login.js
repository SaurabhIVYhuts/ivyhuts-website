// Vercel serverless function — logs in an existing IvyHuts account.
// Independent of Amber (see api/auth/signup.js header comment).
const { findUserByEmail, verifyPassword, updateLastLogin, toSafeUser, normalizeEmail, DUMMY_PASSWORD_HASH } = require("../../userStore");
const { createSession, buildSessionCookie } = require("../../session");
const { RedisUnavailableError } = require("../../sharedStore");
const { checkLoginRateLimit, getClientIp } = require("../../authRateLimit");
const { withCors } = require("../../cors");

// Deliberately generic — never reveals whether the email exists or the
// password was wrong, so a login form can't be used to enumerate accounts.
const GENERIC_AUTH_FAILURE = "Invalid email or password.";

module.exports = async (req, res) => {
    if (withCors(req, res)) return; // preflight handled

    if (req.method !== "POST") {
        res.status(405).json({ error: "Method not allowed" });
        return;
    }

    let body = req.body;
    if (!body || typeof body === "string") {
        try {
            body = JSON.parse(body || "{}");
        } catch {
            body = {};
        }
    }
    body = body || {};

    if (!body.email || typeof body.email !== "string" || !body.password || typeof body.password !== "string") {
        res.status(400).json({ ok: false, error: "invalid_input", message: "Email and password are required." });
        return;
    }

    const ip = getClientIp(req);
    const normalizedEmail = normalizeEmail(body.email);

    try {
        const allowed = await checkLoginRateLimit(ip, normalizedEmail);
        if (!allowed) {
            res.status(429).json({ ok: false, error: "rate_limited", message: "Too many login attempts. Please try again later." });
            return;
        }

        const user = await findUserByEmail(normalizedEmail);
        // Always run bcrypt.compare, even when no user was found — comparing
        // against a fixed dummy hash keeps the response time for "no such
        // account" and "wrong password" statistically indistinguishable, so
        // timing can't be used to enumerate registered emails either.
        const valid = await verifyPassword(body.password, user ? user.passwordHash : DUMMY_PASSWORD_HASH);

        if (!user || !valid) {
            res.status(401).json({ ok: false, error: "invalid_credentials", message: GENERIC_AUTH_FAILURE });
            return;
        }

        const updatedUser = await updateLastLogin(user.id);
        const sessionId = await createSession(user.id);
        res.setHeader("Set-Cookie", buildSessionCookie(sessionId));
        res.status(200).json({ ok: true, user: toSafeUser(updatedUser || user) });
    } catch (err) {
        if (err instanceof RedisUnavailableError) {
            console.error("[auth/login] Redis unavailable:", err.message);
            res.status(503).json({ ok: false, error: "service_unavailable", message: "Login is temporarily unavailable — please try again shortly." });
            return;
        }
        console.error("[auth/login] Unexpected error:", err.message);
        res.status(500).json({ ok: false, error: "internal_error", message: "Something went wrong. Please try again." });
    }
};
