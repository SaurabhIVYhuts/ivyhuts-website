// PATCH /api/notifications/:id — mark one of the caller's OWN notifications
// read. Milestone 23.14.
//
// Scoped by {_id, recipientUserId} in one query — the same safe compound
// pattern every lead-nested child resource in this backend already uses
// (see api/leads/[id]/meetings/[meetingId]/index.js) — never a bare
// findById, so an agent can never mark (or even discover the existence of)
// another agent's notification. A 404 for someone else's notification id
// leaks nothing about whether it exists.
const { connectToDatabase } = require("../../_lib/mongodb");
const { requireRole } = require("../../_lib/businessAuth");
const { withCors } = require("../../_lib/cors");
const Notification = require("../../_lib/models/Notification");
const { withErrorHandling, requireObjectId, notFound } = require("../../_lib/validation");
const { sendSuccess } = require("../../_lib/apiResponse");
const { toSafeNotification } = require("../index.js");

const INTERNAL_ROLES = ["MARKETING_AGENT", "MARKETING_MANAGER", "ADMIN"];

async function handlePatch(req, res, id) {
    const identity = await requireRole(req, res, INTERNAL_ROLES);
    if (!identity) return;

    await connectToDatabase();
    const notification = await Notification.findOne({ _id: id, recipientUserId: identity.mongoUser._id });
    if (!notification) throw notFound("Notification not found.");

    if (!notification.readAt) {
        notification.readAt = new Date();
        await notification.save();
    }
    sendSuccess(res, toSafeNotification(notification));
}

const handler = withErrorHandling(async (req, res) => {
    if (withCors(req, res)) return;
    const id = requireObjectId(req.query.id, "id");
    if (req.method === "PATCH") return handlePatch(req, res, id);
    res.status(405).json({ error: "Method not allowed" });
});

module.exports = handler;
