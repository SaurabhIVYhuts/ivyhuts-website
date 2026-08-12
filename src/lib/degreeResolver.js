// Frontend degree resolver — mirrors src/lib/universityResolver.js's
// pattern, but deliberately reads a SMALLER, purpose-built dataset
// (src/data/degreeSuggestions.json: id/name/category/aliases only) rather
// than a full hand-duplicated twin of api/_lib/degrees.json.
//
// Why: unlike the university record (name/city/country/lat/lng — all of
// which the form needs immediately, client-side, to auto-fill other
// fields), the full degree dataset (summary/coreSkills/technicalAreas/
// specializationPaths) is never needed here — it's only ever displayed
// after /api/student-planner has already resolved and returned it. Since
// autocomplete only needs enough to search and label suggestions, a full
// duplicate would just be dead weight in the client bundle. See item 14 of
// the Milestone 5 plan for this exact tradeoff.
//
// Exact/alias match only — no fuzzy matching, same rule as
// universityResolver.js: a silent wrong-degree guess is worse than an
// honest "not recognized".
import DEGREE_SUGGESTIONS from "../data/degreeSuggestions.json";

function normalize(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const INDEX = new Map();
for (const degree of DEGREE_SUGGESTIONS) {
  const keys = [degree.name, ...(degree.aliases || [])].map(normalize);
  for (const key of keys) {
    if (!key) continue;
    if (!INDEX.has(key)) INDEX.set(key, []);
    const bucket = INDEX.get(key);
    if (!bucket.some((d) => d.id === degree.id)) bucket.push(degree);
  }
}

// Returns { id, name } or null (no match, or ambiguous match) — never a
// best-guess. Only a courtesy fallback for free text typed without using
// the autocomplete; the authoritative resolve still happens server-side in
// api/_lib/degreeResolver.js against the full dataset.
export function resolveDegree(input) {
  const key = normalize(input);
  if (!key) return null;
  const matches = INDEX.get(key);
  if (!matches || matches.length !== 1) return null;
  return matches[0];
}

// Lightweight autocomplete filter — prefix/substring match against
// name+aliases, for showing suggestions as the student types. Selecting a
// suggestion IS the resolution (the caller already has {id, name}).
export function searchDegrees(query, limit = 8) {
  const q = normalize(query);
  if (!q) return [];
  const results = [];
  for (const degree of DEGREE_SUGGESTIONS) {
    const haystacks = [degree.name, ...(degree.aliases || [])].map(normalize);
    if (haystacks.some((h) => h.includes(q))) {
      results.push(degree);
      if (results.length >= limit) break;
    }
  }
  return results;
}

export { DEGREE_SUGGESTIONS };
