// Milestone 20 (IVYHUTS_MILESTONE_20_ACCOMMODATION_ARCHITECTURE_IMPLEMENTATION.md):
// verified accommodation MARKET-AREA relationships — deliberately a small,
// explicit, hand-verified map, NOT a computed/geospatial system (Part 3/6:
// "do NOT invent a huge global database of city relationships. Start
// conservatively.").
//
// A market area answers "which canonical AccommodationResidence.city values
// should be included when a user searches this primary city/university,"
// WITHOUT ever rewriting AccommodationResidence.city itself (Part 16's own
// explicit prohibition, re-stated in this milestone) — Salford properties
// remain stored as city="salford" forever; this module only expands the
// QUERY, at read time, never the data.
//
// UNIVERSITY_HOUSING_DEFAULT_RADIUS_KM is the conceptual basis every entry
// below is verified against before being added (not an enforced runtime
// check — see this file's own header for why a true coordinate/radius
// query is deliberately NOT implemented yet). The one entry below
// (manchester -> salford) was verified in Milestone 19/20 using the
// existing haversineKm() utility: the University of Manchester's own
// curated coordinates are 3.58km from the real, correctly-attributed
// Salford properties Milestone 17 relocated there — comfortably inside
// this radius, not a guess.
const UNIVERSITY_HOUSING_DEFAULT_RADIUS_KM = 10;

const { normalizeCityName } = require("./amberGateway");

// city -> [city, ...nearby cities whose inventory is part of the same
// real housing market]. Every value is already normalizeCityName()'d.
// Extend this ONLY when a new relationship has been verified with real
// coordinate evidence (same standard as the Manchester entry) — never a
// guess, never a blanket "every city near X" rule.
//
// "city of westminster" is a different kind of entry: not a market
// EXPANSION (multiple real Mongo cities) but a pure ALIAS — Nominatim's
// geocoder (api/_lib/universityDiscovery.js's toValidatedRecord()) returns
// UK administrative borough names like "City of Westminster" as a
// university's `address.city`, but IVYHUTS's canonical inventory has never
// stored any property under that literal string (confirmed live:
// AccommodationResidence has 0 documents for "westminster"/"city of
// westminster", and 185 real documents under "london" — the actual market).
// Without this entry, a Westminster-area university's normal search would
// silently return zero results forever, not because of any Amber/ingestion
// gap (separately reconciled, real Amber London inventory: 0 missing from
// Mongo) but because the query itself was scoped to a city string nothing
// is ever indexed under.
const MARKET_AREAS = {
    manchester: ["manchester", "salford"],
    "city of westminster": ["london"],
};

// Resolves a city to its full market-area city list. Cities with no
// explicit market-area entry fall back to themselves only (Part 2:
// "If no market-city definition exists ... " — this milestone implements
// only the explicit-config half of that fallback chain; see this file's
// header and the Milestone 20 report's "known limitations" section for why
// a coordinate-radius fallback for undefined cities is deliberately
// deferred, not silently approximated).
function resolveMarketCities(city) {
    const normalized = normalizeCityName(city);
    if (!normalized) return [];
    return MARKET_AREAS[normalized] || [normalized];
}

module.exports = { MARKET_AREAS, UNIVERSITY_HOUSING_DEFAULT_RADIUS_KM, resolveMarketCities };
