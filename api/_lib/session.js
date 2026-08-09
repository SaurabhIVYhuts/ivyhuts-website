// Redis-backed session store for our own authentication system. Sessions
// are opaque random IDs (never a JWT), handed to the browser only inside an
// HttpOnly cookie — client-side JavaScript never sees or holds the session
// ID, which is what keeps it out of reach of XSS (unlike a localStorage
// token). The server-side session:{sessionId} -> { userId } record is what
// actually grants access; the cookie by itself proves nothing without it.
const crypto = require("crypto");
const { sharedGet, sharedSet, sharedDelete } = require("./sharedStore");

const COOKIE_NAME = "ivyhuts_session";

// 30 days default — long enough that visitors don't get logged out between
// browsing sessions, short enough that a lost/stolen cookie doesn't grant
// indefinite access. Configurable without a code change (see .env.example).
const SESSION_TTL_SECONDS = Number(process.env.AUTH_SESSION_TTL_SECONDS) || 60 * 60 * 24 * 30;

function sessionKey(sessionId) {
    return `session:${sessionId}`;
}

// 256 bits of cryptographically secure randomness, hex-encoded — not
// derived from anything guessable (time, counters), and far too large to
// brute force.
function generateSessionId() {
    return crypto.randomBytes(32).toString("hex");
}

async function createSession(userId) {
    const sessionId = generateSessionId();
    await sharedSet(sessionKey(sessionId), { userId, createdAt: Date.now() }, SESSION_TTL_SECONDS);
    return sessionId;
}

async function getSessionUserId(sessionId) {
    if (!sessionId) return null;
    const record = await sharedGet(sessionKey(sessionId));
    return record ? record.userId : null;
}

async function deleteSession(sessionId) {
    if (!sessionId) return;
    await sharedDelete(sessionKey(sessionId));
}

// Minimal cookie-header parser — no `cookie` package in this project yet,
// and this is a handful of lines, not worth adding a dependency for.
function parseCookies(req) {
    const header = req.headers && req.headers.cookie;
    const out = {};
    if (!header) return out;
    for (const part of header.split(";")) {
        const idx = part.indexOf("=");
        if (idx === -1) continue;
        const key = part.slice(0, idx).trim();
        const value = part.slice(idx + 1).trim();
        if (key) {
            try {
                out[key] = decodeURIComponent(value);
            } catch {
                out[key] = value;
            }
        }
    }
    return out;
}

function getSessionIdFromRequest(req) {
    return parseCookies(req)[COOKIE_NAME] || null;
}

// NODE_ENV is "production" for both Vercel Preview and Production deploys
// (and unset/"development" for local `npm start`/`vercel dev`), so this
// correctly requires Secure everywhere except plain local HTTP, where a
// Secure-flagged cookie would silently never be sent by the browser at all.
function isProduction() {
    return process.env.NODE_ENV === "production";
}

function buildSessionCookie(sessionId) {
    const parts = [
        `${COOKIE_NAME}=${sessionId}`,
        "Path=/",
        "HttpOnly",
        "SameSite=Lax",
        `Max-Age=${SESSION_TTL_SECONDS}`,
    ];
    if (isProduction()) parts.push("Secure");
    return parts.join("; ");
}

function buildClearCookie() {
    const parts = [`${COOKIE_NAME}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
    if (isProduction()) parts.push("Secure");
    return parts.join("; ");
}

module.exports = {
    COOKIE_NAME,
    SESSION_TTL_SECONDS,
    createSession,
    getSessionUserId,
    deleteSession,
    getSessionIdFromRequest,
    buildSessionCookie,
    buildClearCookie,
};
