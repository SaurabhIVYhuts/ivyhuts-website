// Behavioural history — the single most important model for understanding
// the customer journey (browse -> filter -> view -> wishlist -> enquire ->
// convert) described in docs/marketing-data-architecture.md.
//
// Deliberately its OWN top-level collection, never an embedded array on
// User (e.g. User.events[]) — event volume per user is unbounded over a
// long relationship, and MongoDB documents have a 16MB hard limit;
// embedding would eventually corrupt or fail to write the User document
// entirely. See docs/marketing-data-architecture.md section M for the
// retention-policy discussion (no TTL index yet, and why).
//
// Both userId and anonymousId are optional and independent: a visitor can
// generate events before ever creating an account. Associating that
// anonymous history with a User created later ("identity stitching") is
// explicitly a future milestone's job, not implemented here — this schema
// only needs to make both fields available to query on.
const mongoose = require("mongoose");
const { Schema } = mongoose;

const UserEventSchema = new Schema(
    {
        userId: { type: Schema.Types.ObjectId, ref: "User", default: null },
        anonymousId: { type: String, default: null },
        event: { type: String, required: true }, // e.g. PAGE_VIEWED, PROPERTY_VIEWED, PROPERTY_WISHLISTED, SIGNUP, ENQUIRY_SUBMITTED
        properties: { type: Schema.Types.Mixed, default: {} }, // event-specific payload, e.g. { propertyId, city }
        metadata: { type: Schema.Types.Mixed, default: {} }, // request context, e.g. { source: "listing_page" }
        timestamp: { type: Date, default: Date.now, required: true },
    },
    // Events are immutable facts about something that already happened —
    // there is no "updatedAt" concept for an event, only when it was
    // recorded (createdAt) and when it occurred (timestamp; usually the
    // same instant, but kept separate in case events are ever ingested
    // slightly after the fact).
    { timestamps: { createdAt: true, updatedAt: false } }
);

// userId + timestamp: query pattern = "this user's activity timeline",
// most recent first.
UserEventSchema.index({ userId: 1, timestamp: -1 });
// anonymousId + timestamp: same, for pre-signup visitors.
UserEventSchema.index({ anonymousId: 1, timestamp: -1 });
// event + timestamp: query pattern = "all PROPERTY_VIEWED events this week"
// (funnel/conversion analysis across all users).
UserEventSchema.index({ event: 1, timestamp: -1 });
// timestamp alone: query pattern = general time-range queries/exports and
// whatever future retention/archival job runs (see docs, section M).
UserEventSchema.index({ timestamp: -1 });

module.exports = mongoose.models.UserEvent || mongoose.model("UserEvent", UserEventSchema);
