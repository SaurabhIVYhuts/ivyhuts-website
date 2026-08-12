// Canonical university resolver — frontend copy. Reads src/data/universities.json.
//
// IMPORTANT: api/_lib/universityResolver.js is a hand-duplicated CommonJS
// twin of this file (same logic, same data content in api/_lib/universities.json)
// — api/_lib is a plain Node runtime with no build step, so it can't import
// this ES module. Keep both in sync by hand if either changes, same
// precedent as api/_lib/cacheWarmer.js's WARM_TARGET_CITIES.
//
// Exact/alias match only — deliberately NO fuzzy matching. A silent
// wrong-university match is worse than no match: an unrecognized university
// returns a controlled "not found" result so the caller can fall back to
// manual city/country entry instead of guessing.
import UNIVERSITIES from "../data/universities.json";

function normalize(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Build once: normalized name/alias -> array of matching universities (an
// array, not a single entry, so an accidental collision is detectable as
// "ambiguous" rather than silently resolving to whichever was indexed last).
const INDEX = new Map();
for (const uni of UNIVERSITIES) {
  const keys = [uni.name, ...(uni.aliases || [])].map(normalize);
  for (const key of keys) {
    if (!key) continue;
    if (!INDEX.has(key)) INDEX.set(key, []);
    const bucket = INDEX.get(key);
    if (!bucket.some((u) => u.id === uni.id)) bucket.push(uni);
  }
}

// Returns the canonical university record, or null if not recognized
// (no match, or an ambiguous match) — never a best-guess.
export function resolveUniversity(input) {
  const key = normalize(input);
  if (!key) return null;
  const matches = INDEX.get(key);
  if (!matches || matches.length !== 1) return null;
  return matches[0];
}

// Lightweight autocomplete filter — NOT the authoritative resolver above.
// Prefix/substring match against name+aliases, for showing suggestions as
// the student types. Selecting a suggestion IS the resolution (the caller
// already has the canonical record at that point, no need to re-resolve).
export function searchUniversities(query, limit = 8) {
  const q = normalize(query);
  if (!q) return [];
  const seen = new Set();
  const results = [];
  for (const uni of UNIVERSITIES) {
    if (seen.has(uni.id)) continue;
    const haystacks = [uni.name, ...(uni.aliases || [])].map(normalize);
    if (haystacks.some((h) => h.includes(q))) {
      seen.add(uni.id);
      results.push(uni);
      if (results.length >= limit) break;
    }
  }
  return results;
}

export { UNIVERSITIES };
