// GET /api/admin/accommodation/inventory-health — internal-only accommodation
// inventory health diagnostics (Milestone 6, IVYHUTS_ACCOMMODATION_HEALTH_REPORT.md).
//
// READ-ONLY: this endpoint never inserts, updates, deletes, refreshes,
// queues a refresh, or calls Amber. It only reads MongoDB
// (AccommodationResidence/AccommodationIndexMeta) and Redis (the refresh
// queue key) via api/_lib/accommodationHealth.js.
//
// Auth: reuses this codebase's existing internal-role gate exactly as every
// other internal endpoint does (see api/insights/overview.js, api/properties/search.js) —
// no new auth mechanism was introduced. No api/admin/ namespace existed
// before this file; Vercel's file-based routing makes the nested path work
// with zero config (same as api/insights/*.js already does).
//
// `view` query param selects what's returned (one file, multiple read-only
// views, matching the milestone brief's single suggested endpoint):
//   summary    (default) — Section 2 health summary
//   cities     — Section 3 paginated per-city diagnostics
//   duplicates — Phase 6 duplicate detection
//   suspicious — Phase 7 suspicious-city list
//   priority   — Phase 9 top-30 ranked investigation list
"use strict";

const { requireRole } = require("../../../../businessAuth");
const { withErrorHandling, parsePagination, buildPaginationMeta, parseEnumParam } = require("../../../../validation");
const { sendSuccess, sendCollection } = require("../../../../apiResponse");
const {
    buildCityDiagnostics,
    sortCityDiagnostics,
    summarizeCityDiagnostics,
    detectDuplicates,
    classifySuspiciousCities,
    buildPriorityInvestigationList,
} = require("../../../../accommodationHealth");

// Same internal-role set every other internal endpoint in this repo uses
// (api/insights/*, api/leads/*, api/properties/search.js) — kept in sync by
// convention across this repo, not imported from a single shared constant
// (existing, pre-dating convention, not introduced by this change).
const INTERNAL_ROLES = ["MARKETING_AGENT", "MARKETING_MANAGER", "ADMIN"];

const VALID_VIEWS = new Set(["summary", "cities", "duplicates", "suspicious", "priority"]);
const VALID_SORTS = new Set(["residenceCountDesc", "lastRefreshedAtAsc", "cityAsc"]);

module.exports = withErrorHandling(async (req, res) => {
    if (req.method !== "GET") {
        res.status(405).json({ error: "Method not allowed" });
        return;
    }

    const identity = await requireRole(req, res, INTERNAL_ROLES);
    if (!identity) return; // requireRole already sent 401/403

    const view = parseEnumParam(req.query.view, [...VALID_VIEWS], "view") || "summary";
    const generatedAt = new Date().toISOString();

    // Every view needs the same base city diagnostics — computed once
    // (1 aggregation + 1 find + 1 Redis GET, see accommodationHealth.js's
    // own header) and reused across whichever view was requested, never
    // recomputed per-view.
    const cityDiagnostics = await buildCityDiagnostics();

    if (view === "summary") {
        const summary = summarizeCityDiagnostics(cityDiagnostics);
        sendSuccess(res, { ...summary, generatedAt });
        return;
    }

    if (view === "cities") {
        const sort = parseEnumParam(req.query.sort, [...VALID_SORTS], "sort") || "residenceCountDesc";
        const { page, limit, skip } = parsePagination(req.query);
        const sorted = sortCityDiagnostics(cityDiagnostics, sort);
        const pageRows = sorted.slice(skip, skip + limit);
        sendCollection(res, pageRows, buildPaginationMeta({ page, limit }, sorted.length));
        return;
    }

    if (view === "duplicates") {
        const duplicates = await detectDuplicates();
        sendSuccess(res, { ...duplicates, generatedAt });
        return;
    }

    if (view === "suspicious") {
        const duplicates = await detectDuplicates();
        const suspicious = classifySuspiciousCities(cityDiagnostics, duplicates);
        sendSuccess(res, { suspicious, count: suspicious.length, generatedAt });
        return;
    }

    // view === "priority"
    const duplicates = await detectDuplicates();
    const suspicious = classifySuspiciousCities(cityDiagnostics, duplicates);
    const priority = buildPriorityInvestigationList(cityDiagnostics, duplicates, suspicious, 30);
    sendSuccess(res, { priority, generatedAt });
});
