// POST /api/leads/:id/whatsapp/messages — Milestone 23.11.
//
// No WhatsApp Business API provider is integrated anywhere in this
// repository (confirmed by inspection) — this route exists ONLY to make
// that honest, matching src/components/communications/WhatsAppSendForm.tsx's
// own already-built handling for exactly this case (a 503 with error code
// "not_configured" permanently disables the send form for the rest of that
// page view, rather than pretending a retry might work). Before this route
// existed, the CRM's fetch fell through to the Amber catch-all handler and
// surfaced a confusing, unrelated error instead of that clean message.
//
// This NEVER sends a message, NEVER creates a Communication record, and
// NEVER returns success — it always fails closed. Real sending is a
// separate, later milestone once an actual provider is chosen and
// credentials exist (Milestone 23.11 Part 14 — do not implement here).
const { requireRole } = require("../../../_lib/businessAuth");
const { withCors } = require("../../../_lib/cors");
const { connectToDatabase } = require("../../../_lib/mongodb");
const Lead = require("../../../_lib/models/Lead");
const { withErrorHandling, requireObjectId, notFound } = require("../../../_lib/validation");

const INTERNAL_ROLES = ["MARKETING_AGENT", "MARKETING_MANAGER", "ADMIN"];

const handler = withErrorHandling(async (req, res) => {
    if (withCors(req, res)) return; // preflight handled

    if (req.method !== "POST") {
        res.status(405).json({ error: "Method not allowed" });
        return;
    }

    const leadId = requireObjectId(req.query.id, "id");
    const identity = await requireRole(req, res, INTERNAL_ROLES);
    if (!identity) return;

    // Auth and lead-existence are still real checks (an agent probing a
    // nonexistent or foreign lead ID still gets 401/403/404 as normal) —
    // only the actual send capability is unavailable.
    await connectToDatabase();
    const lead = await Lead.findById(leadId);
    if (!lead) throw notFound("Lead not found.");

    res.status(503).json({ success: false, error: { code: "not_configured", message: "WhatsApp Business API is not configured." } });
});

module.exports = handler;
