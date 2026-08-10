// Vercel serverless function — logs out the current session.
// Independent of Amber (see api/auth/signup.js header comment).
const { getSessionIdFromRequest, deleteSession, buildClearCookie } = require("../_lib/session");
const { RedisUnavailableError } = require("../_lib/sharedStore");

module.exports = async (req, res) => {
    if (req.method !== "POST") {
        res.status(405).json({ error: "Method not allowed" });
        return;
    }

    const sessionId = getSessionIdFromRequest(req);

    try {
        if (sessionId) await deleteSession(sessionId);
    } catch (err) {
        if (err instanceof RedisUnavailableError) {
            // Deliberate exception to the usual "Redis down -> 503" rule: the
            // user's intent here is to log out, and the cookie is cleared
            // client-side below regardless. Worst case if server-side
            // deletion failed, the orphaned session record simply expires on
            // its own TTL later — never worth blocking a logout over.
            console.error("[auth/logout] Redis unavailable while deleting session (cookie cleared anyway):", err.message);
        } else {
            throw err;
        }
    }

    // Always clears the cookie and returns success, even if there was no
    // session to begin with — logging out an already-logged-out visitor is
    // not an error.
    res.setHeader("Set-Cookie", buildClearCookie());
    res.status(200).json({ ok: true });
};
