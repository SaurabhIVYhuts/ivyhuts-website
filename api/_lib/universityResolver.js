// Canonical university resolver — backend copy. Reads ./universities.json
// (same directory, so this stays safely traceable by Vercel's deployment
// bundler — a cross-directory require reaching into src/ was deliberately
// avoided here; see the Milestone 3 plan for why).
//
// IMPORTANT: src/lib/universityResolver.js is a hand-duplicated ES-module
// twin of this file (same logic, same data content in
// src/data/universities.json). Keep both in sync by hand if either changes,
// same precedent as cacheWarmer.js's WARM_TARGET_CITIES.
//
// Exact/alias match only — no fuzzy matching. This is the AUTHORITATIVE
// resolution used by api/student-planner.js: a client-supplied universityId
// is looked up here, never trusted from the client directly, so a spoofed
// or stale id can only ever fail to resolve, not silently substitute wrong
// coordinates into ranking.
"use strict";

const UNIVERSITIES = require("./universities.json");

function normalize(str) {
    return String(str || "")
        .toLowerCase()
        .replace(/[^\w\s]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

const BY_ID = new Map(UNIVERSITIES.map((u) => [u.id, u]));

const NAME_INDEX = new Map();
for (const uni of UNIVERSITIES) {
    const keys = [uni.name, ...(uni.aliases || [])].map(normalize);
    for (const key of keys) {
        if (!key) continue;
        if (!NAME_INDEX.has(key)) NAME_INDEX.set(key, []);
        const bucket = NAME_INDEX.get(key);
        if (!bucket.some((u) => u.id === uni.id)) bucket.push(uni);
    }
}

// Authoritative id lookup — the only path api/student-planner.js should use
// for a client-supplied universityId.
function resolveUniversityById(id) {
    if (!id) return null;
    return BY_ID.get(String(id)) || null;
}

// Text-based resolution — courtesy fallback for when no id was supplied
// (e.g. an older client, or a student who typed free text without using
// the autocomplete). Same exact/alias-only, no-fuzzy-matching rule as the
// frontend copy; ambiguous or unmatched input returns null.
function resolveUniversityByName(input) {
    const key = normalize(input);
    if (!key) return null;
    const matches = NAME_INDEX.get(key);
    if (!matches || matches.length !== 1) return null;
    return matches[0];
}

module.exports = { resolveUniversityById, resolveUniversityByName, UNIVERSITIES };
