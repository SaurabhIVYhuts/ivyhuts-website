// Milestone 6 (IVYHUTS_ACCOMMODATION_HEALTH_REPORT.md): read-only inventory
// health diagnostics. Every function in this file is READ-ONLY — no insert,
// update, delete, refresh, queue-write, or Amber call happens anywhere here.
// Shared by api/admin/accommodation/inventory-health.js (the internal
// dashboard endpoint) and scripts/report-accommodation-index-health.js (the
// CLI report), so the two never drift on what a given metric actually means.
//
// PERFORMANCE (Phase 13): per-city stats are computed with exactly ONE
// aggregation query over AccommodationResidence (grouped by city), not one
// query per city — the collection is a few thousand documents today, so a
// single $group pass is cheap and avoids an N+1 pattern entirely as the
// number of distinct cities grows toward (and past) 575.
// AccommodationIndexMeta is small (currently ~51 documents, one per
// successfully-refreshed city) and is loaded in one plain `.find({}).lean()`
// — a second aggregation would be pure overhead at this size. The refresh
// queue (Redis) is a single key holding one JSON array — one `sharedGet`
// call. Total cost per health computation: 1 aggregation + 1 find + 1 Redis
// GET, regardless of how many cities exist.
"use strict";

const AccommodationResidence = require("./models/AccommodationResidence");
const AccommodationIndexMeta = require("./models/AccommodationIndexMeta");
const { sharedGet } = require("./sharedStore");
const { classifyCityState, REFRESH_QUEUE_KEY } = require("./accommodationIndex");
const { WARM_TARGET_CITIES } = require("./cacheWarmer");

// ── Core per-city aggregation ────────────────────────────────────────────
async function getResidenceCityStats() {
    return AccommodationResidence.aggregate([
        {
            $group: {
                _id: "$city",
                totalResidences: { $sum: 1 },
                withSourceId: { $sum: { $cond: [{ $and: [{ $ne: ["$propertyId", null] }, { $ne: ["$propertyId", ""] }] }, 1, 0] } },
                withCoordinates: { $sum: { $cond: [{ $and: [{ $ne: ["$latitude", null] }, { $ne: ["$longitude", null] }] }, 1, 0] } },
                withRoomData: {
                    $sum: {
                        $cond: [
                            { $or: [{ $gt: [{ $size: { $ifNull: ["$roomTypes", []] } }, 0] }, { $gt: [{ $ifNull: ["$roomsCount", 0] }, 0] }] },
                            1,
                            0,
                        ],
                    },
                },
                withAvailabilityData: { $sum: { $cond: [{ $in: [{ $type: "$available" }, ["bool"]] }, 1, 0] } },
                soldOut: { $sum: { $cond: [{ $eq: ["$available", false] }, 1, 0] } },
            },
        },
        { $sort: { totalResidences: -1 } },
    ]).then((rows) => rows.map((r) => ({ city: r._id, ...r, _id: undefined })));
}

async function getMetaByCity() {
    const docs = await AccommodationIndexMeta.find({}).lean();
    const map = new Map();
    for (const d of docs) map.set(d.city, d);
    return map;
}

// Never throws — a Redis outage degrades to "queue state unknown" (empty
// set), never blocks or fails the whole health computation. Mirrors this
// codebase's existing "diagnostics/observability must never be the reason a
// real feature breaks" philosophy.
async function getQueuedCitiesSet() {
    try {
        const queued = await sharedGet(REFRESH_QUEUE_KEY);
        return new Set(Array.isArray(queued) ? queued : []);
    } catch (err) {
        return new Set();
    }
}

// ── Merged city-level diagnostics (Section 3 shape) ─────────────────────
async function buildCityDiagnostics() {
    const now = Date.now();
    const [residenceStats, metaByCity, queued] = await Promise.all([getResidenceCityStats(), getMetaByCity(), getQueuedCitiesSet()]);

    const residenceCities = new Set(residenceStats.map((r) => r.city));
    const allCities = new Set([...residenceCities, ...metaByCity.keys()]);

    const rows = [];
    for (const city of allCities) {
        const stat = residenceStats.find((r) => r.city === city) || {
            city,
            totalResidences: 0,
            withSourceId: 0,
            withCoordinates: 0,
            withRoomData: 0,
            withAvailabilityData: 0,
            soldOut: 0,
        };
        const meta = metaByCity.get(city) || null;
        const state = classifyCityState(meta, now);
        rows.push({
            city,
            residenceCount: stat.totalResidences,
            withSourceId: stat.withSourceId,
            withoutSourceId: stat.totalResidences - stat.withSourceId,
            withCoordinates: stat.withCoordinates,
            withoutCoordinates: stat.totalResidences - stat.withCoordinates,
            withRoomData: stat.withRoomData,
            withoutRoomData: stat.totalResidences - stat.withRoomData,
            withAvailabilityData: stat.withAvailabilityData,
            withoutAvailabilityData: stat.totalResidences - stat.withAvailabilityData,
            soldOutCount: stat.soldOut,
            metaExists: !!meta,
            state,
            lastRefreshedAt: meta?.lastRefreshedAt || null,
            lastAttemptedAt: meta?.lastAttemptedAt || null,
            lastErrorAt: meta?.lastErrorAt || null,
            lastError: meta?.lastError || null,
            consecutiveFailures: meta?.consecutiveFailures || 0,
            queued: queued.has(city),
        });
    }
    return rows;
}

const SORT_FIELDS = {
    residenceCountDesc: (a, b) => b.residenceCount - a.residenceCount,
    lastRefreshedAtAsc: (a, b) => {
        const aT = a.lastRefreshedAt ? new Date(a.lastRefreshedAt).getTime() : -Infinity; // never-refreshed sorts first — the most urgent
        const bT = b.lastRefreshedAt ? new Date(b.lastRefreshedAt).getTime() : -Infinity;
        return aT - bT;
    },
    cityAsc: (a, b) => a.city.localeCompare(b.city),
};

function sortCityDiagnostics(rows, sortKey) {
    const cmp = SORT_FIELDS[sortKey] || SORT_FIELDS.residenceCountDesc;
    return [...rows].sort(cmp);
}

// ── Health summary (Section 2 shape) ─────────────────────────────────────
function summarizeCityDiagnostics(rows, queuedSet) {
    const summary = {
        totalCities: rows.length,
        citiesWithInventory: rows.filter((r) => r.residenceCount > 0).length,
        citiesWithMeta: rows.filter((r) => r.metaExists).length,
        fresh: 0,
        stale: 0,
        expired: 0,
        missing: 0,
        failedCooldown: 0,
        totalResidenceRows: rows.reduce((s, r) => s + r.residenceCount, 0),
        queuedCities: queuedSet ? queuedSet.size : rows.filter((r) => r.queued).length,
    };
    for (const r of rows) {
        const key = { FRESH: "fresh", STALE: "stale", EXPIRED: "expired", MISSING: "missing", FAILED_COOLDOWN: "failedCooldown" }[r.state];
        if (key) summary[key] += 1;
    }
    return summary;
}

// ── Duplicate detection (Phase 6) ────────────────────────────────────────
async function detectDuplicateSourceIds() {
    return AccommodationResidence.aggregate([
        { $group: { _id: "$propertyId", count: { $sum: 1 }, cities: { $addToSet: "$city" }, docIds: { $push: "$_id" } } },
        { $match: { count: { $gt: 1 } } },
        { $sort: { count: -1 } },
    ]).then((rows) => rows.map((r) => ({ sourceId: r._id, count: r.count, cities: r.cities, docIds: r.docIds })));
}

async function detectSameNameDifferentSourceId() {
    return AccommodationResidence.aggregate([
        { $group: { _id: { city: "$city", name: "$propertyName" }, sourceIds: { $addToSet: "$propertyId" }, count: { $sum: 1 } } },
        { $match: { count: { $gt: 1 } } },
        { $sort: { count: -1 } },
    ]).then((rows) => rows.map((r) => ({ city: r._id.city, name: r._id.name, sourceIds: r.sourceIds, count: r.count })));
}

async function detectSameSlugDifferentSourceId() {
    return AccommodationResidence.aggregate([
        { $match: { slug: { $nin: [null, ""] } } },
        { $group: { _id: "$slug", sourceIds: { $addToSet: "$propertyId" }, count: { $sum: 1 } } },
        { $match: { count: { $gt: 1 } } },
        { $sort: { count: -1 } },
    ]).then((rows) => rows.map((r) => ({ slug: r._id, sourceIds: r.sourceIds, count: r.count })));
}

async function detectDuplicates() {
    const [duplicateSourceIds, sameNameDifferentSourceId, sameSlugDifferentSourceId] = await Promise.all([
        detectDuplicateSourceIds(),
        detectSameNameDifferentSourceId(),
        detectSameSlugDifferentSourceId(),
    ]);
    return { duplicateSourceIds, sameNameDifferentSourceId, sameSlugDifferentSourceId };
}

// ── Suspicious-city heuristic (Phase 7) — every threshold documented, none
// arbitrary. This is a DIAGNOSTIC SIGNAL only — it never rejects, deletes,
// or modifies anything; it only labels a city "SUSPICIOUS" with explicit
// reasons for a human to investigate. ─────────────────────────────────────
const WARM_TARGET_CITY_SET = new Set(WARM_TARGET_CITIES.map((c) => c.toLowerCase()));

// Milestone 5 measured, at full collection scale, that missing coordinates/
// sourceId is 0% in real indexed data today — so ANY nonzero count is a
// genuine deviation from the established baseline, not noise.
const MISSING_SOURCE_ID_THRESHOLD = 1; // any at all
const MISSING_COORDINATES_RATIO_THRESHOLD = 0.05; // >5% missing — small tolerance for genuinely sparse Amber data, still far above the measured 0% baseline
// Room data legitimately varies more (a genuinely simple/sparse listing can
// have no room breakdown at all without being wrong) — use a materially
// higher bar than coordinates before flagging it.
const MISSING_ROOM_DATA_RATIO_THRESHOLD = 0.8; // >80% of a city's rows have zero room data
// 3 consecutive failed refresh attempts (Milestone 4's own cooldown/backoff
// mechanism only advances past a failure on a genuine success) is enough
// independent tries to rule out a single transient blip.
const REPEATED_FAILURE_THRESHOLD = 3;
// A city with real, meaningful inventory (this codebase's own existing
// convention for "not just a couple of stray rows" — see
// scripts/measure-meta-coverage.js's own "trivial (1-2 stray rows) or
// substantial" framing) that has never once been successfully indexed.
const MEANINGFUL_INVENTORY_NO_META_THRESHOLD = 20;
// A warm-target (curated, cron-warmed) city — one of the 13 cities
// cacheWarmer.js actively keeps fresh — with fewer rows than this is
// unexpected specifically BECAUSE it's supposed to already be well-covered;
// this threshold does not apply to non-warm cities, which have no such
// expectation.
const WARM_CITY_LOW_INVENTORY_THRESHOLD = 10;
const HIGH_DUPLICATE_INVOLVEMENT_THRESHOLD = 2; // a city appearing in >2 same-name/same-slug duplicate groups

function classifySuspiciousCities(cityDiagnostics, duplicates) {
    const duplicateCityCounts = new Map();
    for (const d of duplicates.sameNameDifferentSourceId) duplicateCityCounts.set(d.city, (duplicateCityCounts.get(d.city) || 0) + 1);
    for (const d of duplicates.duplicateSourceIds) for (const c of d.cities) duplicateCityCounts.set(c, (duplicateCityCounts.get(c) || 0) + 1);

    const results = [];
    for (const row of cityDiagnostics) {
        const reasons = [];
        const isWarmTarget = WARM_TARGET_CITY_SET.has(row.city.toLowerCase());

        if (isWarmTarget && row.residenceCount > 0 && row.residenceCount < WARM_CITY_LOW_INVENTORY_THRESHOLD) {
            reasons.push(`warm-target city with only ${row.residenceCount} indexed properties (threshold: <${WARM_CITY_LOW_INVENTORY_THRESHOLD})`);
        }
        if (row.withoutSourceId >= MISSING_SOURCE_ID_THRESHOLD) {
            reasons.push(`${row.withoutSourceId} row(s) missing a source id (baseline is 0 across the full collection)`);
        }
        if (row.residenceCount > 0 && row.withoutCoordinates / row.residenceCount > MISSING_COORDINATES_RATIO_THRESHOLD) {
            reasons.push(`${row.withoutCoordinates}/${row.residenceCount} rows (${((row.withoutCoordinates / row.residenceCount) * 100).toFixed(0)}%) missing coordinates, above the ${(MISSING_COORDINATES_RATIO_THRESHOLD * 100).toFixed(0)}% tolerance`);
        }
        if (row.residenceCount > 0 && row.withoutRoomData / row.residenceCount > MISSING_ROOM_DATA_RATIO_THRESHOLD) {
            reasons.push(`${row.withoutRoomData}/${row.residenceCount} rows (${((row.withoutRoomData / row.residenceCount) * 100).toFixed(0)}%) missing room data, above the ${(MISSING_ROOM_DATA_RATIO_THRESHOLD * 100).toFixed(0)}% tolerance`);
        }
        if (row.consecutiveFailures >= REPEATED_FAILURE_THRESHOLD) {
            reasons.push(`${row.consecutiveFailures} consecutive failed refresh attempts`);
        }
        if (!row.metaExists && row.residenceCount >= MEANINGFUL_INVENTORY_NO_META_THRESHOLD) {
            reasons.push(`${row.residenceCount} indexed properties but has never had a successful metadata refresh`);
        }
        const dupCount = duplicateCityCounts.get(row.city) || 0;
        if (dupCount > HIGH_DUPLICATE_INVOLVEMENT_THRESHOLD) {
            reasons.push(`involved in ${dupCount} duplicate-name/duplicate-slug groups`);
        }

        if (reasons.length > 0) results.push({ city: row.city, residenceCount: row.residenceCount, reasons });
    }
    // Deterministic order: most-flagged first, then by residence count, then
    // alphabetically — never insertion order, so repeated runs against the
    // same data always produce the same ranking (Phase 12, TEST 10).
    results.sort((a, b) => b.reasons.length - a.reasons.length || b.residenceCount - a.residenceCount || a.city.localeCompare(b.city));
    return results;
}

// ── Priority investigation list (Phase 9) — ranked, deterministic, capped
// at 30. Scoring is additive and fully documented: residence count is the
// base signal (Phase 9 item 1), and each additional evidenced problem adds
// a fixed bonus so a city with real, evidenced issues always outranks a
// merely-large city with none — while still breaking ties within the same
// "tier" of problems by residence count (the milestone's own stated primary
// signal). ─────────────────────────────────────────────────────────────────
const SCORE_MISSING_META = 1000;
const SCORE_REPEATED_FAILURE = 500;
const SCORE_SUSPICIOUS = 300;
const SCORE_DUPLICATE_INVOLVED = 200;

function buildPriorityInvestigationList(cityDiagnostics, duplicates, suspicious, limit = 30) {
    const suspiciousByCity = new Map(suspicious.map((s) => [s.city, s]));
    const duplicateCities = new Set([
        ...duplicates.sameNameDifferentSourceId.map((d) => d.city),
        ...duplicates.duplicateSourceIds.flatMap((d) => d.cities),
    ]);

    const scored = cityDiagnostics.map((row) => {
        const flags = [];
        let score = row.residenceCount;
        if (!row.metaExists && row.residenceCount > 0) { score += SCORE_MISSING_META; flags.push("missing_metadata"); }
        if (row.consecutiveFailures >= REPEATED_FAILURE_THRESHOLD) { score += SCORE_REPEATED_FAILURE; flags.push("repeated_refresh_failure"); }
        if (suspiciousByCity.has(row.city)) { score += SCORE_SUSPICIOUS; flags.push("suspicious_data_quality"); }
        if (duplicateCities.has(row.city)) { score += SCORE_DUPLICATE_INVOLVED; flags.push("duplicate_records"); }
        return {
            city: row.city,
            residenceCount: row.residenceCount,
            metaExists: row.metaExists,
            state: row.state,
            consecutiveFailures: row.consecutiveFailures,
            flags,
            reasons: suspiciousByCity.get(row.city)?.reasons || [],
            score,
        };
    });

    scored.sort((a, b) => b.score - a.score || b.residenceCount - a.residenceCount || a.city.localeCompare(b.city));
    return scored.slice(0, limit);
}

module.exports = {
    getResidenceCityStats,
    getMetaByCity,
    getQueuedCitiesSet,
    buildCityDiagnostics,
    sortCityDiagnostics,
    summarizeCityDiagnostics,
    detectDuplicateSourceIds,
    detectSameNameDifferentSourceId,
    detectSameSlugDifferentSourceId,
    detectDuplicates,
    classifySuspiciousCities,
    buildPriorityInvestigationList,
    // Exported for tests/documentation — the exact thresholds this module
    // actually uses, so a test can assert against the real constant rather
    // than a hardcoded copy that could silently drift.
    THRESHOLDS: {
        MISSING_SOURCE_ID_THRESHOLD,
        MISSING_COORDINATES_RATIO_THRESHOLD,
        MISSING_ROOM_DATA_RATIO_THRESHOLD,
        REPEATED_FAILURE_THRESHOLD,
        MEANINGFUL_INVENTORY_NO_META_THRESHOLD,
        WARM_CITY_LOW_INVENTORY_THRESHOLD,
        HIGH_DUPLICATE_INVOLVEMENT_THRESHOLD,
    },
};
