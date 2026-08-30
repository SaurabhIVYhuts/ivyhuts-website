// PATCH /api/leads/:id/assignment — internal roles only.
// Body: { "assignedTo": "<marketing-user-id>" } or { "assignedTo": null } to unassign.
const { connectToDatabase } = require("../../_lib/mongodb");
const { requireRole } = require("../../_lib/businessAuth");
const { checkBusinessWriteRateLimit } = require("../../_lib/businessRateLimit");
const Lead = require("../../_lib/models/Lead");
const User = require("../../_lib/models/User");
const { toSafeLead } = require("../../_lib/leadView");
const { recordEvent } = require("../../_lib/events");
const { createNotification } = require("../../_lib/notify");
const { withErrorHandling, requireObjectId, notFound, badRequest, parseJsonBody } = require("../../_lib/validation");
const { sendSuccess } = require("../../_lib/apiResponse");
const { withCors } = require("../../_lib/cors");

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

    const previousAssignedTo = lead.assignedTo;
    let newlyAssignedAgent = null; // set only when this is a genuinely NEW assignment, for the notification below

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
        // Milestone 23.14 — only notify on a genuine change of assignee, never
        // on a no-op re-save of the same value (e.g. a UI double-submit).
        if (previousAssignedTo !== lead.assignedTo) newlyAssignedAgent = target;
    }

    await lead.save();

    await recordEvent({
        userId: lead.userId,
        event: "LEAD_ASSIGNED",
        properties: { leadId: String(lead._id), assignedTo: lead.assignedTo },
        metadata: { changedBy: String(identity.mongoUser._id), changedByRole: identity.mongoUser.role },
    });

    // Milestone 23.14 — "Assignment must trigger agent action" (Part 8).
    // Fire-and-forget-safe (see notify.js) — a notification failure must
    // never fail the assignment itself, which has already succeeded above.
    if (newlyAssignedAgent) {
        const studentName = (lead.contact && lead.contact.name) || "this lead";
        await createNotification({
            recipientUserId: newlyAssignedAgent._id,
            leadId: lead._id,
            type: "LEAD_ASSIGNED",
            title: "New lead assigned",
            message: `${studentName} was assigned to you. Schedule a meeting to get started.`,
            actionHref: `/dashboard/leads/${lead._id}#meeting`,
        });
    }

    sendSuccess(res, toSafeLead(lead));
});
