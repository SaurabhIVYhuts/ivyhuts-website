// In-app notification — Milestone 23.14 (Lead Intake + Meet + Transcript).
//
// This is the CRM's first notification mechanism (confirmed absent by audit
// before writing this — no Notification model, no unread/read pattern, no
// notification UI existed anywhere in either repo). Deliberately minimal:
// one flat collection, one recipient per notification (no fan-out/broadcast
// concept), read via a nullable `readAt` timestamp rather than a boolean so
// "when" is preserved, not just "whether".
//
// This is NOT a queue, NOT a push/email/WhatsApp channel, and NOT a second
// Work Queue — it exists to answer one narrow question for one agent at a
// time: "what does the CRM want me to notice right now?" The Work Queue
// remains the derived, evidence-based view of everything that needs
// attention; a Notification is a point-in-time nudge tied to a specific
// event (e.g. "this lead was just assigned to you"), not a recomputed state.
const mongoose = require("mongoose");
const { Schema } = mongoose;

// Kept small and closed deliberately — every value here must have a real
// caller before it's added (see api/_lib/notify.js for where each is
// actually created). Do not add a type "for later".
const NOTIFICATION_TYPES = ["LEAD_ASSIGNED", "TRANSCRIPT_READY_FOR_REVIEW", "MEETING_SCHEDULED", "MEETING_RESCHEDULED", "MEETING_CANCELLED"];

const NotificationSchema = new Schema(
    {
        recipientUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
        leadId: { type: Schema.Types.ObjectId, ref: "Lead", default: null },
        type: { type: String, enum: NOTIFICATION_TYPES, required: true },
        title: { type: String, required: true },
        message: { type: String, required: true },
        // Where clicking this notification should take the agent — always a
        // CRM-relative path the frontend already knows how to render (e.g.
        // "/dashboard/leads/:id#meeting"), never an arbitrary/external URL.
        actionHref: { type: String, default: null },
        readAt: { type: Date, default: null },
    },
    { timestamps: true }
);

// recipientUserId + readAt: query pattern = "this agent's unread
// notifications, newest first" — the only query this model's route runs.
NotificationSchema.index({ recipientUserId: 1, readAt: 1, createdAt: -1 });

module.exports = mongoose.models.Notification || mongoose.model("Notification", NotificationSchema);
module.exports.NOTIFICATION_TYPES = NOTIFICATION_TYPES;
