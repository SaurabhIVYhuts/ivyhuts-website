// Real CRM-derived aggregates for the /insight dashboard's overview
// endpoint. Every number here comes from an actual Lead/Enquiry/User field
// (see api/_lib/models/) — nothing is synthesized. Data volume for this
// CRM is small enough (an early-stage business, not a high-traffic
// e-commerce ledger) that plain JS aggregation over a bounded, date-filtered
// `.find()` is simpler and more transparent than a Mongo aggregation
// pipeline, and it lets one query per collection feed every derived view
// (trend, by-city, by-source, funnel) instead of one query per view.
const { connectToDatabase } = require("./mongodb");
const Lead = require("./models/Lead");
const Enquiry = require("./models/Enquiry");
const User = require("./models/User");

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
// A user counts as "ever booked" once they reach BOOKED or any stage after
// it that isn't a cancellation — mirrors the enum's own declared order in
// api/_lib/models/User.js.
const BOOKED_OR_BEYOND = ["BOOKED", "STAY_IN_PROGRESS", "MOVED_IN", "STAY_COMPLETED"];

const DAY_MS = 24 * 60 * 60 * 1000;

function resolveDateRange(from, to) {
    const toDate = to ? new Date(to) : new Date();
    const fromDate = from ? new Date(from) : new Date(toDate.getTime() - 30 * DAY_MS);
    return { from: fromDate, to: toDate };
}

function bucketGranularity(from, to) {
    const days = (to - from) / DAY_MS;
    if (days <= 45) return "day";
    if (days <= 180) return "week";
    return "month";
}

function bucketKey(date, granularity) {
    const d = new Date(date);
    if (granularity === "day") return d.toISOString().slice(0, 10);
    if (granularity === "week") {
        const dow = d.getUTCDay() || 7; // Monday = 1 ... Sunday = 7
        const monday = new Date(d);
        monday.setUTCDate(d.getUTCDate() - dow + 1);
        return monday.toISOString().slice(0, 10);
    }
    return d.toISOString().slice(0, 7); // YYYY-MM
}

function buildTrend(leads, enquiries, granularity) {
    const map = new Map();
    const bump = (docs, field) => {
        for (const doc of docs) {
            const key = bucketKey(doc.createdAt, granularity);
            if (!map.has(key)) map.set(key, { date: key, leads: 0, enquiries: 0 });
            map.get(key)[field] += 1;
        }
    };
    bump(leads, "leads");
    bump(enquiries, "enquiries");
    return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
}

function trendPeakAndLow(trend) {
    if (trend.length === 0) return { peak: null, lowest: null };
    let peak = trend[0];
    let lowest = trend[0];
    for (const point of trend) {
        const total = point.leads + point.enquiries;
        if (total > peak.leads + peak.enquiries) peak = point;
        if (total < lowest.leads + lowest.enquiries) lowest = point;
    }
    return { peak, lowest };
}

function groupCount(docs, pathFn) {
    const counts = new Map();
    for (const doc of docs) {
        const key = pathFn(doc);
        if (!key) continue;
        counts.set(key, (counts.get(key) || 0) + 1);
    }
    return Array.from(counts.entries())
        .map(([key, count]) => ({ key, count }))
        .sort((a, b) => b.count - a.count);
}

const LEAD_TIME_BUCKET_DEFS = [
    { label: "0–7 days", min: 0, max: 7 },
    { label: "8–30 days", min: 8, max: 30 },
    { label: "31–60 days", min: 31, max: 60 },
    { label: "61–90 days", min: 61, max: 90 },
    { label: "90+ days", min: 91, max: Infinity },
];

function bucketLeadTime(users) {
    const buckets = LEAD_TIME_BUCKET_DEFS.map((b) => ({ ...b, count: 0 }));
    const diffs = [];
    for (const user of users) {
        const purchasedAt = user.accommodationJourney?.purchasedAt;
        const moveInDate = user.accommodationJourney?.moveInDate;
        if (!purchasedAt || !moveInDate) continue;
        const diff = Math.round((new Date(moveInDate).getTime() - new Date(purchasedAt).getTime()) / DAY_MS);
        if (!Number.isFinite(diff) || diff < 0) continue;
        diffs.push(diff);
        const bucket = buckets.find((b) => diff >= b.min && diff <= b.max);
        if (bucket) bucket.count += 1;
    }
    diffs.sort((a, b) => a - b);
    const avgDays = diffs.length ? Math.round(diffs.reduce((a, b) => a + b, 0) / diffs.length) : null;
    const medianDays = diffs.length ? diffs[Math.floor(diffs.length / 2)] : null;
    const mostCommon = diffs.length ? buckets.reduce((best, b) => (b.count > (best?.count || 0) ? b : best), null) : null;
    return {
        buckets: buckets.map(({ label, count }) => ({ label, count })),
        sampleSize: diffs.length,
        avgDays,
        medianDays,
        mostCommonBucket: mostCommon?.count ? mostCommon.label : null,
    };
}

function buildFunnel(users) {
    const counts = Object.fromEntries(ACCOMMODATION_JOURNEY_STATUSES.map((s) => [s, 0]));
    for (const user of users) {
        const status = user.accommodationJourney?.status;
        if (status && counts[status] !== undefined) counts[status] += 1;
    }
    const bookedCount = BOOKED_OR_BEYOND.reduce((sum, status) => sum + counts[status], 0);
    return {
        stages: ACCOMMODATION_JOURNEY_STATUSES.map((status) => ({ status, count: counts[status] })),
        bookedCount,
    };
}

async function getOverview({ from, to, city, source } = {}) {
    await connectToDatabase();
    const range = resolveDateRange(from, to);
    const granularity = bucketGranularity(range.from, range.to);

    const leadEnquiryFilter = { createdAt: { $gte: range.from, $lte: range.to } };
    if (city) leadEnquiryFilter["property.city"] = city;
    if (source) leadEnquiryFilter.source = source;

    const leadFilter = { ...leadEnquiryFilter, archivedAt: null };

    const [leads, enquiries, users] = await Promise.all([
        Lead.find(leadFilter).select("status source property.city createdAt").lean(),
        Enquiry.find(leadEnquiryFilter).select("status source property.city createdAt").lean(),
        User.find({ createdAt: { $gte: range.from, $lte: range.to } })
            .select("accommodationJourney.status accommodationJourney.purchasedAt accommodationJourney.moveInDate")
            .lean(),
    ]);

    const trend = buildTrend(leads, enquiries, granularity);
    const { peak, lowest } = trendPeakAndLow(trend);
    const funnel = buildFunnel(users);
    const leadTime = bucketLeadTime(users);

    const convertedLeads = leads.filter((l) => l.status === "converted").length;

    return {
        range: { from: range.from.toISOString(), to: range.to.toISOString(), granularity },
        kpis: {
            totalLeads: leads.length,
            totalEnquiries: enquiries.length,
            convertedLeads,
            conversionRate: leads.length ? convertedLeads / leads.length : null,
            bookedCount: funnel.bookedCount,
        },
        funnel: funnel.stages,
        trend: { points: trend, granularity, peak, lowest },
        leadTime,
        byCity: groupCount([...leads, ...enquiries], (d) => d.property?.city).map(({ key, count }) => ({ city: key, count })),
        bySource: groupCount([...leads, ...enquiries], (d) => d.source).map(({ key, count }) => ({ source: key, count })),
        leadStatusBreakdown: groupCount(leads, (d) => d.status).map(({ key, count }) => ({ status: key, count })),
    };
}

async function getDataStatus() {
    await connectToDatabase();
    const [leadCount, enquiryCount, userCount, latestLead, latestEnquiry] = await Promise.all([
        Lead.countDocuments({ archivedAt: null }),
        Enquiry.countDocuments({}),
        User.countDocuments({}),
        Lead.findOne({}).sort({ createdAt: -1 }).select("createdAt").lean(),
        Enquiry.findOne({}).sort({ createdAt: -1 }).select("createdAt").lean(),
    ]);
    const timestamps = [latestLead?.createdAt, latestEnquiry?.createdAt].filter(Boolean).map((d) => new Date(d).getTime());
    return {
        leadCount,
        enquiryCount,
        userCount,
        lastRecordAt: timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : null,
    };
}

// Shape-matched fallback used by api/insights/overview.js when MongoDB
// isn't configured (MongoNotConfiguredError) — every array/object field a
// consumer might destructure is present but empty, so components render
// their normal "no data" paths instead of crashing on `undefined`. The
// endpoint additionally sets `crmAvailable: false` so the UI can show an
// explicit "CRM data unavailable" message rather than a misleading "no
// data for this range".
const EMPTY_OVERVIEW = {
    range: null,
    kpis: { totalLeads: 0, totalEnquiries: 0, convertedLeads: 0, conversionRate: null, bookedCount: 0 },
    funnel: ACCOMMODATION_JOURNEY_STATUSES.map((status) => ({ status, count: 0 })),
    trend: { points: [], granularity: "day", peak: null, lowest: null },
    leadTime: { buckets: [], sampleSize: 0, avgDays: null, medianDays: null, mostCommonBucket: null },
    byCity: [],
    bySource: [],
    leadStatusBreakdown: [],
};

const EMPTY_DATA_STATUS = { leadCount: null, enquiryCount: null, userCount: null, lastRecordAt: null };

module.exports = { getOverview, getDataStatus, ACCOMMODATION_JOURNEY_STATUSES, EMPTY_OVERVIEW, EMPTY_DATA_STATUS };
