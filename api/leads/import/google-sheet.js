// POST /api/leads/import/google-sheet — Milestone 23.14, extended so the
// CRM's "Refresh Leads" button can trigger it on demand (its core sync
// logic now lives in api/_lib/leadSheetSync.js, shared with the scheduled
// trigger at api/leads/import/sync-cron.js — same pipeline, two triggers).
//
// INTERNAL_ROLES only, rate-limited, idempotent (safe to run repeatedly —
// see leadIntake.js's externalLeadId-based dedup, the SAME key space the
// real Meta webhook already uses), auditable (one UserEvent per created/
// merged Lead plus a summary), and fails closed with 503 if Google Sheets
// isn't configured or is temporarily unreachable — never fabricates rows.
const { requireRole } = require("../../_lib/businessAuth");
const { checkBusinessWriteRateLimit } = require("../../_lib/businessRateLimit");
const { withCors } = require("../../_lib/cors");
const { runLeadSheetSync, MAX_ROWS_PER_RUN } = require("../../_lib/leadSheetSync");
const { withErrorHandling } = require("../../_lib/validation");
const { sendSuccess, sendError } = require("../../_lib/apiResponse");

const INTERNAL_ROLES = ["MARKETING_AGENT", "MARKETING_MANAGER", "ADMIN"];

async function handlePost(req, res) {
    const identity = await requireRole(req, res, INTERNAL_ROLES);
    if (!identity) return;

    await checkBusinessWriteRateLimit(req);

    const result = await runLeadSheetSync({ actorUserId: String(identity.mongoUser._id), actorRole: identity.mongoUser.role });

    if (result.status === "NOT_CONFIGURED" || result.status === "UPSTREAM_ERROR") {
        sendError(res, 503, "SERVICE_UNAVAILABLE", result.reason);
        return;
    }

    // syncedAt lets the CRM show an honest "Last synced: just now" without
    // trusting client clock skew for the initial value.
    sendSuccess(res, { summary: result.summary, details: result.details, syncedAt: new Date().toISOString() });
}

const handler = withErrorHandling(async (req, res) => {
    if (withCors(req, res)) return;
    if (req.method !== "POST") {
        res.status(405).json({ error: "Method not allowed" });
        return;
    }
    return handlePost(req, res);
});

handler.MAX_ROWS_PER_RUN = MAX_ROWS_PER_RUN;
module.exports = handler;
