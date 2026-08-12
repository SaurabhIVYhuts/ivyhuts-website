// Salary Intelligence (Milestone 7) — deterministic, curated, zero-AI,
// zero-external-API resolver. Same shape/precedent as ./careerResolver.js
// and ./costOfLiving.js: plain CommonJS, no build step, reads its JSON
// sibling directly, makes no network calls of its own.
//
// Deliberate pipeline (plan item 14): Degree -> Career -> Country -> Salary.
// This module knows nothing about degrees or specializations — it only ever
// takes a careerId (the same id api/_lib/careers.json already assigns, the
// authoritative relationship per plan item 2) and a country string (the
// selected university's canonical country, resolved by
// api/_lib/universityResolver.js — never the client's browser/IP location).
// api/student-planner.js is the only caller, and it attaches the result to
// each career object in the existing `careers` array — no parallel career
// system, no new endpoint.
"use strict";

const SALARIES = require("./salaries.json");

// Curated planning guidance, not an official/government dataset and not
// sourced from a live salary API (plan items 5-6) — this environment cannot
// verify a specific external citation, so the dataset is honestly labeled as
// IVYHUTS's own curated estimate rather than pretending otherwise.
const SOURCE = "ivyhuts-salary-guidance";
const SOURCE_UPDATED_AT = "2026-08-11";
const UNAVAILABLE_NOTE = "Salary guidance isn't available for this career/location yet.";
const ESTIMATE_NOTE = "Estimated planning range. Actual compensation varies by experience, employer, location and market conditions.";

const EXPERIENCE_LEVELS = ["entryLevel", "earlyCareer", "midCareer", "experienced"];

function normalizeCountry(str) {
    return String(str || "").trim().toLowerCase().replace(/\s+/g, " ");
}

// A row must have a real careerId/country/currency and four well-formed
// (finite, non-negative, min <= max) ranges to ever reach the UI (plan item
// 23) — malformed data is dropped here, at load time, rather than trusted
// blindly. Exported so the same rule backs both the runtime index build
// below AND the dataset test suite (scripts/verify-planner-accommodation-index.js),
// same "one source of truth for the rule" precedent as degreeResolver.js's
// resolveSpecialization.
function isValidSalaryRow(row) {
    if (!row || typeof row !== "object") return false;
    if (!row.careerId || typeof row.careerId !== "string") return false;
    if (!row.country || typeof row.country !== "string") return false;
    if (!row.currency || typeof row.currency !== "string") return false;
    if (!row.ranges || typeof row.ranges !== "object") return false;
    return EXPERIENCE_LEVELS.every((level) => {
        const range = row.ranges[level];
        if (!range) return false;
        const { min, max } = range;
        return (
            Number.isFinite(min) && Number.isFinite(max) &&
            min >= 0 && max >= 0 &&
            min <= max
        );
    });
}

// Keyed by careerId + normalized country -> row. Built once at require time,
// filtering out anything that fails isValidSalaryRow so a malformed dataset
// entry can only ever degrade a single career/country pair to "unavailable",
// never crash the endpoint or leak bad numbers to the UI. Also detects
// duplicate careerId+country pairs (plan item 23) — the SECOND occurrence is
// dropped, never silently overwritten with ambiguous "last one wins" logic
// a future editor could easily get backwards.
const INDEX = new Map();
const DUPLICATE_KEYS = [];
for (const row of SALARIES) {
    if (!isValidSalaryRow(row)) continue;
    const key = `${row.careerId}::${normalizeCountry(row.country)}`;
    if (INDEX.has(key)) {
        DUPLICATE_KEYS.push(key);
        continue;
    }
    INDEX.set(key, row);
}

// Resolves salary guidance for one career in one country. Never throws, never
// fabricates a range, never substitutes another country's or another
// career's data — a missing careerId, missing/unrecognized country, or a
// career+country pair absent from the curated dataset all degrade to the
// same controlled `available: false` shape (plan item 22).
function resolveSalaryForCareer({ careerId, country }) {
    const normalizedCountry = normalizeCountry(country);
    if (!careerId || !normalizedCountry) {
        return { available: false, country: country || null, currency: null, ranges: null, source: SOURCE, sourceUpdatedAt: SOURCE_UPDATED_AT, note: UNAVAILABLE_NOTE };
    }

    const entry = INDEX.get(`${careerId}::${normalizedCountry}`);
    if (!entry) {
        return { available: false, country, currency: null, ranges: null, source: SOURCE, sourceUpdatedAt: SOURCE_UPDATED_AT, note: UNAVAILABLE_NOTE };
    }

    return {
        available: true,
        country: entry.country,
        currency: entry.currency,
        ranges: entry.ranges,
        source: SOURCE,
        sourceUpdatedAt: SOURCE_UPDATED_AT,
        note: ESTIMATE_NOTE,
    };
}

module.exports = {
    resolveSalaryForCareer,
    // Exposed for unit testing, same precedent as careerResolver.js.
    normalizeCountry,
    isValidSalaryRow,
    EXPERIENCE_LEVELS,
    DUPLICATE_KEYS,
    SALARIES,
    SOURCE,
    SOURCE_UPDATED_AT,
};
