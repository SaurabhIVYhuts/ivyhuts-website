// Small reusable helper for API routes that need to know who's logged in.
// The authenticated user is ALWAYS derived from the server-side session
// cookie — never from a client-supplied userId in the request body/query.
// A future wishlist endpoint (or anything else that needs identity) should
// use requireAuth(req, res) rather than trusting anything the client sends.
const { getSessionIdFromRequest, getSessionUserId } = require("./session");
const { findUserById } = require("./userStore");
const { RedisUnavailableError } = require("./sharedStore");

async function getCurrentUser(req) {
    const sessionId = getSessionIdFromRequest(req);
    if (!sessionId) return null;
    const userId = await getSessionUserId(sessionId);
    if (!userId) return null;
    return findUserById(userId);
}

// Resolves the current user or writes the appropriate error response
// (401 unauthenticated, 503 if Redis is configured but unreachable) and
// returns null. Callers must check the return value and stop on null —
// the response has already been sent in that case.
async function requireAuth(req, res) {
    try {
        const user = await getCurrentUser(req);
        if (!user) {
            res.status(401).json({ ok: false, error: "unauthenticated", message: "Not logged in." });
            return null;
        }
        return user;
    } catch (err) {
        if (err instanceof RedisUnavailableError) {
            console.error("[auth] Redis unavailable during session check:", err.message);
            res.status(503).json({ ok: false, error: "service_unavailable", message: "Authentication is temporarily unavailable." });
            return null;
        }
        throw err;
    }
}

module.exports = { getCurrentUser, requireAuth };
