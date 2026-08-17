// Backend (CommonJS) twin of src/lib/campusUniversityResolver.js — Tier 1 of
// the University Housing discovery pipeline (see api/_lib/universityResolveService.js
// for how the tiers compose). Reads ./campusUniversities.json (same
// directory), NOT src/data/campusUniversities.json — a cross-directory
// require reaching into src/ was deliberately avoided, same precedent as
// api/_lib/universityResolver.js (the Student Planner's own backend
// resolver). Keep both JSON copies and both resolver files in sync by hand
// if either changes.
//
// Exact/alias match only here — no fuzzy matching (that's a separate,
// explicit escalation step in universityFuzzyMatch.js, only reached once
// this exact-match tier has failed). A silent wrong-university match is
// worse than an honest "not recognized" result.
"use strict";

const CAMPUS_UNIVERSITIES = require("./campusUniversities.json");

function normalize(str) {
    return String(str || "")
        .toLowerCase()
        .replace(/[^\w\s]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

const INDEX = new Map();
for (const uni of CAMPUS_UNIVERSITIES) {
    const keys = [uni.name, ...(uni.aliases || [])].map(normalize);
    for (const key of keys) {
        if (!key) continue;
        if (!INDEX.has(key)) INDEX.set(key, []);
        const bucket = INDEX.get(key);
        if (!bucket.some((u) => u.id === uni.id)) bucket.push(uni);
    }
}

// Returns the canonical university record, or null if not recognized (no
// match, or an ambiguous match) — never a best-guess.
function resolveCampusUniversity(input) {
    const key = normalize(input);
    if (!key) return null;
    const matches = INDEX.get(key);
    if (!matches || matches.length !== 1) return null;
    return matches[0];
}

function resolveCampusUniversityById(id) {
    if (!id) return null;
    return CAMPUS_UNIVERSITIES.find((u) => u.id === id) || null;
}

module.exports = {
    resolveCampusUniversity,
    resolveCampusUniversityById,
    normalize,
    CAMPUS_UNIVERSITIES,
};
