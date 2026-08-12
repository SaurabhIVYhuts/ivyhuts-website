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
        available: { type: Boolean, default: true },
    },
    { timestamps: true }
);

// Idempotent-upsert identity — refreshCityIndex() always upserts by this
// pair, never inserts blindly, so re-indexing the same property is a no-op
// update rather than a duplicate row.
AccommodationResidenceSchema.index({ source: 1, propertyId: 1 }, { unique: true });
// Query pattern: "residences for city X" — the only lookup this milestone does.
AccommodationResidenceSchema.index({ city: 1 });

module.exports = mongoose.models.AccommodationResidence || mongoose.model("AccommodationResidence", AccommodationResidenceSchema);
