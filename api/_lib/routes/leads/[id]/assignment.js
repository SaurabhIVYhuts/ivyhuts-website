// PATCH /api/leads/:id/assignment — internal roles only.
// Body: { "assignedTo": "<marketing-user-id>" } or { "assignedTo": null } to unassign.
const { connectToDatabase } = require("../../../mongodb");
const { requireRole } = require("../../../businessAuth");
const { checkBusinessWriteRateLimit } = require("../../../businessRateLimit");
const Lead = require("../../../models/Lead");
const User = require("../../../models/User");
const { toSafeLead } = require("../../../leadView");
const { recordEvent } = require("../../../events");
const { withErrorHandling, requireObjectId, notFound, badRequest, parseJsonBody } = require("../../../validation");
const { sendSuccess } = require("../../../apiResponse");
const { withCors } = require("../../../cors");

const INTERNAL_ROLES = ["MARKETING_AGENT", "MARKETING_MANAGER", "ADMIN"];

module.exports = withErrorHandling(async (req, res) => {
    if (withCors(req, res)) return; // preflight handled

    if (req.method !== "PATCH") {
        res.status(405).json({ error: "Method not allowed" });
        return;
    }
    const id = requireObjectId(req.query.id, "id");
    const identity = await requireRole(req, res, INTERNAL_ROLES);
    if (!identity) return;

    await checkBusinessWriteRateLimit(req);
    await connectToDatabase();

    const lead = await Lead.findById(id);
    if (!lead) throw notFound("Lead not found.");

    const body = parseJsonBody(req);
    if (!("assignedTo" in body)) {
        throw badRequest("VALIDATION_ERROR", "assignedTo is required (a user id, or null to unassign).");
    }

    if (body.assignedTo === null) {
        lead.assignedTo = null;
    } else {
        const targetId = requireObjectId(body.assignedTo, "assignedTo");
        const target = await User.findById(targetId);
        if (!target) throw badRequest("VALIDATION_ERROR", "assignedTo does not refer to an existing user.");
        if (!INTERNAL_ROLES.includes(target.role)) {
            throw badRequest("VALIDATION_ERROR", "Leads can only be assigned to MARKETING_AGENT, MARKETING_MANAGER, or ADMIN accounts.");
        }
        lead.assignedTo = String(target._id);
    }

    await lead.save();

    await recordEvent({
        userId: lead.userId,
        event: "LEAD_ASSIGNED",
        properties: { leadId: String(lead._id), assignedTo: lead.assignedTo },
        metadata: { changedBy: String(identity.mongoUser._id), changedByRole: identity.mongoUser.role },
    });

    sendSuccess(res, toSafeLead(lead));
});
