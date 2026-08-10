// Narrowly-scoped rate limiting for /api/auth/* only. Reuses the generic
// reserveSlot() primitive added to sharedStore.js (same atomic
// rolling-window mechanism Amber's own budget uses) but under separate
// "auth:*" keys — this never touches or competes with Amber's
// "amber:requests" key or its global 6/min budget.
const { reserveSlot } = require("./sharedStore");

// Vercel's edge network sets/overwrites x-forwarded-for with the real
// client IP before a request reaches a serverless function (client-supplied
// values are stripped there), and x-vercel-forwarded-for is Vercel's own
// dedicated header for the same value — preferred when present since it's
// unambiguous. Locally (scripts/local-api-server.js is a plain Node HTTP
// server with no proxy in front of it) neither header exists, so this falls
// back to the raw socket address, which is "unknown"/loopback for all local
// requests — acceptable for local dev, where per-IP limiting isn't the
// point anyway.
function getClientIp(req) {
    const vercelHeader = req.headers["x-vercel-forwarded-for"];
    if (vercelHeader) return String(vercelHeader).split(",")[0].trim();
    const forwarded = req.headers["x-forwarded-for"];
    if (forwarded) return String(forwarded).split(",")[0].trim();
    return (req.socket && req.socket.remoteAddress) || "unknown";
}

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const SIGNUP_WINDOW_MS = 60 * 60 * 1000;

const LOGIN_LIMIT_PER_WINDOW = Number(process.env.AUTH_LOGIN_RATE_LIMIT) || 10;
const SIGNUP_LIMIT_PER_WINDOW = Number(process.env.AUTH_SIGNUP_RATE_LIMIT) || 5;

// Both the IP and the attempted email are rate-limited independently (each
// failed/attempted login consumes a slot from both), so neither a single
// attacker IP hammering many emails nor many IPs hammering one email can
// bypass the limit by avoiding the other axis.
async function checkLoginRateLimit(ip, normalizedEmail) {
    const ipAllowed = await reserveSlot(`auth:login:ip:${ip}`, LOGIN_WINDOW_MS, LOGIN_LIMIT_PER_WINDOW);
    if (!ipAllowed) return false;
    const emailAllowed = await reserveSlot(`auth:login:email:${normalizedEmail}`, LOGIN_WINDOW_MS, LOGIN_LIMIT_PER_WINDOW);
    return emailAllowed;
}

async function checkSignupRateLimit(ip) {
    return reserveSlot(`auth:signup:ip:${ip}`, SIGNUP_WINDOW_MS, SIGNUP_LIMIT_PER_WINDOW);
}

module.exports = { getClientIp, checkLoginRateLimit, checkSignupRateLimit };
