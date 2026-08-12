// Canonical degree resolver — backend copy, same pattern and same
// precedent-following decisions as ./universityResolver.js (see that file's
// header for the reasoning): plain CommonJS, no build step, reads its JSON
// sibling directly.
//
// IMPORTANT: src/lib/degreeResolver.js is a DELIBERATELY SMALLER frontend
// counterpart, not a full hand-duplicated twin like universityResolver.js
// is. The full curated dataset here (summary/coreSkills/technicalAreas/
// specializationPaths) is only ever needed once the planner API has
// resolved a plan — the frontend only needs enough to offer autocomplete
// suggestions and a courtesy free-text resolve, so it carries a slim
// generated-by-hand projection (id/name/aliases/category) in
// src/data/degreeSuggestions.json instead of this full dataset. See that
// file's own header comment. Keep both name/alias/category values in sync
// by hand if either changes — same precedent as universities.json/
// universities.json's cross-directory duplication and cacheWarmer.js's
// WARM_TARGET_CITIES.
//
// Exact/alias match only — no fuzzy matching, same rule as the university
// resolver: a silent wrong-degree match is worse than an honest "not
// recognized" result.
"use strict";

const DEGREES = require("./degrees.json");

function normalize(str) {
    return String(str || "")
        .toLowerCase()
        .replace(/[^\w\s]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

const BY_ID = new Map(DEGREES.map((d) => [d.id, d]));

const NAME_INDEX = new Map();
for (const degree of DEGREES) {
    const keys = [degree.name, ...(degree.aliases || [])].map(normalize);
    for (const key of keys) {
        if (!key) continue;
        if (!NAME_INDEX.has(key)) NAME_INDEX.set(key, []);
        const bucket = NAME_INDEX.get(key);
        if (!bucket.some((d) => d.id === degree.id)) bucket.push(degree);
    }
}

// Authoritative id lookup — the only path api/student-planner.js should use
// for a client-supplied degreeId (mirrors resolveUniversityById: a
// spoofed/stale id can only ever fail to resolve, never silently substitute
// the wrong degree's skills).
function resolveDegreeById(id) {
    if (!id) return null;
    return BY_ID.get(String(id)) || null;
}

// Text-based resolution — courtesy fallback for free-text degree input that
// didn't go through the autocomplete. Same exact/alias-only,
// no-fuzzy-matching rule; ambiguous or unmatched input returns null rather
// than guessing.
function resolveDegreeByName(input) {
    const key = normalize(input);
    if (!key) return null;
    const matches = NAME_INDEX.get(key);
    if (!matches || matches.length !== 1) return null;
    return matches[0];
}

// Resolves free-text specialization input against ONE already-resolved
// degree's own specializationPaths (never across degrees — "AI" only means
// something in the context of a specific degree's own path list). Exact/
// alias match only, same rule as everything else in this file. Returns
// null (never a guess) when unresolved or when the degree itself has no
// specialization paths.
function resolveSpecialization(degree, specializationInput) {
    const key = normalize(specializationInput);
    if (!degree || !key) return null;
    const paths = degree.specializationPaths || [];
    const match = paths.find((p) => {
        const keys = [p.name, ...(p.aliases || [])].map(normalize);
        return keys.includes(key);
    });
    return match || null;
}

module.exports = { resolveDegreeById, resolveDegreeByName, resolveSpecialization, DEGREES };
