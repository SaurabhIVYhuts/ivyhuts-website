// Ivy Assistant request log (Phase 1) — one document per POST /api/assistant
// request, written in a `finally` so it is recorded whether the request
// succeeded, errored, was rate-limited, or hit the iteration cap.
//
// This is an audit/telemetry record, NOT conversation storage: the
// transcript is stateless and client-held (see the endpoint's header
// comment). We deliberately do not persist message content here — only
// counts, which tools ran, token usage, and the outcome — so this
// collection never becomes a shadow copy of customer conversations.
const mongoose = require("mongoose");
const { Schema } = mongoose;

const OUTCOMES = ["ok", "error", "rate_limited", "cap"];

const AssistantLogSchema = new Schema(
    {
        userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
        // Explicit (not `timestamps`) — the spec's field list names
        // `createdAt` and there is no meaningful `updatedAt` for a
        // write-once record.
        createdAt: { type: Date, default: Date.now },
        messageCount: { type: Number, default: 0 },
        toolCalls: {
            type: [
                new Schema(
                    {
                        name: { type: String },
                        args: { type: Schema.Types.Mixed },
                        ok: { type: Boolean },
                    },
                    { _id: false }
                ),
            ],
            default: [],
        },
        iterations: { type: Number, default: 0 },
        tokensIn: { type: Number, default: 0 },
        tokensOut: { type: Number, default: 0 },
        outcome: { type: String, enum: OUTCOMES, default: "ok" },
        errorMessage: { type: String, default: null },
    },
    { versionKey: false }
);

// Query pattern = "this user's recent assistant activity, newest first"
// (support / abuse investigation).
AssistantLogSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.models.AssistantLog || mongoose.model("AssistantLog", AssistantLogSchema);
module.exports.OUTCOMES = OUTCOMES;
