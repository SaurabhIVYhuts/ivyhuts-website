// GET /api/insights/sold-out-trend — sold-out inventory over time, one entry
// per stored daily InsightSnapshot, for the /insight dashboard's dedicated
// Sold-Out Trend section (day and month views, country/city breakdown — see
// src/pages/insight/components/sections/TrendSection.js). Internal roles
// only, same gate as every other /api/insights/* route (see
// api/_lib/insightsDevAuth.js).
//
// Built entirely from the existing daily InsightSnapshot history — no new
// tracking, no Amber calls. Returns the raw day-by-day series; the frontend
// derives the month view by rolling up to each month's LATEST stored day
// (i.e. "as of month-end," or as of the most recent day if the month is
// still in progress) — a point-in-time total, never an average or a sum of
// daily values, per this feature's own definition of "total sold out." Doing
// the month rollup client-side (rather than a second server mode) means day
// and month views always come from one fetch and can never disagree.
//
// A snapshot with soldOutInventory === null (a failed digest run — the
// schema allows this, see InsightSnapshot.js's status enum) is skipped
// entirely — never shown as a zero day, never picked as a month's
// representative day.
//
// `country`/`city` optionally scope both the total and the breakdown arrays
// via insightsMarket.js's filterBreakdown() — the exact same in-memory
// re-aggregation api/insights/snapshot.js already uses for historical dates,
// applied here per-day instead of to a single day.
const { withErrorHandling } = require("../../validation");
const { sendSuccess } = require("../../apiResponse");
const { authorizeInsights } = require("../../insightsDevAuth");
const { filterBreakdown } = require("../../insightsMarket");
const { getSnapshotsInRange } = require("../../insightsSnapshotStore");

// "Unknown" is Amber's own placeholder for a property whose locality
// couldn't be resolved to a real city/country name (see
// insightsMarket.js's identical exclusion for the /api/search location
// index) — real sold-out inventory, just not a nameable place. Left as-is
// in the underlying snapshot (the full "Top Demand Markets" table elsewhere
// shows it deliberately, with a Country column giving it context), but a
// compact "which city/country sold the most" ranking has no context column
// to disambiguate it, so it's split out here rather than shown as several
// unlabeled "Unknown" rows. The excluded total is still surfaced (never
// silently dropped) as `unresolvedSoldOut`.
function splitKnown(list, key) {
    let unresolvedSoldOut = 0;
    const known = [];
    for (const item of list) {
        if (!item[key] || item[key] === "Unknown") {
            unresolvedSoldOut += item.soldOut || 0;
        } else {
            known.push(item);
        }
    }
    return { known, unresolvedSoldOut };
}

module.exports = withErrorHandling(async (req, res) => {
    if (req.method !== "GET") {
        res.status(405).json({ error: "Method not allowed" });
        return;
    }
    const identity = await authorizeInsights(req, res);
    if (!identity) return;

    const { country, city } = req.query;
    const docs = await getSnapshotsInRange();

    const hasFilter = Boolean(country || city);
    const days = docs
        .filter((doc) => doc.soldOutInventory != null)
        .map((doc) => {
            const scoped = hasFilter ? filterBreakdown(doc, { country, city }) : doc;
            const { known: countries, unresolvedSoldOut: unresolvedCountrySoldOut } = splitKnown(
                (scoped.countries || []).map((c) => ({ country: c.country, soldOut: c.soldOut })),
                "country"
            );
            const { known: cities, unresolvedSoldOut: unresolvedCitySoldOut } = splitKnown(
                (scoped.cities || []).map((c) => ({ city: c.city, country: c.country, soldOut: c.soldOut })),
                "city"
            );
            return {
                date: doc.date,
                totalSoldOut: hasFilter ? scoped.totalSoldOut : doc.soldOutInventory,
                countries,
                cities,
                unresolvedCountrySoldOut,
                unresolvedCitySoldOut,
            };
        });

    sendSuccess(res, { days });
});
