// One document per Lead — the agent's record of a student's actual
// accommodation requirements, captured during Discovery. Backs GET/PUT
// /api/leads/:id/discovery (Milestone 23.7).
//
// This RECONCILES with the pre-existing CRM contract (src/types/
// discovery.ts in ivyhuts-crm, verified directly before writing this) —
// it does not replace it. `student.university`/`accommodation.
// roomPreference` and every other pre-23.7 field keep their exact existing
// meaning; only three fields are new:
//   - student.universityResolved — a resolved university SNAPSHOT (id,
//     name, city, country, latitude, longitude), populated only when the
//     agent's typed `university` text was actually resolved via
//     GET /api/universities/resolve (api/_lib/campusUniversities.json
//     remains the one authoritative dataset — this is never a second
//     university database, just a per-Discovery cached result of resolving
//     against it). `university` (free text) stays authoritative for what
//     was actually typed/heard; this is enrichment, never a replacement,
//     and can be null even when `university` is set (unresolved).
//   - accommodation.currency — required whenever budgetMin/budgetMax is
//     set (validated at the route layer, not schema level, so a
//     currency-less legacy record already saved before this milestone
//     doesn't become schema-invalid on read).
//   - accommodation.sharing — number of people sharing the room/unit.
//     Distinct from roomPreference (a free-text room-TYPE descriptor —
//     "ensuite", "studio", "shared bathroom" — never a people-count).
//     Nullable, and NEVER guessed at write time — see
//     api/leads/[id]/discovery.js's header comment for the read-time
//     legacy-derivation story (that derivation lives in the CRM's
//     deriveFindRoomsRequirements(), not here, so there is exactly one
//     place that logic can ever live).
const mongoose = require("mongoose");
const { Schema } = mongoose;

const DISCOVERY_PRIORITY_FACTORS = ["budget", "distance", "travel_convenience", "amenities", "location", "property_quality", "other"];

const UniversitySnapshotSchema = new Schema(
    {
        id: { type: String, required: true },
        name: { type: String, required: true },
        city: { type: String, default: null },
        country: { type: String, default: null },
        latitude: { type: Number, default: null },
        longitude: { type: Number, default: null },
    },
    { _id: false }
);

const DiscoverySchema = new Schema(
    {
        leadId: { type: Schema.Types.ObjectId, ref: "Lead", required: true, unique: true },

        student: {
            university: { type: String, default: null },
            universityResolved: { type: UniversitySnapshotSchema, default: null },
            course: { type: String, default: null },
            intake: { type: String, default: null },
        },

        accommodation: {
            budgetMin: { type: Number, default: null },
            budgetMax: { type: Number, default: null },
            currency: { type: String, default: null },
            moveInDate: { type: String, default: null },
            stayDurationMonths: { type: Number, default: null },
            preferredLocation: { type: String, default: null },
            roomPreference: { type: String, default: null },
            sharing: { type: Number, default: null },
            distancePreference: { type: String, default: null },
        },

        priorities: { type: [String], enum: DISCOVERY_PRIORITY_FACTORS, default: [] },
        notes: { type: String, default: null },

        // Identity always from the authenticated session
        // (api/_lib/businessAuth.js) — never the request body. createdBy is
        // set once via $setOnInsert; updatedBy on every save.
        createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
        updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    },
    { timestamps: true }
);

// leadId already gets a unique index from `unique: true` above — one
// Discovery document per lead, matching PUT's upsert-by-leadId semantics
// (same pattern as AccommodationCuration.js).

module.exports = mongoose.models.Discovery || mongoose.model("Discovery", DiscoverySchema);
module.exports.DISCOVERY_PRIORITY_FACTORS = DISCOVERY_PRIORITY_FACTORS;
