// Tier 2 of the University Housing discovery pipeline — a persistent cache
// of universities/schools previously discovered via Tier 3 (Nominatim
// geocoding, optionally AI-assisted candidate interpretation). This is
// purely a DISCOVERY cache: it is never read by, written by, or otherwise
// wired into the Amber accommodation pipeline (amberGateway.js,
// accommodationIndex.js) — a resolved record from here only ever supplies
// {city, latitude, longitude} to that EXISTING, unmodified pipeline
// downstream. See api/_lib/universityResolveService.js for the full
// escalation order this collection sits inside.
//
// Deliberately separate from the static, manually-curated
// campusUniversities.json (Tier 1, api/_lib/campusUniversityResolver.js):
// nothing discovered here is ever written back into that file. A student
// searching "University of Bristol" for the first time causes exactly one
// Tier 3 discovery (coalesced via a distributed lock — see
// universityDiscovery.js), which gets persisted as a row here; the next
// 1,000 students searching the same name hit this Mongo cache instead,
// with zero repeat Nominatim/AI calls.
const mongoose = require("mongoose");
const { Schema } = mongoose;

const UniversityIndexSchema = new Schema(
    {
        // Stable, URL/query-safe identifier for this discovered record —
        // same shape/purpose as campusUniversities.json's `id` field, so the
        // frontend can treat a Tier 1 and a Tier 2 record identically once
        // resolved (both just "a university object with an id").
        canonicalId: { type: String, required: true, unique: true },
        name: { type: String, required: true },
        // Lowercased/punctuation-stripped form of `name`, same normalize()
        // rule as campusUniversityResolver.js — indexed for exact-match
        // lookups without re-normalizing on every read.
        normalizedName: { type: String, required: true },
        aliases: { type: [String], default: [] },
        normalizedAliases: { type: [String], default: [] },
        type: { type: String, enum: ["UNIVERSITY", "SCHOOL", "OTHER"], default: "UNIVERSITY" },
        city: { type: String, required: true },
        country: { type: String, default: null },
        address: { type: String, default: null },
        latitude: { type: Number, required: true },
        longitude: { type: Number, required: true },
        // Where this record's coordinates ultimately came from. AI is never
        // a valid value here — the AI module only ever proposes a candidate
        // NAME to search for; every record actually stored must have been
        // independently verified against a trusted geocoding provider first
        // (see universityDiscovery.js's validateNominatimResult).
        source: { type: String, enum: ["nominatim"], required: true },
        // The upstream provider's own record id (Nominatim's osm_type+osm_id,
        // e.g. "way/12345") — kept for traceability/debugging, never used to
        // re-derive coordinates at read time.
        sourceId: { type: String, default: null },
        // Per the milestone's explicit persistence rule: a discovered record
        // is NOT automatically verified=true just because Nominatim returned
        // a plausible institution match. Existing architecture has no
        // pre-existing "verified" concept to extend, so this defaults to
        // false and is surfaced to the UI/report as "discovered, unverified"
        // — a human can promote it later via direct DB update if ever needed;
        // nothing in this codebase currently flips it automatically.
        verified: { type: Boolean, default: false },
        // False for a resolved-but-effectively-hidden record (none currently
        // set this — reserved for future manual moderation, e.g. hiding a
        // discovered non-institution that slipped through validation).
        searchable: { type: Boolean, default: true },
        lastVerifiedAt: { type: Date, default: Date.now },
    },
    { timestamps: true }
);

UniversityIndexSchema.index({ normalizedName: 1 });
UniversityIndexSchema.index({ normalizedAliases: 1 });

module.exports = mongoose.models.UniversityIndex || mongoose.model("UniversityIndex", UniversityIndexSchema);
