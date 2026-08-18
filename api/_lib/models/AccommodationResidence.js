// Student Planner accommodation index — one row per Amber property, per city.
// This is a normalized MIRROR for local discovery/ranking, not a competing
// source of truth: Amber remains authoritative, and the detailed property
// page still goes through the existing /api/amber -> amberGateway path.
// See api/_lib/accommodationIndex.js for how this collection is populated
// (only ever from fetchListings()'s own already-budgeted/locked results —
// this file never calls Amber itself).
//
// Deliberately narrow: only the fields the compact planner card
// (src/components/planner/ResidenceCard.js) and local ranking actually use.
// No amenities, no room/tenancy detail, no raw Amber payload — that would be
// exactly the "unnecessary duplicate storage" this index must avoid.
const mongoose = require("mongoose");
const { Schema } = mongoose;

const AccommodationResidenceSchema = new Schema(
    {
        source: { type: String, required: true, default: "amber" },
        propertyId: { type: String, required: true },
        slug: { type: String, default: null },
        propertyName: { type: String, required: true },
        // Normalized via amberGateway's own normalizeCityName — every read
        // path must normalize the same way, or a query can silently miss rows.
        city: { type: String, required: true },
        country: { type: String, default: null },
        // Used for real Haversine distance-to-university ranking (Milestone 3)
        // when both this residence and the resolved university have real
        // coordinates; null residences fall back gracefully — see
        // accommodationIndex.js's rankingDistanceKm transform.
        latitude: { type: Number, default: null },
        longitude: { type: Number, default: null },
        price: {
            amount: { type: Number, default: null },
            currency: { type: String, default: null },
        },
        // Raw Amber billing period ("week"/"month"/"term"/etc, normalized via
        // the same .replace(/ly$/, "") transform src/services/amberMapper.js
        // already uses) — kept for accurate display (a monthly property must
        // never be shown mislabeled as weekly).
        priceDuration: { type: String, default: null },
        // Derived at mapping time: price.amount converted to a weekly
        // equivalent for budget-fit ranking. null (not a guessed "week") when
        // priceDuration is missing or an unrecognized period (e.g. "term") —
        // see accommodationIndex.js's rankResidences, which already treats an
        // unusable factor as "redistribute weight", never "assume a value".
        priceWeekly: { type: Number, default: null },
        image: { type: String, default: null },
        rating: { type: Number, default: null }, // 0-5, averaged from Amber's review categories
        roomType: { type: String, default: null },
        distanceToCentreKm: { type: Number, default: null }, // Amber-reported, parsed
        // Real, Amber-reported "nearby place" names (raw.meta.distances[].place)
        // that look like a university/college — same free-text signal
        // PropertyListingPage.js's own "University / Area" proximity filter
        // already trusts (UNIVERSITY_RE). NOT a fabricated or curated list:
        // extracted verbatim from data Amber already sent for this exact
        // property. This is what lets api/_lib/searchIndex.js's global search
        // cover every real university/college actually present in the
        // inventory, not just the ~26 entries hand-curated in
        // campusUniversities.json — see accommodationIndex.js's
        // getNearbyUniversities() for the extraction itself.
        nearbyUniversities: { type: [String], default: [] },
        available: { type: Boolean, default: true },
        // Added when this index started backing the general property browse/
        // search page (api/city-listings.js), not just the Planner's compact
        // recommendation card — that page's cards show amenity chips, badges,
        // a room-count line and nearby-place distances, none of which the
        // original narrow shape above carried. Same "real data, never
        // fabricated" rule as every other field here: extracted verbatim from
        // Amber's own response by mapAmberItemToResidence, just not captured
        // until now. Existing rows backfill gradually as the background
        // full-catalog crawl (api/_lib/insightsMarket.js) and real page views
        // (index-on-read, api/amber.js) re-touch them — never all at once,
        // since re-fetching every already-indexed property live would blow
        // past Amber's rate limit.
        amenities: { type: [String], default: [] },
        badges: { type: [String], default: [] },
        offerText: { type: String, default: null },
        billsIncluded: { type: Boolean, default: false },
        roomsCount: { type: Number, default: null },
        roomTypes: { type: [String], default: [] },
        nearbyPlaces: { type: [{ place: String, distance: String, _id: false }], default: [] },
        socialShortlisted: { type: String, default: null },
    },
    { timestamps: true }
);

// Idempotent-upsert identity — refreshCityIndex() always upserts by this
// pair, never inserts blindly, so re-indexing the same property is a no-op
// update rather than a duplicate row.
AccommodationResidenceSchema.index({ source: 1, propertyId: 1 }, { unique: true });
// Query pattern: "residences for city X" — the only lookup this milestone does.
AccommodationResidenceSchema.index({ city: 1 });
// Query pattern: "residences for country X" — used by the global search
// index (api/_lib/searchIndex.js) to back a country search with real
// properties, same normalized-field convention as the city index above.
AccommodationResidenceSchema.index({ country: 1 });
// Free-text property-name search, used by api/_lib/searchIndex.js's global
// search autocomplete. propertyName weighted highest since a property-name
// query should out-rank an incidental city/country substring match. This
// collection is populated two ways: opportunistically ("index-on-read" — see
// api/amber.js) from every real listings/detail response the site already
// fetches, AND comprehensively by api/_lib/insightsMarket.js's existing
// full-catalog crawl (see its own header) — so coverage grows toward the
// complete Amber catalog over that crawl's normal cycle, not just from real
// traffic. Kept as a text index rather than the sole lookup mechanism —
// searchIndex.js's actual property search still uses a plain regex (see its
// own header comment on why: partial-word matches like "LST Vent" ->
// "LST Venti House" that $text's word-tokenized search would miss).
AccommodationResidenceSchema.index(
  { propertyName: "text", city: "text", country: "text" },
  { weights: { propertyName: 10, city: 4, country: 2 }, name: "search_text" }
);
// Plain (non-text) indexes on the exact fields a lookup-by-identity query
// would use — cheap at this collection's size (low thousands of documents,
// well within a single index page), but future-proofs against needing a
// collection scan if a caller ever queries by exact propertyName or slug
// instead of the regex/aggregate patterns this file already uses.
AccommodationResidenceSchema.index({ propertyName: 1 });
AccommodationResidenceSchema.index({ slug: 1 });
// Backs api/_lib/searchIndex.js's comprehensive (not curated-only) university
// list — a $unwind + $group aggregation over this field to get every
// distinct real nearby-university name in the inventory.
AccommodationResidenceSchema.index({ nearbyUniversities: 1 });

module.exports = mongoose.models.AccommodationResidence || mongoose.model("AccommodationResidence", AccommodationResidenceSchema);
