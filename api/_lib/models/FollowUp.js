// A sales action to take — "call this lead back Thursday", not a record of
// something that already happened (that's Communication). Schema only: no
// dashboard/reminder UI in this milestone.
const mongoose = require("mongoose");
const { Schema } = mongoose;

const FOLLOWUP_TYPES = ["call", "email", "whatsapp", "meeting", "other"];
const FOLLOWUP_PRIORITIES = ["low", "medium", "high"];
const FOLLOWUP_STATUSES = ["pending", "completed", "cancelled"];

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
