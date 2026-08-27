// Storage abstraction for the daily market-intelligence snapshot history.
// MongoDB is the right fit here (not Upstash Redis, which this project
// already uses for the Amber cache/locks/sessions with TTLs — a permanent
// historical archive is a different job than a cache) and it's already a
// first-class part of this app (api/_lib/mongodb.js, api/_lib/models/*), so
// this isn't new infrastructure, just a new model on the existing store.
//
// Every other file in this feature (the digest job, the snapshot/calendar
// API routes) goes through the functions here rather than touching
// InsightSnapshot/mongoose directly — if this ever needs to move to
// Postgres/Supabase, this is the only file that has to change.
const { connectToDatabase } = require("./mongodb");
const InsightSnapshot = require("./models/InsightSnapshot");

// The whole system is anchored to an 08:00 IST daily cadence, so "today"
// always means the IST calendar day — never the server's local/UTC day,
// which would drift the snapshot boundary by hours depending on where the
// serverless function happens to run.
function istDateString(date = new Date()) {
    // en-CA gives YYYY-MM-DD directly, no manual formatting needed.
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(date);
}

async function saveSnapshot(date, payload) {
    await connectToDatabase();
    // Upsert on the unique `date` field — a duplicate daily-digest trigger
    // (manual test run, retried cron) safely overwrites the same day's
    // document instead of creating a second one.
    const doc = await InsightSnapshot.findOneAndUpdate(
        { date },
        { $set: { ...payload, date } },
        { new: true, upsert: true, setDefaultsOnInsert: true }
    ).lean();
    return doc;
}

async function updateSnapshotEmailStatus(date, email) {
    await connectToDatabase();
    return InsightSnapshot.findOneAndUpdate({ date }, { $set: { email } }, { new: true }).lean();
}

async function getSnapshotByDate(date) {
    await connectToDatabase();
    return InsightSnapshot.findOne({ date }).lean();
}

// Most recent snapshot strictly before `date` — used both for the
// dashboard's "vs previous day" comparison and the digest email's
// "movements" section. Returns null (never a fabricated comparison) when
// none exists yet.
async function getPreviousSnapshot(date) {
    await connectToDatabase();
    return InsightSnapshot.findOne({ date: { $lt: date } })
        .sort({ date: -1 })
        .lean();
}

// Up to `n` most recent snapshots at or before `date`, oldest first — the
// raw material for a 7-day rolling average. Callers decide what "enough
// data" means (see api/insights/snapshot.js); this just returns what exists.
async function getRecentSnapshots(date, n = 7) {
    await connectToDatabase();
    const docs = await InsightSnapshot.find({ date: { $lte: date } })
        .sort({ date: -1 })
        .limit(n)
        .lean();
    return docs.reverse();
}

// Every stored date, optionally narrowed to a `YYYY-MM` month — the
// calendar's availability-dot data source. Deliberately returns only dates
// (+ a couple of headline numbers for a tooltip), never full snapshot bodies.
async function listSnapshotDates({ month } = {}) {
    await connectToDatabase();
    const filter = {};
    if (month) {
        filter.date = { $gte: `${month}-01`, $lte: `${month}-31` };
    }
    const docs = await InsightSnapshot.find(filter, { date: 1, status: 1, soldOutInventory: 1, soldOutPercentage: 1, _id: 0 })
        .sort({ date: 1 })
        .lean();
    return docs;
}

// Every stored snapshot in an optional [from, to] date range, narrow-
// projected to just what a cross-day aggregation needs (never postcodes/
// properties/pricing/bookingLeadTime — those stay per-document-only
// concerns). Omitting both bounds returns every stored snapshot, same
// "no filter = everything" convention as listSnapshotDates above.
async function getSnapshotsInRange(from, to) {
    await connectToDatabase();
    const filter = {};
    if (from || to) {
        filter.date = {};
        if (from) filter.date.$gte = from;
        if (to) filter.date.$lte = to;
    }
    return InsightSnapshot.find(filter, { date: 1, status: 1, soldOutInventory: 1, countries: 1, cities: 1, _id: 0 })
        .sort({ date: 1 })
        .lean();
}

module.exports = {
    istDateString,
    saveSnapshot,
    updateSnapshotEmailStatus,
    getSnapshotByDate,
    getPreviousSnapshot,
    getRecentSnapshots,
    listSnapshotDates,
    getSnapshotsInRange,
};
