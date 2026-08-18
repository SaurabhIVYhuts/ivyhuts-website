// The person/customer — central identity of the customer-journey model
// described in docs/marketing-data-architecture.md. This is deliberately
// NOT a login/account record: it holds no password and no session state.
//
// Authentication (password hash, sessions, rate limiting) stays in Redis
// for this milestone (api/_lib/userStore.js, session.js) — see the
// "Redis User -> MongoDB migration plan" in docs/marketing-data-architecture.md
// for exactly what moves here later and how. Duplicating that here now
// would create two disagreeing sources of truth for the same account.
const mongoose = require("mongoose");
const { Schema } = mongoose;

// Kept in sync with api/_lib/models/Lead.js's LEAD_STATUSES (Milestone 22) —
// this denormalized snapshot field is not currently written by any code
// path (see customerView.js), but its enum must still accept every real
// Lead.status value.
const LEAD_STATUSES = ["new", "contacted", "qualified", "nurturing", "converted", "lost"];
const LEAD_TEMPERATURES = ["cold", "warm", "hot"];
const USER_ROLES = ["USER", "MARKETING_AGENT", "MARKETING_MANAGER", "ADMIN"];
const ACCOMMODATION_JOURNEY_STATUSES = [
    "LEAD",
    "ENQUIRY",
    "BOOKING_IN_PROGRESS",
    "BOOKED",
    "STAY_IN_PROGRESS",
    "MOVED_IN",
    "STAY_COMPLETED",
    "CANCELLED",
];

const UserSchema = new Schema(
    {
        email: { type: String, required: true, unique: true, lowercase: true, trim: true },
        name: { type: String, required: true, trim: true },
        // Required as of the mandatory-mobile-number signup change
        // (api/auth/signup.js validates and normalizes it before it ever
        // reaches this model). `required` is enforced by Mongoose only at
        // validate()/save() time, never on read — a document already in
        // the database from before this change, with no phone, stays
        // exactly as it is and remains fully readable; it only becomes
        // invalid if something later tries to .save() it without a phone.
        // No backfill/migration was run against existing documents; see
        // api/_lib/businessAuth.js's resolveMongoUser for the one place
        // this can surface today (a pre-existing Redis user with no phone
        // hitting the lazy Mongo-user-creation path for the first time).
        phone: { type: String, required: true, trim: true },

        // Business authorization data (Milestone 2) — deliberately lives here,
        // not in Redis: it's a property of the customer/business record, not
        // of an auth session. Redis remains the sole source of the password
        // hash and session state; this field only ever gates access to the
        // internal business API (api/_lib/businessAuth.js), never login itself.
        role: { type: String, enum: USER_ROLES, default: "USER", index: true },

        auth: {
            emailVerified: { type: Boolean, default: false },
            // Separate from the schema-level createdAt/updatedAt below: a
            // person can exist as a Lead (from an anonymous enquiry) before
            // ever creating login credentials, so "when this User document
            // was first created" and "when auth credentials were attached"
            // are not always the same moment.
            createdAt: { type: Date, default: Date.now },
            lastLoginAt: { type: Date, default: null },
        },

        profile: {
            country: { type: String, default: null },
            city: { type: String, default: null },
            preferredCountries: { type: [String], default: [] },
            preferredCities: { type: [String], default: [] },
            otherPreferences: { type: Schema.Types.Mixed, default: {} },
        },

        // Optional — a person can be a User without ever providing a
        // university (e.g. a property owner, or a signup with no academic
        // affiliation yet). All three sub-fields are independently
        // optional; captured for future CRM/customer filtering by
        // institution, not used by any query/segmentation logic yet.
        university: {
            name: { type: String, trim: true },
            city: { type: String, trim: true },
            country: { type: String, trim: true },
        },

        marketing: {
            source: { type: String, default: null },
            medium: { type: String, default: null },
            campaign: { type: String, default: null },
            subscribed: { type: Boolean, default: false },
            consent: { type: Boolean, default: false },
            consentAt: { type: Date, default: null },
        },

        // Business qualification snapshot for quick reads (e.g. rendering a
        // user list). The authoritative, append-only history of a lead's
        // lifecycle lives in the separate Lead collection — this is
        // intentionally a denormalized convenience field, not a
        // replacement for it.
        lead: {
            status: { type: String, enum: LEAD_STATUSES, default: "new" },
            score: { type: Number, default: 0 },
            assignedTo: { type: String, default: null },
            temperature: { type: String, enum: LEAD_TEMPERATURES, default: "cold" },
        },

        // Marketing/customer-lifecycle tracking — NOT an Amber field, and
        // never populated from or synced to Amber. Distinct from `lead`
        // above: `lead` is pre-conversion sales qualification, this is the
        // full journey including what happens *after* a booking exists
        // (purchase, move-in, stay, move-out), which `lead` has no concept
        // of. Lets the business later segment on purchase timing, expected
        // vs. actual move-in/move-out, and stay duration — no such query
        // logic is implemented in this milestone, only the fields it needs.
        accommodationJourney: {
            status: {
                type: String,
                enum: ACCOMMODATION_JOURNEY_STATUSES,
                default: "LEAD",
                index: true,
            },
            servicePurchased: { type: Boolean, default: false },
            purchasedAt: { type: Date, default: null },
            moveInDate: { type: Date, default: null },
            expectedStayDurationMonths: { type: Number, min: 0, default: null },
            expectedMoveOutDate: { type: Date, default: null },
            actualMoveInDate: { type: Date, default: null },
            actualMoveOutDate: { type: Date, default: null },
        },
    },
    { timestamps: true }
);

// email: query pattern = login lookup / dedupe check by exact email.
// `unique: true` above already creates this index; no separate call needed.
// createdAt: query pattern = "new users in date range" reporting.
UserSchema.index({ createdAt: -1 });
// marketing.source: query pattern = "how many users came from campaign X".
UserSchema.index({ "marketing.source": 1 });
// lead.status: query pattern = admin dashboard filtering by pipeline stage.
UserSchema.index({ "lead.status": 1 });
// lead.score: query pattern = sorting/filtering for highest-priority leads.
UserSchema.index({ "lead.score": -1 });

module.exports = mongoose.models.User || mongoose.model("User", UserSchema);
