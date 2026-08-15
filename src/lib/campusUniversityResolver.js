// University resolver for the University Housing page (/university-housing).
//
// Deliberately a SEPARATE dataset/resolver from src/lib/universityResolver.js
// (the Student Planner's own university source) rather than reusing it —
// this page is a standalone feature with its own dataset that may include
// institutions (e.g. a language school like Vamos Spanish Academy) that
// don't fit the planner's degree/career/salary pipeline, and keeping the two
// fully separate means neither feature's dataset changes can ever regress
// the other. Same exact/alias-match algorithm as src/lib/universityResolver.js
// though — a silent wrong-university match is worse than an honest
// "not recognized" result, same reasoning as that file.
//
// `type` ("UNIVERSITY" | "SCHOOL") distinguishes higher-education
// institutions from language schools/academies like Vamos Madrid. Every
// record carries an explicit type rather than leaving it implicit, so
// consumers (UniversitySearchBox.js, UniversityHousingMap.js) never need to
// special-case "field absent = university" — same "no implicit default"
// discipline as the rest of this dataset's fields.
import CAMPUS_UNIVERSITIES from "../data/campusUniversities.json";

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
export function resolveCampusUniversity(input) {
  const key = normalize(input);
  if (!key) return null;
  const matches = INDEX.get(key);
  if (!matches || matches.length !== 1) return null;
  return matches[0];
}

// Authoritative id lookup — used to resolve ?university=<id> from the URL
// and to resolve a selected suggestion back to its canonical record.
export function resolveCampusUniversityById(id) {
  if (!id) return null;
  return CAMPUS_UNIVERSITIES.find((u) => u.id === id) || null;
}

// Lightweight autocomplete filter — prefix/substring match against
// name+aliases, for showing suggestions as the student types. Selecting a
// suggestion IS the resolution (the caller already has the canonical record).
export function searchCampusUniversities(query, limit = 8) {
  const q = normalize(query);
  if (!q) return [];
  const seen = new Set();
  const results = [];
  for (const uni of CAMPUS_UNIVERSITIES) {
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

export { CAMPUS_UNIVERSITIES };
