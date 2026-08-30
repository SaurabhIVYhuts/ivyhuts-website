// One document per GENERATED VERSION of a lead's accommodation
// presentation deck (Milestone 23.8). Never overwritten — "Generate
// Presentation"/"Generate New Version" always INSERTS a new document with
// the next version number; V1 stays exactly as it was generated even after
// V2, V3, ... exist. Backs GET/POST /api/leads/:id/presentations,
// GET .../presentations/:presentationId, GET .../download.
//
// The ONLY source of truth this is ever generated from is the lead's saved
// AccommodationCuration (api/_lib/models/AccommodationCuration.js) — never
// CompetitiveAnalysis (confirmed backend-absent, Milestones 23.2/23.6) and
// never live Find Rooms search state. `snapshot` below is a DEEP COPY taken
// at generation time, not a reference — later edits to the live
// AccommodationCuration (or the provider properties it cites) must never
// change what an already-generated version renders/contains. This is what
// makes a version "immutable" per the milestone's explicit requirement.
const mongoose = require("mongoose");
const { Schema } = mongoose;
const AccommodationCuration = require("./AccommodationCuration");

const STATUSES = ["GENERATING", "READY", "FAILED"];

// Embedded copies of AccommodationCuration.js's own sub-shapes — deliberately
// NOT that model's actual sub-schemas (Mongoose schemas aren't meant to be
// shared as live references across two independently-evolving documents),
// but the enum arrays ARE imported directly from that model's own static
// exports so the two can never silently drift apart.
const SnapshotUniversitySchema = new Schema(
    {
        id: { type: String, default: null },
        name: { type: String, default: null },
        city: { type: String, default: null },
        country: { type: String, default: null },
        latitude: { type: Number, default: null },
        longitude: { type: Number, default: null },
    },
    { _id: false }
);

const SnapshotCriteriaSchema = new Schema(
    {
        university: { type: SnapshotUniversitySchema, default: null },
        budgetMin: { type: Number, default: null },
        budgetMax: { type: Number, default: null },
        currency: { type: String, default: null },
        sharing: { type: Number, default: null },
        roomType: { type: String, default: null },
        moveInDate: { type: String, default: null },
        stayDurationMonths: { type: Number, default: null },
        preferredDistance: { type: Number, default: null },
        amenities: { type: [String], default: [] },
    },
    { _id: false }
);

const SnapshotPropertySchema = new Schema(
    {
        provider: { type: String, enum: AccommodationCuration.PROVIDERS, required: true },
        providerPropertyId: { type: String, default: null },
        propertyId: { type: String, required: true },
        name: { type: String, required: true },
        url: { type: String, default: null },
        image: { type: String, default: null },
        city: { type: String, default: null },
        country: { type: String, default: null },
        rent: { type: Number, default: null },
        rentPerWeek: { type: Number, default: null },
        currency: { type: String, default: null },
        rentPeriod: { type: String, enum: AccommodationCuration.RENT_PERIODS, default: "unknown" },
        roomType: { type: String, default: null },
        sharing: { type: Number, default: null },
        availability: { type: String, enum: AccommodationCuration.AVAILABILITY_VALUES, default: "unknown" },
        amenities: { type: [String], default: [] },
        distanceFromUniversityKm: { type: Number, default: null },
        advantages: { type: String, default: null },
        disadvantages: { type: String, default: null },
    },
    { _id: false }
);

// Milestone 23.18 — a flattened copy of the CONFIRMED Discovery fields that
// actually drive personalization (client requirements slide, cover
// context, recommendation evidence). Deliberately its own schema, not a
// live reference to Discovery.js's own sub-schemas (same reasoning as
// every other Snapshot* schema in this file: two independently-evolving
// documents should never share a live schema reference) — and deliberately
// captures MORE than criteriaSnapshot above (which is Find-Rooms-search-
// shaped: no course/intake/preferredLocation-as-text/distancePreference-
// as-text/priorities/notes). Discovery remains the live source of truth;
// this is only ever a point-in-time copy for this one generated version.
const SnapshotDiscoverySchema = new Schema(
    {
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

const SnapshotSchema = new Schema(
    {
        criteriaSnapshot: { type: SnapshotCriteriaSchema, default: null },
        // Milestone 23.18 — null when the lead has no Discovery at all yet
        // (Discovery is optional at generation time — a curation can exist
        // without one in principle, though in practice Find Rooms requires
        // confirmed requirements to search at all).
        discoverySnapshot: { type: SnapshotDiscoverySchema, default: null },
        properties: { type: [SnapshotPropertySchema], default: [] },
        recommendedPropertyId: { type: String, default: null },
        recommendationReason: { type: String, default: null },
        notes: { type: String, default: null },
    },
    { _id: false }
);

// Records exactly which AccommodationCuration (and which version of it —
// via its updatedAt) this deck's snapshot was copied from. Purely
// informational/audit; never used to re-derive or re-fetch content later.
// Milestone 23.18 adds the same treatment for Discovery, now that
// generation reads it too (client requirements/personalization).
const ProvenanceSchema = new Schema(
    {
        accommodationCurationId: { type: Schema.Types.ObjectId, ref: "AccommodationCuration", default: null },
        accommodationCurationUpdatedAt: { type: Date, default: null },
        discoveryId: { type: Schema.Types.ObjectId, ref: "Discovery", default: null },
        discoveryUpdatedAt: { type: Date, default: null },
    },
    { _id: false }
);

const FileSchema = new Schema(
    {
        // The rendered .pptx bytes. Existing decks in this repo embed no
        // images (see pptDesignSystem.js's own header comment), so this
        // stays comfortably under MongoDB's 16MB document limit — no
        // external blob store exists in this codebase (confirmed by
        // inspection) and none is warranted at this size.
        data: { type: Buffer, default: null },
        filename: { type: String, default: null },
        mimeType: { type: String, default: null },
        sizeBytes: { type: Number, default: null },
    },
    { _id: false }
);

const PresentationSchema = new Schema(
    {
        leadId: { type: Schema.Types.ObjectId, ref: "Lead", required: true },
        version: { type: Number, required: true },
        title: { type: String, required: true },
        status: { type: String, enum: STATUSES, required: true },
        errorMessage: { type: String, default: null },

        snapshot: { type: SnapshotSchema, default: null },
        generatedFrom: { type: ProvenanceSchema, default: null },
        file: { type: FileSchema, default: null },

        createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    },
    { timestamps: true }
);

// One version number used at most once per lead — the DB-level backstop for
// the version-assignment logic in the route handler (which computes
// `next version = current max + 1` under an advisory lock; this index is
// what turns a hypothetical race into a clean 11000 duplicate-key error
// instead of two documents silently sharing a version number).
PresentationSchema.index({ leadId: 1, version: 1 }, { unique: true });
// The route's list/latest-version queries are always scoped to one lead,
// newest first.
PresentationSchema.index({ leadId: 1, createdAt: -1 });

module.exports = mongoose.models.Presentation || mongoose.model("Presentation", PresentationSchema);
module.exports.STATUSES = STATUSES;
