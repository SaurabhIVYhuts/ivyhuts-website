// Rate limiting for the Milestone 2 business API's write endpoints
// (lead/enquiry creation are reachable by anonymous visitors, same as the
// existing enquiry form). Reuses the same atomic reserveSlot() primitive
// api/_lib/authRateLimit.js uses, under its own "api:business:*" key
// namespace — completely separate from Amber's "amber:requests" budget and
// from auth's "auth:*" keys.
const { reserveSlot } = require("./sharedStore");
const { ApiError } = require("./validation");

// Vercel overwrites x-forwarded-for with the real client IP before a
// request reaches a serverless function; falls back to the raw socket
// address for local dev (scripts/local-api-server.js has no proxy in
// front of it). Same reasoning as api/_lib/authRateLimit.js's getClientIp.
function getClientIp(req) {
    const vercelHeader = req.headers["x-vercel-forwarded-for"];
    if (vercelHeader) return String(vercelHeader).split(",")[0].trim();
    const forwarded = req.headers["x-forwarded-for"];
    if (forwarded) return String(forwarded).split(",")[0].trim();
    return (req.socket && req.socket.remoteAddress) || "unknown";
}

const WINDOW_MS = 15 * 60 * 1000;
const LIMIT_PER_WINDOW = Number(process.env.API_BUSINESS_RATE_LIMIT) || 60;

// Applied to every mutating business endpoint (POST/PATCH/DELETE). Generous
// by default since internal-role traffic also passes through here — the
// real abuse surface is the two anonymous-allowed endpoints (lead/enquiry
// creation), and this still bounds them without needing a separate limit.
async function checkBusinessWriteRateLimit(req) {
    const ip = getClientIp(req);
    const allowed = await reserveSlot(`api:business:write:ip:${ip}`, WINDOW_MS, LIMIT_PER_WINDOW);
    if (!allowed) {
        throw new ApiError(429, "RATE_LIMITED", "Too many requests. Please try again later.");
    }
}

module.exports = { getClientIp, checkBusinessWriteRateLimit };
