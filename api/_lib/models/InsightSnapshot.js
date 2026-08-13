// One document per calendar day of the /insight "Daily Sold-Out Market
// Intelligence" system — the frozen record a historical date on the
// dashboard's calendar loads instead of ever re-hitting Amber. Built by
// api/_lib/insightsDigest.js from api/_lib/insightsMarket.js's
// buildFullBreakdown() output, so its shape mirrors that function's return
// value closely on purpose (see that file for what each nested field means).
//
// `date` is the natural key: computed in IST (Asia/Kolkata), not server-local
// time, since the whole system is anchored to an 08:00 IST daily cadence.
// Unique + upserted on write (api/_lib/insightsSnapshotStore.js) so a
// duplicate cron trigger overwrites the same day's document instead of
// creating a second one (spec's data-integrity requirement).
const mongoose = require("mongoose");
const { Schema } = mongoose;

const SNAPSHOT_STATUSES = ["success", "partial", "failed"];

const CountryStatSchema = new Schema(
    { country: String, soldOut: Number, available: Number, total: Number, soldOutShare: Number, rank: Number },
    { _id: false }
);

const CityStatSchema = new Schema(
    {
        city: String,
        country: String,
        total: Number,
        soldOut: Number,
        available: Number,
        soldOutRate: Number,
        avgAskingPrice: Number,
        minAskingPrice: Number,
        maxAskingPrice: Number,
        currency: String,
    },
    { _id: false }
);

const PostcodeStatSchema = new Schema(
    { postcode: String, city: String, country: String, soldOut: Number, available: Number, total: Number, soldOutShare: Number, rank: Number },
    { _id: false }
);

const PropertyStatSchema = new Schema(
    {
        id: Schema.Types.Mixed,
        slug: String,
        name: String,
        country: String,
        city: String,
        pincode: String,
        minPrice: Number,
        currency: String,
    },
    { _id: false }
);

const InsightSnapshotSchema = new Schema(
    {
        date: { type: String, required: true, unique: true }, // "YYYY-MM-DD", IST calendar day
        generatedAt: { type: Date, required: true },
        source: { type: String, default: "amber" },
        status: { type: String, enum: SNAPSHOT_STATUSES, required: true },
        error: { type: String, default: null }, // set when status === "failed"

        totalInventory: { type: Number, default: null },
        availableInventory: { type: Number, default: null },
        soldOutInventory: { type: Number, default: null },
        soldOutPercentage: { type: Number, default: null },

        // Stored verbatim from buildFullBreakdown()'s live-shape fields
        // (api/_lib/insightsMarket.js) so a historical snapshot's response
        // is byte-shape-compatible with the live one — the existing
        // Market/Pricing/Property tab components (which read
        // market.siteWide / market.crawlProgress / market.coverage) work
        // unmodified for both modes without a parallel data shape.
        siteWide: { type: Schema.Types.Mixed, default: null },
        crawlProgress: { type: Schema.Types.Mixed, default: null },
        coverage: { type: Schema.Types.Mixed, default: null },

        countries: { type: [CountryStatSchema], default: [] },
        cities: { type: [CityStatSchema], default: [] },
        postcodes: { type: [PostcodeStatSchema], default: [] },
        properties: { type: [PropertyStatSchema], default: [] },

        pricing: {
            sampleSize: { type: Number, default: 0 },
            currency: { type: String, default: null },
            average: { type: Number, default: null },
            median: { type: Number, default: null },
            min: { type: Number, default: null },
            max: { type: Number, default: null },
        },

        // No real booking-transaction data exists in Amber's responses today
        // (see api/_lib/insightsMarket.js's normalizeItem — no booking date
        // field is ever populated). This stays {available:false} honestly
        // rather than fabricating lead-time numbers; the shape is here so a
        // future data source can populate it without a dashboard redesign.
        bookingLeadTime: {
            available: { type: Boolean, default: false },
            message: { type: String, default: "Booking lead-time data unavailable — no booking transaction data is currently captured." },
            averageDays: { type: Number, default: null },
            medianDays: { type: Number, default: null },
            distribution: { type: Schema.Types.Mixed, default: null },
            byCity: { type: Schema.Types.Mixed, default: null },
            byProperty: { type: Schema.Types.Mixed, default: null },
        },

        // Crawl/cache state captured at the moment this snapshot was built —
        // what the dashboard's Data & Cache Status card shows for this date.
        cache: {
            crawlComplete: { type: Boolean, default: false },
            itemsCounted: { type: Number, default: null },
            itemsExpected: { type: Number, default: null },
        },

        email: {
            sent: { type: Boolean, default: false },
            sentAt: { type: Date, default: null },
            error: { type: String, default: null },
        },
    },
    { timestamps: true }
);

// date: the sole lookup pattern for the whole feature (calendar click ->
// exact-date fetch; digest job -> upsert by date). unique:true above already
// creates this index.
// Range queries (7-day average, "dates in this month" for the calendar) sort
// on the same field, so no separate index is needed beyond the unique one.

module.exports = mongoose.models.InsightSnapshot || mongoose.model("InsightSnapshot", InsightSnapshotSchema);
