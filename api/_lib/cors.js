// Explicit CRM-origin allowlist for cross-origin, credentialed requests
// from the separate ivyhuts-crm app. Never Access-Control-Allow-Origin: *
// with credentials — browsers reject that combination outright, but this
// also guarantees we never echo an unchecked Origin back unexamined.
//
// No "Milestone 18/19" CORS work exists anywhere in this repo (verified by
// grep across the whole tree before writing this) — this is the first CORS
// handling this backend has ever had.
//
// CRM_ORIGIN is a comma-separated list of exact origins (scheme+host+port),
// e.g. "https://ivyhuts-crm.vercel.app" or, with a deploy preview added,
// "https://ivyhuts-crm.vercel.app,https://crm-git-x.vercel.app". A trailing
// slash on any entry is tolerated (getAllowedOrigins strips it). In
// production this is set on the ivyhuts-website Vercel project to the
// deployed CRM's stable origin. Local development always works via the
// hardcoded fallback below, matching the CRM's Next.js dev server default
// (see ivyhuts-crm/package.json's "dev": "next dev").
const DEFAULT_DEV_ORIGIN = "http://localhost:3000";

function getAllowedOrigins() {
    const configured = String(process.env.CRM_ORIGIN || "")
        .split(",")
        // A browser's Origin header is always bare scheme+host+port with no
        // path, so a trailing slash in the configured value (an easy mistake
        // to make in a hosting dashboard) would make every match fail
        // silently. Strip it here so the env value is forgiving.
        .map((o) => o.trim().replace(/\/+$/, ""))
        .filter(Boolean);
    return configured.length ? configured : [DEFAULT_DEV_ORIGIN];
}

// PUT is included even though no current CRM-facing route uses it yet —
// this is a general-purpose CORS capability, not per-endpoint, and the
// milestone spec explicitly asks for PUT to be an allowed method.
const ALLOWED_METHODS = ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"];

// Content-Type is the only header the CRM's client (src/lib/api/client.ts)
// actually sends. No Idempotency-Key or similar mechanism exists anywhere
// in this backend (verified by grep) — nothing else to allowlist here
// unless/until a real caller needs it.
const ALLOWED_HEADERS = ["Content-Type"];

function isAllowedOrigin(origin) {
    return Boolean(origin) && getAllowedOrigins().includes(origin);
}

// Applies CORS headers when (and only when) the request's Origin is on the
// allowlist, and fully answers an OPTIONS preflight itself. Returns true if
// the caller should stop (preflight already handled); false if the caller
// should continue handling the real request.
//
// A request with no Origin header (same-origin, curl, server-to-server) is
// left untouched — CORS headers are meaningless without a cross-origin
// browser request to guard, and adding them unconditionally would be
// pointless. A request from a non-allowlisted Origin also gets no headers
// at all — the browser then blocks it client-side on its own, which is the
// standard, correct way CORS rejects a disallowed origin (no bespoke 403
// needed here).
function withCors(req, res) {
    const origin = req.headers && req.headers.origin;
    if (isAllowedOrigin(origin)) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Credentials", "true");
        // Origin-dependent response — never let a shared/CDN cache serve
        // one origin's CORS headers to a different origin's request.
        res.setHeader("Vary", "Origin");
    }
    if (req.method === "OPTIONS") {
        res.setHeader("Access-Control-Allow-Methods", ALLOWED_METHODS.join(", "));
        res.setHeader("Access-Control-Allow-Headers", ALLOWED_HEADERS.join(", "));
        res.status(204).end();
        return true;
    }
    return false;
}

module.exports = { withCors, isAllowedOrigin, getAllowedOrigins, DEFAULT_DEV_ORIGIN, ALLOWED_METHODS, ALLOWED_HEADERS };
