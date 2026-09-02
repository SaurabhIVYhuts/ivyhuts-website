// One document per meeting scheduled/held for a Lead — Milestone 23.10,
// extended Milestone 23.14.
// One-to-MANY: a Lead can have several Meetings over time (unlike Discovery
// /AccommodationCuration, which are one-to-one — see this model's own
// index, no unique constraint on leadId). Backs
// GET/POST /api/leads/:id/meetings and GET/PATCH
// /api/leads/:id/meetings/:meetingId.
//
// This model stores MEETING information only — status, timing, and the
// state of a recording/transcript if one exists. It never duplicates
// Discovery's customer-requirement fields (university/budget/sharing) and
// never stores CONFIRMED requirement values itself; a meeting's transcript
// is meant to eventually INFORM Discovery (via an agent reviewing
// `extractedRequirements` below and updating Discovery with
// requirementSources.<field> = "meeting"/"transcript" — see Discovery.js's
// own header comment), never replace it. `extractedRequirements` is a
// SUGGESTION attached to this specific meeting, not a second permanent
// requirements record — it has no lifecycle of its own beyond "pending
// review" / "reviewed", and Discovery remains the only canonical
// requirement store in this backend.
//
// Milestone 23.9/23.10 confirmed no recording/transcription/video provider
// integration existed. Milestone 23.14 adds the REAL Google Meet
// provider contract (provider/providerMeetingId/meetingUrl — see
// api/_lib/providers/meeting/googleMeetProvider.js) plus a real,
// agent-pasted transcript TEXT field feeding real AI-assisted extraction
// (api/_lib/transcriptExtraction.js) — both fail closed (provider/
// meetingUrl stay null, extractedRequirements stays null) when their
// respective credentials aren't configured, exactly as this model's
// original comment anticipated: "ready for a real provider to plug into
// later without a schema change" wherever a schema change genuinely
// wasn't needed, and a minimal, justified one here where it was.
// recordingUrl/transcriptReference remain opaque, agent-entered strings —
// still never fetched or interpreted by this backend.
const mongoose = require("mongoose");
const { Schema } = mongoose;

const MEETING_STATUSES = ["scheduled", "completed", "cancelled"];
// "none" = no recording/transcript is expected to exist yet for this
// meeting; distinct from "pending" (expected, not yet available).
const MEDIA_STATUSES = ["none", "pending", "available"];
// "google_meet" is the only real provider today; null = no video-conference
// provider attempt was made (or it wasn't configured) for this meeting —
// the meeting itself is still perfectly valid as a manually-tracked event.
const MEETING_PROVIDERS = ["google_meet"];
const EXTRACTION_STATUSES = ["pending_review", "reviewed"];

// One suggested value per Discovery-shaped field, extracted from this
// meeting's transcriptText. Every field independently nullable — only what
// the transcript actually, explicitly supports is ever populated; missing
// information stays null, never guessed (Milestone 23.14 Part 16).
const ExtractedRequirementsSchema = new Schema(
    {
        status: { type: String, enum: EXTRACTION_STATUSES, default: "pending_review" },
        extractedAt: { type: Date, default: null },
        university: { type: String, default: null },
        course: { type: String, default: null },
        intake: { type: String, default: null },
        budgetMin: { type: Number, default: null },
        budgetMax: { type: Number, default: null },
        currency: { type: String, default: null },
        moveInDate: { type: String, default: null },
        stayDurationMonths: { type: Number, default: null },
        preferredLocation: { type: String, default: null },
        roomPreference: { type: String, default: null },
        sharing: { type: Number, default: null },
        distancePreference: { type: String, default: null },
        priorities: { type: [String], default: [] },
        notes: { type: String, default: null },
    },
    { _id: false }
);

const MeetingSchema = new Schema(
    {
        leadId: { type: Schema.Types.ObjectId, ref: "Lead", required: true },

        status: { type: String, enum: MEETING_STATUSES, default: "scheduled" },
        scheduledAt: { type: Date, required: true },
        completedAt: { type: Date, default: null },

        // Milestone 23.14 — set only by a real, successful
        // googleMeetProvider.createMeeting() call. Never set from a client
        // request body (see api/leads/[id]/meetings/index.js) and never a
        // fabricated/generated URL — see that provider's own header comment.
        provider: { type: String, enum: MEETING_PROVIDERS, default: null },
        providerMeetingId: { type: String, default: null },
        meetingUrl: { type: String, default: null },

        recordingStatus: { type: String, enum: MEDIA_STATUSES, default: "none" },
        // Required to be non-empty exactly when recordingStatus === "available",
        // and required to be null otherwise — enforced at the route layer
        // (api/leads/[id]/meetings/[meetingId]/index.js), same "validate the
        // effective merged state" convention as discovery.js.
        recordingUrl: { type: String, default: null },

        transcriptStatus: { type: String, enum: MEDIA_STATUSES, default: "none" },
        transcriptReference: { type: String, default: null },
        // Milestone 23.14 — the actual transcript CONTENT, when an agent has
        // pasted it in (e.g. from Google Meet's own native transcript
        // export). Distinct from transcriptReference (a link/pointer) —
        // this is real text this backend can actually process. Never
        // fetched from anywhere automatically; always agent-provided.
        transcriptText: { type: String, default: null },
        // Milestone 23.14 — the most recent extraction run against
        // transcriptText, or null if extraction has never been run (no
        // transcriptText yet, or GROQ_API_KEY not configured — see
        // api/_lib/transcriptExtraction.js). Overwritten by each new
        // extraction run; only ever a SUGGESTION, never written into
        // Discovery directly by any code path.
        extractedRequirements: { type: ExtractedRequirementsSchema, default: null },

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
module.exports.MEETING_PROVIDERS = MEETING_PROVIDERS;
module.exports.EXTRACTION_STATUSES = EXTRACTION_STATUSES;
