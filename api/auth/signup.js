// Vercel serverless function — creates a new IvyHuts account. Completely
// independent of Amber: never imports amberGateway/amberApi, never calls
// /api/amber, and its rate limiting/storage live under their own "auth:*"/
// "user:*"/"email:*" Redis keys, never touching "amber:*".
const { createUser, toSafeUser, EmailAlreadyExistsError } = require("../_lib/userStore");
const { createSession, buildSessionCookie } = require("../_lib/session");
const { RedisUnavailableError } = require("../_lib/sharedStore");
const { checkSignupRateLimit, getClientIp } = require("../_lib/authRateLimit");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;

// Indian mobile numbers: 10 digits starting 6-9, with an optional +91
// country code. Matches the two formats the signup form is expected to
// accept — "9876543210" and "+919876543210".
const PHONE_RE = /^(?:\+91)?[6-9]\d{9}$/;

// Strips only formatting characters (spaces, hyphens) — never reinterprets
// or reconstructs the number itself, so the digits a user typed are always
// exactly the digits that get validated and stored.
function normalizePhone(rawPhone) {
    return typeof rawPhone === "string" ? rawPhone.replace(/[\s-]/g, "").trim() : "";
}

function validateSignupInput(body, normalizedPhone) {
    const errors = [];
    if (!body.name || typeof body.name !== "string" || !body.name.trim()) {
        errors.push("Name is required.");
    }
    if (!body.email || typeof body.email !== "string" || !EMAIL_RE.test(body.email.trim())) {
        errors.push("A valid email is required.");
    }
    if (!body.password || typeof body.password !== "string" || body.password.length < MIN_PASSWORD_LENGTH) {
        errors.push(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    }
    if (!normalizedPhone) {
        errors.push("A mobile number is required.");
    } else if (!PHONE_RE.test(normalizedPhone)) {
        errors.push("Enter a valid 10-digit mobile number, e.g. 9876543210 or +919876543210.");
    }
    return errors;
}

module.exports = async (req, res) => {
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

    const normalizedPhone = normalizePhone(body.phone);
    const errors = validateSignupInput(body, normalizedPhone);
    if (errors.length) {
        res.status(400).json({ ok: false, error: "invalid_input", message: errors[0], errors });
        return;
    }

    const ip = getClientIp(req);

    try {
        const allowed = await checkSignupRateLimit(ip);
        if (!allowed) {
            res.status(429).json({ ok: false, error: "rate_limited", message: "Too many signup attempts. Please try again later." });
            return;
        }

        const user = await createUser({
            name: body.name.trim(),
            email: body.email,
            password: body.password,
            phone: normalizedPhone,
        });

        const sessionId = await createSession(user.id);
        res.setHeader("Set-Cookie", buildSessionCookie(sessionId));
        console.log(`[auth/signup] New account created (userId=${user.id})`);
        res.status(200).json({ ok: true, user: toSafeUser(user) });
    } catch (err) {
        if (err instanceof EmailAlreadyExistsError) {
            res.status(409).json({ ok: false, error: "email_exists", message: "An account with this email already exists." });
            return;
        }
        if (err instanceof RedisUnavailableError) {
            console.error("[auth/signup] Redis unavailable:", err.message);
            res.status(503).json({ ok: false, error: "service_unavailable", message: "Signup is temporarily unavailable — please try again shortly." });
            return;
        }
        console.error("[auth/signup] Unexpected error:", err.message);
        res.status(500).json({ ok: false, error: "internal_error", message: "Something went wrong. Please try again." });
    }
};
