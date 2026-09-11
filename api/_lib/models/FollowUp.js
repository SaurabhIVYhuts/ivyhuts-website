// A sales action to take — "call this lead back Thursday", not a record of
// something that already happened (that's Communication). Schema only: no
// dashboard/reminder UI in this milestone.
const mongoose = require("mongoose");
const { Schema } = mongoose;

const FOLLOWUP_TYPES = ["call", "email", "whatsapp", "meeting", "other"];
const FOLLOWUP_PRIORITIES = ["low", "medium", "high"];
const FOLLOWUP_STATUSES = ["pending", "completed", "cancelled"];
const FOLLOWUP_ORIGINS = ["agent", "system"];

const FollowUpSchema = new Schema(
    {
        userId: { type: Schema.Types.ObjectId, ref: "User", default: null },
        leadId: { type: Schema.Types.ObjectId, ref: "Lead", default: null },
        assignedTo: { type: String, default: null },
        type: { type: String, enum: FOLLOWUP_TYPES, required: true },
        priority: { type: String, enum: FOLLOWUP_PRIORITIES, default: "medium" },
        dueAt: { type: Date, required: true },
        status: { type: String, enum: FOLLOWUP_STATUSES, default: "pending" },
        notes: { type: String, default: null },
        completedAt: { type: Date, default: null },

        // CRM plan item 5 — set the first time the daily reminder job
        // (api/_lib/routes/leads/follow-ups-remind-cron.js) emails the assigned agent
        // and the customer about this follow-up, so it's never emailed
        // twice. Null = not yet reminded.
        reminderSentAt: { type: Date, default: null },

        // Who put this task here. "agent" = a person scheduled it through
        // POST /api/leads/:id/follow-ups; "system" = the CRM created it
        // itself (today: the first-contact call task — see
        // api/_lib/firstContactTask.js). The distinction is not cosmetic:
        // followUpNotify.js never emails the CUSTOMER about a "system"
        // task, because a student agreed to no such appointment. Defaults
        // to "agent" so every follow-up written before this field existed
        // keeps its original, human-scheduled meaning.
        origin: { type: String, enum: FOLLOWUP_ORIGINS, default: "agent" },
    },
    { timestamps: true }
);

// userId: query pattern = "all follow-ups concerning this user".
FollowUpSchema.index({ userId: 1 });
// leadId: query pattern = "all follow-ups tied to this Lead".
FollowUpSchema.index({ leadId: 1 });
// assignedTo + dueAt: query pattern = an agent's daily/weekly task list,
// sorted by due date — the primary dashboard read this model exists for.
FollowUpSchema.index({ assignedTo: 1, dueAt: 1 });
// status + dueAt: query pattern = "overdue pending follow-ups across
// everyone" (ops/manager view, and the basis for a future reminder job).
FollowUpSchema.index({ status: 1, dueAt: 1 });

module.exports = mongoose.models.FollowUp || mongoose.model("FollowUp", FollowUpSchema);
// Milestone 23.11 — exposed as static exports (same convention as
// Discovery.js/Meeting.js/AccommodationCuration.js) so
// api/leads/[id]/follow-ups/*.js can validate against these same enums
// without redeclaring them.
module.exports.FOLLOWUP_TYPES = FOLLOWUP_TYPES;
module.exports.FOLLOWUP_PRIORITIES = FOLLOWUP_PRIORITIES;
module.exports.FOLLOWUP_STATUSES = FOLLOWUP_STATUSES;
module.exports.FOLLOWUP_ORIGINS = FOLLOWUP_ORIGINS;
