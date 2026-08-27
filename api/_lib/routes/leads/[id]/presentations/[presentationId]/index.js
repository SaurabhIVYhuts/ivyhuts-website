// GET /api/leads/:id/presentations/:presentationId — Milestone 23.8.
//
// Single-version metadata (never the .pptx bytes — see
// ./download.js for that). Always queried as {_id: presentationId, leadId}
// together, never `_id` alone — a presentationId that's real but belongs to
// a DIFFERENT lead must 404 exactly like one that doesn't exist at all
// (cross-lead isolation, same rule every other lead-scoped route in this
// repo already follows).
const { connectToDatabase } = require("../../../../../mongodb");
const { requireRole } = require("../../../../../businessAuth");
const { withCors } = require("../../../../../cors");
const Lead = require("../../../../../models/Lead");
const Presentation = require("../../../../../models/Presentation");
const { withErrorHandling, requireObjectId, notFound } = require("../../../../../validation");
const { sendSuccess } = require("../../../../../apiResponse");
const { toSafePresentation } = require("../index.js");

const INTERNAL_ROLES = ["MARKETING_AGENT", "MARKETING_MANAGER", "ADMIN"];

const handler = withErrorHandling(async (req, res) => {
    if (withCors(req, res)) return; // preflight handled

    if (req.method !== "GET") {
        res.status(405).json({ error: "Method not allowed" });
        return;
    }

    const identity = await requireRole(req, res, INTERNAL_ROLES);
    if (!identity) return;

    const leadId = requireObjectId(req.query.id, "id");
    const presentationId = requireObjectId(req.query.presentationId, "presentationId");

    await connectToDatabase();
    const lead = await Lead.findById(leadId);
    if (!lead) throw notFound("Lead not found.");

    const doc = await Presentation.findOne({ _id: presentationId, leadId });
    if (!doc) throw notFound("Presentation not found.");

    sendSuccess(res, toSafePresentation(doc));
});

module.exports = handler;
