// GET /api/notifications — the current agent's own notifications, newest
// first. Milestone 23.14.
//
// Recipient is ALWAYS the authenticated session's own Mongo user — never a
// client-supplied id (no ?userId= param exists; same "identity from the
// session, never the request" rule as every other business endpoint —
// see api/_lib/auth.js's header comment). Any internal role may read their
// own notifications; there is no cross-agent visibility (an agent cannot
// see another agent's notifications) since that isn't a real product need
// and would be a needless isolation risk to introduce.
const { connectToDatabase } = require("../_lib/mongodb");
const { requireRole } = require("../_lib/businessAuth");
const { withCors } = require("../_lib/cors");
const Notification = require("../_lib/models/Notification");
const { withErrorHandling, parsePagination, buildPaginationMeta } = require("../_lib/validation");

const INTERNAL_ROLES = ["MARKETING_AGENT", "MARKETING_MANAGER", "ADMIN"];

function toSafeNotification(doc) {
    return {
        id: String(doc._id),
        leadId: doc.leadId ? String(doc.leadId) : null,
        type: doc.type,
        title: doc.title,
        message: doc.message,
        actionHref: doc.actionHref,
        readAt: doc.readAt,
        createdAt: doc.createdAt,
    };
}

async function handleGet(req, res) {
    const identity = await requireRole(req, res, INTERNAL_ROLES);
    if (!identity) return;

    await connectToDatabase();
    const pagination = parsePagination(req.query);
    const filter = { recipientUserId: identity.mongoUser._id };
    if (req.query.unreadOnly === "true") filter.readAt = null;

    const [documents, total, unreadCount] = await Promise.all([
        Notification.find(filter).sort({ createdAt: -1 }).skip(pagination.skip).limit(pagination.limit),
        Notification.countDocuments(filter),
        Notification.countDocuments({ recipientUserId: identity.mongoUser._id, readAt: null }),
    ]);

    res.status(200).json({
        success: true,
        data: documents.map(toSafeNotification),
        pagination: buildPaginationMeta(pagination, total),
        unreadCount,
    });
}

const handler = withErrorHandling(async (req, res) => {
    if (withCors(req, res)) return;
    if (req.method !== "GET") {
        res.status(405).json({ error: "Method not allowed" });
        return;
    }
    return handleGet(req, res);
});

handler.toSafeNotification = toSafeNotification;
module.exports = handler;
