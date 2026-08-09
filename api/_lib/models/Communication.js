// Interaction history between IvyHuts and a customer — email, WhatsApp,
// phone, SMS, or system-generated (e.g. an automated confirmation). Schema
// only: no provider integration (Resend/WhatsApp/etc.) happens in this
// milestone. `content` will often hold real message text — see the privacy
// notes in docs/marketing-data-architecture.md before this is ever queried
// into a log line.
const mongoose = require("mongoose");
const { Schema } = mongoose;

const CHANNELS = ["email", "whatsapp", "phone", "sms", "system"];
const DIRECTIONS = ["inbound", "outbound"];

const CommunicationSchema = new Schema(
    {
        userId: { type: Schema.Types.ObjectId, ref: "User", default: null },
        leadId: { type: Schema.Types.ObjectId, ref: "Lead", default: null },
        channel: { type: String, enum: CHANNELS, required: true },
        direction: { type: String, enum: DIRECTIONS, required: true },
        type: { type: String, default: "general" }, // e.g. follow_up, enquiry_response, marketing, general
        content: { type: String, default: null },
        status: { type: String, default: null }, // channel-specific (e.g. sent/delivered/failed/read) — kept free-form until a provider is chosen
        agentId: { type: String, default: null },
        metadata: { type: Schema.Types.Mixed, default: {} },
    },
    { timestamps: true }
);

// userId + createdAt: query pattern = "this customer's communication
// history", chronological.
CommunicationSchema.index({ userId: 1, createdAt: -1 });
// leadId + createdAt: same, scoped to a specific Lead/opportunity.
CommunicationSchema.index({ leadId: 1, createdAt: -1 });
// agentId + createdAt: query pattern = "everything this agent sent/handled".
CommunicationSchema.index({ agentId: 1, createdAt: -1 });

module.exports = mongoose.models.Communication || mongoose.model("Communication", CommunicationSchema);
