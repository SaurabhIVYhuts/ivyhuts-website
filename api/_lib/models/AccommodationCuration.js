// One document per Lead — the agent's persistent, curated accommodation
// shortlist for that lead's Find Rooms workflow (Milestone 23.6). Backs
// GET/PUT /api/leads/:id/accommodation-curation.
//
// Deliberately its own concept, not a second "Competitive Analysis" — the
// CRM frontend's src/types/competitiveAnalysis.ts describes a contract
// that was never actually implemented backend-side (confirmed absent by
// direct repo inspection, Milestones 23.2/23.6). This model reuses that
// same, already-proven SHAPE (top-level recommendedPropertyId +
// recommendationReason, per-property advantages/disadvantages as plain
// strings) rather than the Milestone 23.6 brief's more elaborate suggested
// schema (separate top-level advantages[]/disadvantages[] arrays), because
// the CRM's actual Milestone 23.5 ShortlistEntry state already carries
// advantages/disadvantages per-property directly — matching that avoids a
// translation layer between UI state and the persisted document.
//
// Properties are stored as a lightweight CANONICAL SNAPSHOT (Milestone
// 23.1 CanonicalProperty fields) — never a raw provider response, never
// Amber data. Identity is `provider` + `providerPropertyId` + the derived
// `propertyId` (see ivyhuts-crm's src/lib/property-intelligence/identity.ts)
// — two properties are never merged/deduplicated here just because their
// names look similar; that rule lives entirely in the CRM/provider layer
// and this model just stores whatever distinct propertyIds the agent chose.
const mongoose = require("mongoose");
const { Schema } = mongoose;

// Kept in sync with api/_lib/providers/accommodation/types.js's PROVIDERS
// (Milestone 23.3) — the exhaustive, real provider set. Amber is
// deliberately not here and must never be added.
const PROVIDERS = ["uhomes", "uniacco", "university_living", "gradding_homes"];
const RENT_PERIODS = ["week", "month", "night", "unknown"];
const AVAILABILITY_VALUES = ["available", "unavailable", "unknown"];

const UniversitySnapshotSchema = new Schema(
    {
        id: { type: String, default: null },
        name: { type: String, required: true },
        city: { type: String, default: null },
        country: { type: String, default: null },
        latitude: { type: Number, default: null },
        longitude: { type: Number, default: null },
    },
    { _id: false }
);

// What Find Rooms criteria produced this shortlist — a SNAPSHOT, never a
// second source of truth for the lead's current requirements (Discovery
// remains authoritative; see Milestone 23.6 Part 8/20). Used only to
// detect staleness against the CRM's live deriveFindRoomsRequirements().
const CriteriaSnapshotSchema = new Schema(
    {
        university: { type: UniversitySnapshotSchema, required: true },
        budgetMin: { type: Number, default: null },
        budgetMax: { type: Number, default: null },
        currency: { type: String, default: null },
        sharing: { type: Number, required: true },
        roomType: { type: String, default: null },
        moveInDate: { type: String, default: null },
        stayDurationMonths: { type: Number, default: null },
        preferredDistance: { type: Number, default: null },
        amenities: { type: [String], default: [] },
    },
    { _id: false }
);

const CuratedPropertySchema = new Schema(
    {
        // Identity — see this file's header comment. providerPropertyId may
        // be null (URL/slug-derived identity, Milestone 23.1's fallback
        // rule); propertyId is always required and is what recommendedPropertyId
        // below must match.
        provider: { type: String, enum: PROVIDERS, required: true },
        providerPropertyId: { type: String, default: null },
        propertyId: { type: String, required: true },

        name: { type: String, required: true },
        url: { type: String, default: null },
        slug: { type: String, default: null },
        image: { type: String, default: null },
        city: { type: String, default: null },
        country: { type: String, default: null },
        latitude: { type: Number, default: null },
        longitude: { type: Number, default: null },

        rent: { type: Number, default: null },
        rentPerWeek: { type: Number, default: null },
        currency: { type: String, default: null },
        rentPeriod: { type: String, enum: RENT_PERIODS, default: "unknown" },

        roomType: { type: String, default: null },
        sharing: { type: Number, default: null },
        availability: { type: String, enum: AVAILABILITY_VALUES, default: "unknown" },

        amenities: { type: [String], default: [] },
        // Distance AT SEARCH TIME — a snapshot, same reasoning as
        // criteriaSnapshot; never recomputed here.
        distanceFromUniversityKm: { type: Number, default: null },

        // Curated, agent-written — never a raw provider field. Kept
        // per-property (not a top-level array) so removing a property
        // removes its notes with it automatically.
        advantages: { type: String, default: null },
        disadvantages: { type: String, default: null },

        // Provider-specific metadata that doesn't fit the canonical shape
        // above — isolated here per Milestone 23.1's own rule ("only when
        // genuinely required"), never the raw response body.
        providerMeta: { type: Schema.Types.Mixed, default: null },
    },
    { _id: false }
);

const AccommodationCurationSchema = new Schema(
    {
        leadId: { type: Schema.Types.ObjectId, ref: "Lead", required: true, unique: true },

        criteriaSnapshot: { type: CriteriaSnapshotSchema, default: null },
        properties: { type: [CuratedPropertySchema], default: [] },

        // Validated at the API layer (api/leads/[id]/accommodation-curation.js)
        // to always reference a propertyId actually present in `properties`
        // above — never enforced at the schema level alone, since Mongoose
        // has no clean cross-field validator for "must equal one of this
        // array's ids" that also runs on every partial update path.
        recommendedPropertyId: { type: String, default: null },
        recommendationReason: { type: String, default: null },

        notes: { type: String, default: null },

        // Identity always comes from the authenticated session
        // (api/_lib/businessAuth.js's requireRole) — never from the
        // request body. createdBy is set once, on first insert, via
        // $setOnInsert; updatedBy is set on every save.
        createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
        updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    },
    { timestamps: true }
);

// leadId already gets a unique index from `unique: true` above — one
// curation document per lead, matching PUT's upsert-by-leadId semantics.

module.exports = mongoose.models.AccommodationCuration || mongoose.model("AccommodationCuration", AccommodationCurationSchema);
module.exports.PROVIDERS = PROVIDERS;
module.exports.RENT_PERIODS = RENT_PERIODS;
module.exports.AVAILABILITY_VALUES = AVAILABILITY_VALUES;
