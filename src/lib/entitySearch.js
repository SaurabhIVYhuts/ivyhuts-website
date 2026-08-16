// Complete client-side search index for countries/cities/universities —
// properties are OUT OF SCOPE for this phase (see GlobalSearchBar.js's own
// header). Two data sources, merged:
//
//   1. BUNDLED (curated) — src/data/destinations.js and campusUniversities.json,
//      already part of the JS bundle, so available with zero network cost
//      the instant this module loads.
//   2. REMOTE (comprehensive) — GET /api/search-data, fetched EXACTLY ONCE per
//      page session (see ensureSearchDataLoaded below), never per keystroke.
//      Backed by the existing full-catalog crawl (api/_lib/insightsMarket.js),
//      not a curated shortlist — every real country/city/university the
//      crawl has discovered, not just the ~25 countries/~63 cities/~26
//      universities IVYHUTS has hand-curated for the homepage.
//
// Matching (normalize/matchRank/levenshtein) is a small, intentionally
// duplicated pure-function twin of api/_lib/searchIndex.js's algorithm of
// the same names — CommonJS (api/_lib) vs ES modules (src/) means these
// can't be a single shared file, same tradeoff already accepted for the
// destinations.json/campusUniversities.json data twins.
//
// Once /api/search-data resolves, every subsequent keystroke searches the
// FULL merged dataset (hundreds of cities, not a slice) — .slice(0, limit)
// only ever happens at the very end, on already-ranked results, never on the
// candidate set itself.
import { DESTINATIONS, countryFullName } from "../data/destinations";
import { CAMPUS_UNIVERSITIES } from "./campusUniversityResolver";

function normalize(str) {
  return String(str || "").toLowerCase().replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim();
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const al = a.length, bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;
  let prev = Array.from({ length: bl + 1 }, (_, i) => i);
  for (let i = 1; i <= al; i++) {
    const cur = [i];
    for (let j = 1; j <= bl; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j - 1], prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return prev[bl];
}

// rank: 0 exact, 1 prefix (whole-string OR a whole word inside it starts
// with the query — "venti" against "LST Venti House" should rank as a
// strong match, not buried behind generic substrings), 2 substring,
// 3 typo-tolerant fuzzy, null = no match.
//
// The fuzzy tier's tolerance was deliberately TIGHTENED here (maxDist fixed
// at 1, not scaled up for longer queries) after the comprehensive ~600-city
// dataset made the looser tolerance produce genuinely irrelevant matches —
// confirmed live: "Canada" (edit distance 2 away) was matching both "Canal
// Winchester" and "Granada", neither a reasonable typo-correction target.
// distance<=1 still covers real single-character typos ("Lodon"->London,
// "Birkbecc"->Birkbeck, both edit distance 1) while rejecting the
// 2-edit-away false positives. This intentionally diverges from
// api/_lib/searchIndex.js's matchRank of the same name (previously "kept in
// sync") — that copy only backs PropertyListingPage's property-name
// resolution fallback now that GlobalSearchBar no longer calls /api/search,
// so its own fuzzy tolerance doesn't affect this relevance concern and was
// left untouched per an explicit "no other changes" scope for this pass.
function matchRank(haystackNorm, qNorm) {
  if (!qNorm) return null;
  if (haystackNorm === qNorm) return 0;
  if (haystackNorm.startsWith(qNorm)) return 1;
  const tokens = haystackNorm.split(" ");
  // Word-boundary prefix only counts for queries of 4+ chars — see
  // api/_lib/searchIndex.js's matchRank (kept in sync) for why shorter
  // tokens are too weak a signal (e.g. "uk" spuriously matching an alias
  // that merely ends in the word "UK").
  if (qNorm.length >= 4 && tokens.some((t) => t.startsWith(qNorm))) return 1;
  if (haystackNorm.includes(qNorm)) return 2;
  const qWords = qNorm.split(" ").filter(Boolean);
  if (qWords.length > 1 && qWords.every((w) => w.length >= 2) && qWords.every((qw) => tokens.some((hw) => hw.startsWith(qw)))) {
    return 2;
  }
  if (qNorm.length < 4) return null; // too short for fuzzy tolerance ("lon" ~ "Lyon")
  const maxDist = 1; // one real typo (insert/delete/substitute) — see this function's header for why this isn't scaled up for longer queries anymore
  const fuzzy = tokens.some((t) => t.length >= 3 && levenshtein(t.slice(0, qNorm.length + maxDist), qNorm) <= maxDist);
  return fuzzy ? 3 : null;
}

// Reverse of destinations.js's own countryFullName(code) — e.g.
// "United Kingdom" -> "UK" — derived from the curated list itself (not a
// second hand-copied map) so a comprehensive COUNTRY match for an already-
// curated country reuses the exact `?country=` code value the existing
// country-browse page navigates with. A crawl-only country with no curated
// equivalent just keeps its real full name as its own "code" (no curated
// city-picker page exists for it yet — see PropertyListingPage.js's existing
// graceful "no cities listed" empty state for that case).
const FULL_NAME_TO_CODE = (() => {
  const map = {};
  const seen = new Set();
  for (const d of DESTINATIONS) {
    if (seen.has(d.country)) continue;
    seen.add(d.country);
    map[countryFullName(d.country)] = d.country;
  }
  return map;
})();

// ── Remote (comprehensive) dataset — fetched at most once per page session ──
let remoteData = { countries: [], cities: [], universities: [] };
let remoteDataPromise = null;
let remoteDataLoaded = false;

// Call once (GlobalSearchBar does this on mount) to kick off the ONE fetch
// for this session; safe to call from multiple mounted search bars — they
// all share this single in-flight/cached promise, never issuing a second
// request. Never throws: a failed fetch just means search stays on curated
// (bundled) coverage only, exactly as it always could.
export function ensureSearchDataLoaded() {
  if (remoteDataPromise) return remoteDataPromise;
  remoteDataPromise = fetch("/api/search-data")
    .then((res) => (res.ok ? res.json() : null))
    .then((body) => {
      if (body?.ok && body.data) {
        remoteData = body.data;
        remoteDataLoaded = true;
      }
    })
    .catch(() => {
      // Stays on curated-only coverage — never breaks search.
    });
  return remoteDataPromise;
}

export function isSearchDataLoaded() {
  return remoteDataLoaded;
}

const COUNTRIES = (() => {
  const byCode = new Map();
  for (const d of DESTINATIONS) {
    if (!byCode.has(d.country)) byCode.set(d.country, { code: d.country, cityCount: 0 });
    byCode.get(d.country).cityCount += 1;
  }
  return Array.from(byCode.values());
})();

// Every function below scans the FULL merged dataset (bundled + remote) —
// `limit` is only ever applied as a final .slice() on already-ranked
// results, never on the candidate set itself, so a query genuinely searches
// every one of the (eventually ~600+) real cities, not a curated subset.
function searchCities(qNorm, limit) {
  const out = [];
  const seen = new Set();
  const consider = (name, countryLabel) => {
    const key = name.trim().toLowerCase();
    if (seen.has(key)) return;
    const rank = matchRank(normalize(name), qNorm);
    if (rank == null) return;
    seen.add(key);
    out.push({ type: "city", id: name, label: name, sublabel: countryLabel, value: { city: name, country: countryLabel }, rank });
  };
  for (const d of DESTINATIONS) consider(d.name, countryFullName(d.country));
  for (const c of remoteData.cities) consider(c.name, c.country);
  out.sort((a, b) => a.rank - b.rank);
  return out.slice(0, limit);
}

function searchCountries(qNorm, limit) {
  const out = [];
  const seen = new Set();
  const consider = (fullName, cityCount, aliases = []) => {
    if (seen.has(fullName)) return;
    const haystacks = [fullName, ...aliases].map(normalize);
    const rank = haystacks.reduce((best, h) => {
      const r = matchRank(h, qNorm);
      return r != null && r < best ? r : best;
    }, 99);
    if (rank === 99) return;
    seen.add(fullName);
    const code = FULL_NAME_TO_CODE[fullName] || fullName;
    out.push({ type: "country", id: code, label: fullName, sublabel: `${cityCount} ${cityCount === 1 ? "city" : "cities"}`, value: { country: code }, rank });
  };
  for (const c of COUNTRIES) consider(countryFullName(c.code), c.cityCount);
  for (const c of remoteData.countries) consider(c.name, c.cityCount, c.aliases);
  out.sort((a, b) => a.rank - b.rank);
  return out.slice(0, limit);
}

function citiesForCountries(countryMatches, existingCityNames, limit) {
  const out = [];
  for (const c of countryMatches) {
    if (c.rank > 1) continue;
    const candidates = [
      ...DESTINATIONS.filter((d) => d.country === c.id).map((d) => ({ name: d.name, country: countryFullName(d.country) })),
      ...remoteData.cities.filter((ct) => (FULL_NAME_TO_CODE[ct.country] || ct.country) === c.id),
    ];
    for (const d of candidates) {
      if (existingCityNames.has(d.name) || out.some((o) => o.id === d.name)) continue;
      out.push({ type: "city", id: d.name, label: d.name, sublabel: d.country, value: { city: d.name, country: d.country }, rank: 2 });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

function searchUniversities(qNorm, limit) {
  const out = [];
  const seen = new Set();
  for (const u of CAMPUS_UNIVERSITIES) {
    const haystacks = [u.name, ...(u.aliases || [])].map(normalize);
    const rank = haystacks.reduce((best, h) => {
      const r = matchRank(h, qNorm);
      return r != null && r < best ? r : best;
    }, 99);
    seen.add(normalize(u.name));
    if (rank === 99) continue;
    out.push({ type: "university", id: u.id, label: u.name, sublabel: [u.city, u.country].filter(Boolean).join(", "), value: { universityId: u.id }, rank });
  }
  for (const u of remoteData.universities) {
    const key = normalize(u.name);
    if (seen.has(key)) continue; // already represented by a curated, hand-verified record
    const haystacks = [u.name, ...(u.aliases || [])].map(normalize);
    const rank = haystacks.reduce((best, h) => {
      const r = matchRank(h, qNorm);
      return r != null && r < best ? r : best;
    }, 99);
    if (rank === 99) continue;
    seen.add(key);
    out.push({
      type: "university", id: `extracted:${key}`, label: u.name,
      sublabel: [u.city, u.country].filter(Boolean).join(", "),
      // No canonical id (this wasn't hand-curated with coordinates) —
      // navigates via the SAME city + "University / Area" proximity filter
      // PropertyListingPage.js already implements, seeded with this exact
      // place name so it only shows properties actually near it.
      value: { city: u.city, near: u.name }, rank,
    });
  }
  out.sort((a, b) => a.rank - b.rank);
  return out.slice(0, limit);
}

// Single "best" pick across cities/countries/universities (no properties —
// out of scope this phase), same TYPE_PRIORITY tiebreak spirit as
// api/_lib/searchIndex.js's pickBest, just computed here instead of
// server-side now that there's no per-keystroke network round trip to carry it.
const TYPE_PRIORITY = { university: 0, city: 1, country: 2 };
function pickBest(groups) {
  let best = null;
  for (const type of Object.keys(groups)) {
    for (const item of groups[type]) {
      if (!best || item.rank < best.rank || (item.rank === best.rank && TYPE_PRIORITY[item.type] < TYPE_PRIORITY[best.type])) {
        best = item;
      }
    }
  }
  return best;
}

// Same ambiguity rule as before: an exact (rank 0) match is always
// confident; anything weaker is confident only if it's the UNIQUE top-ranked
// item across every group — a tie means the user must choose, not guess.
function isBestConfident(best, groups) {
  if (!best) return false;
  if (best.rank === 0) return true;
  let tiedCount = 0;
  for (const type of Object.keys(groups)) {
    for (const item of groups[type]) {
      if (item.rank === best.rank) tiedCount += 1;
    }
  }
  return tiedCount === 1;
}

// The one function GlobalSearchBar calls on every keystroke — pure,
// synchronous, no network, no debounce needed (target: well under 100ms
// even once the full remote dataset is loaded, since it's a few hundred
// short-string comparisons).
export function searchAllEntities(query, limit = 6) {
  const qNorm = normalize(query);
  if (!qNorm) return { cities: [], universities: [], countries: [], best: null, bestConfident: false };
  const universities = searchUniversities(qNorm, limit);
  const countries = searchCountries(qNorm, limit);
  const cities = searchCities(qNorm, limit);
  const finalCities = countries.some((c) => c.rank <= 1) && cities.length < limit
    ? [...cities, ...citiesForCountries(countries, new Set(cities.map((c) => c.id)), limit - cities.length)]
    : cities;
  const groups = { cities: finalCities, universities, countries };
  const best = pickBest(groups);
  return { ...groups, best, bestConfident: isBestConfident(best, groups) };
}
