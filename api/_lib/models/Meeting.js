// One document per meeting scheduled/held for a Lead — Milestone 23.10.
// One-to-MANY: a Lead can have several Meetings over time (unlike Discovery
// /AccommodationCuration, which are one-to-one — see this model's own
// index, no unique constraint on leadId). Backs
// GET/POST /api/leads/:id/meetings and GET/PATCH
// /api/leads/:id/meetings/:meetingId.
//
// This model stores MEETING information only — status, timing, and the
// state of a recording/transcript if one exists. It never duplicates
// Discovery's customer-requirement fields (university/budget/sharing) and
// never stores requirement values itself; a meeting's transcript is meant
// to eventually INFORM Discovery (via an agent manually reading it and
// updating Discovery with requirementSources.<field> = "meeting"/
// "transcript" — see Discovery.js's own header comment), never replace it.
//
// No recording/transcription provider integration exists in this
// repository (confirmed by inspection, Milestone 23.9/23.10 audits) —
// recordingUrl/transcriptReference are opaque strings an agent enters
// manually (e.g. a link to wherever the recording actually lives today),
// never fetched, validated against, or interpreted by this backend. This
// is the internal state machine only, ready for a real provider to plug
// into later without a schema change.
const mongoose = require("mongoose");
const { Schema } = mongoose;

const MEETING_STATUSES = ["scheduled", "completed", "cancelled"];
// "none" = no recording/transcript is expected to exist yet for this
// meeting; distinct from "pending" (expected, not yet available).
const MEDIA_STATUSES = ["none", "pending", "available"];

const MeetingSchema = new Schema(
    {
        leadId: { type: Schema.Types.ObjectId, ref: "Lead", required: true },

        status: { type: String, enum: MEETING_STATUSES, default: "scheduled" },
        scheduledAt: { type: Date, required: true },
        completedAt: { type: Date, default: null },

        recordingStatus: { type: String, enum: MEDIA_STATUSES, default: "none" },
        // Required to be non-empty exactly when recordingStatus === "available",
        // and required to be null otherwise — enforced at the route layer
        // (api/leads/[id]/meetings/[meetingId]/index.js), same "validate the
        // effective merged state" convention as discovery.js.
        recordingUrl: { type: String, default: null },

        transcriptStatus: { type: String, enum: MEDIA_STATUSES, default: "none" },
        transcriptReference: { type: String, default: null },

        notes: { type: String, default: null },

        // Identity always from the authenticated session
        // (api/_lib/businessAuth.js) — never the request body.
        createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
        updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    },
    { timestamps: true }
);

// leadId + scheduledAt: query pattern = "every meeting for this lead,
// chronological" — the only query this model's routes ever run.
MeetingSchema.index({ leadId: 1, scheduledAt: -1 });

module.exports = mongoose.models.Meeting || mongoose.model("Meeting", MeetingSchema);
module.exports.MEETING_STATUSES = MEETING_STATUSES;
module.exports.MEDIA_STATUSES = MEDIA_STATUSES;
