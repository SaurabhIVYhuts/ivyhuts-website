// One tiny document per city — a freshness pointer for the accommodation
// index (AccommodationResidence.js), so "is this city fresh/stale/missing"
// is a single O(1) indexed lookup instead of aggregating the (larger)
// residence collection on every planner request.
//
// lastRefreshedAt is updated on any successful (non-throwing) refresh
// attempt, including a legitimately empty result (status "empty") — only a
// genuinely thrown error (Amber timeout/budget/lock/Redis) leaves it
// untouched and sets status "error". See accommodationIndex.js's
// refreshCityIndex() for why: an empty-but-valid city must still start the
// freshness clock, or it would look "missing" forever and re-attempt a
// refresh on every single request instead of respecting the 30min/24h window.
const mongoose = require("mongoose");
const { Schema } = mongoose;

const AccommodationIndexMetaSchema = new Schema({
    city: { type: String, required: true, unique: true }, // normalized, same as AccommodationResidence.city
    lastRefreshedAt: { type: Date, default: null },
    status: { type: String, enum: ["ok", "empty", "error"], default: "error" },
    residenceCount: { type: Number, default: 0 },
});

module.exports = mongoose.models.AccommodationIndexMeta || mongoose.model("AccommodationIndexMeta", AccommodationIndexMetaSchema);
