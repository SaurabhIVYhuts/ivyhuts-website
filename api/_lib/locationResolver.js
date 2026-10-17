// Location-intent resolution for University Housing's CITY / COUNTRY search.
//
// Not a second geocoder: it recognises only cities/countries the EXISTING
// search catalog already knows — curated destinations.json plus the
// full-catalog crawl's real city/country summary (insightsMarket.js's
// LOCATION_INDEX_KEY, the same data the homepage search bar reads via
// searchIndex.js). Both carry Amber's own country names, which is exactly
// what AccommodationResidence.country stores, so a resolved country is
// directly usable as an inventory query key with no extra mapping.
//
// Deliberately EXACT matching only (case/whitespace/punctuation/diacritic
// insensitive). A partial or fuzzy match is never promoted to a city/country
// here — that input continues to the unchanged university pipeline instead,
// so "Manchester Metropolitan" can never be swallowed as the city
// "Manchester". No network calls beyond the bounded, cached crawl-summary
// read; a Redis outage degrades to the curated list only.
//
// Imported by universityResolveService.js, so — like every discovery file —
// it must never require amberGateway.js/accommodationIndex.js (or
// searchIndex.js/insightsMarket.js, which do); it reads the summary key
// directly through sharedStore instead.
"use strict";

const DESTINATIONS = require("./destinations.json");
const COUNTRY_FULL_NAMES = require("./countryFullNames.json");
const { sharedGet, log } = require("./sharedStore");
const { withTimeout } = require("./withTimeout");

// Must equal insightsMarket.js's LOCATION_INDEX_KEY (asserted by
// scripts/verify-university-housing-location-search.js).
const LOCATION_INDEX_KEY = "search:locationIndex:v1";
// Same budget/TTL reasoning as searchIndex.js's CRAWL_ENTITIES_* constants.
const LOCATION_INDEX_TIMEOUT_MS = 700;
const LOCATION_INDEX_CACHE_TTL_MS = 5 * 60 * 1000;
let locationIndexCache = null;
let locationIndexCacheAt = 0;

async function loadCrawlSummary() {
    if (locationIndexCache && Date.now() - locationIndexCacheAt < LOCATION_INDEX_CACHE_TTL_MS) return locationIndexCache;
    let summary = null;
    try {
        summary = await withTimeout(sharedGet(LOCATION_INDEX_KEY), LOCATION_INDEX_TIMEOUT_MS, null);
    } catch (err) {
        log(`[locationResolver] action=LOCATION_INDEX_LOAD_FAILED error=${err.message} — using curated destinations only`);
    }
    const result = {
        countries: Array.isArray(summary?.countries) ? summary.countries : [],
        cities: Array.isArray(summary?.cities) ? summary.cities : [],
    };
    locationIndexCache = result;
    locationIndexCacheAt = Date.now();
    return result;
}

function foldDiacritics(s) {
    return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "");
}

// Small, explicit alias list for common ways of naming a country that
// neither the curated code nor Amber's full name covers. Deliberately NOT
// "England"/"Scotland"/"Wales": those are parts of the United Kingdom, and
// mapping them to it would show properties from the wrong nation.
const COUNTRY_ALIASES = {
    "great britain": "United Kingdom",
    britain: "United Kingdom",
    "united states of america": "United States",
    us: "United States",
};

function locationKey(str) {
    return foldDiacritics(str)
        .toLowerCase()
        .replace(/[-_/]+/g, " ")
        .replace(/[^\p{L}\p{N}\s]/gu, "")
        .replace(/\s+/g, " ")
        .trim();
}

const FULL_NAME_TO_CODE = Object.fromEntries(Object.entries(COUNTRY_FULL_NAMES).map(([code, full]) => [full, code]));

function countryFromCodeOrName(value) {
    if (!value) return null;
    if (COUNTRY_FULL_NAMES[value]) return { code: value, fullName: COUNTRY_FULL_NAMES[value] };
    return { code: FULL_NAME_TO_CODE[value] || value, fullName: value };
}

async function loadCatalog() {
    // Crawl summary entries use Amber's full names: {name, cityCount} and {name, country}.
    const summary = await loadCrawlSummary();
    const crawl = {
        countries: summary.countries.map((c) => ({ fullName: c && c.name })),
        cities: summary.cities.filter((c) => c && c.name && c.name !== "Unknown"),
    };

    const countries = new Map(); // fullName -> {code, fullName}
    for (const code of Object.keys(COUNTRY_FULL_NAMES)) countries.set(COUNTRY_FULL_NAMES[code], { code, fullName: COUNTRY_FULL_NAMES[code] });
    for (const d of DESTINATIONS) {
        const c = countryFromCodeOrName(d.country);
        if (!countries.has(c.fullName)) countries.set(c.fullName, c);
    }
    for (const c of crawl.countries) {
        const entry = countryFromCodeOrName(c.fullName);
        if (entry && !countries.has(entry.fullName)) countries.set(entry.fullName, entry);
    }

    const cities = []; // {name, code, fullName, curated}
    const seen = new Set();
    const addCity = (name, countryValue, curated) => {
        const country = countryFromCodeOrName(countryValue);
        if (!name || !country) return;
        const key = `${locationKey(name)}|${country.fullName}`;
        if (seen.has(key)) return;
        seen.add(key);
        cities.push({ name, code: country.code, fullName: country.fullName, curated });
    };
    for (const d of DESTINATIONS) addCity(d.name, d.country, true);
    for (const c of crawl.cities) addCity(c.name, c.country, false);

    return { countries: Array.from(countries.values()), cities };
}

function findCountry(catalog, key) {
    if (!key) return null;
    if (COUNTRY_ALIASES[key]) return countryFromCodeOrName(COUNTRY_ALIASES[key]);
    return catalog.countries.find((c) => locationKey(c.code) === key || locationKey(c.fullName) === key) || null;
}

function toCountryRecord(country) {
    return {
        id: `country:${country.code}`,
        name: country.fullName,
        type: "COUNTRY",
        city: null,
        country: country.fullName,
        countryCode: country.code,
        address: null,
        latitude: null,
        longitude: null,
        source: "location-index",
    };
}

function toCityRecord(city) {
    return {
        id: `city:${city.code}:${locationKey(city.name)}`,
        name: city.name,
        type: "CITY",
        city: city.name,
        country: city.fullName,
        countryCode: city.code,
        address: null,
        latitude: null,
        longitude: null,
        source: "location-index",
    };
}

// Returns null when the query is not an exact, known city/country (the
// caller then continues with university resolution), otherwise
// {status:"resolved", record} or {status:"ambiguous", candidates} — the same
// status vocabulary universityResolveService.js already returns.
async function resolveLocationQuery(rawQuery) {
    const query = String(rawQuery || "").trim();
    if (!query) return null;
    const catalog = await loadCatalog();

    // "Manchester, UK" / "London, Canada" — an explicit country qualifier.
    const commaIdx = query.lastIndexOf(",");
    if (commaIdx > 0) {
        const country = findCountry(catalog, locationKey(query.slice(commaIdx + 1)));
        const cityKey = locationKey(query.slice(0, commaIdx));
        if (country && cityKey) {
            const city = catalog.cities.find((c) => c.fullName === country.fullName && locationKey(c.name) === cityKey);
            return city ? { status: "resolved", record: toCityRecord(city) } : null;
        }
    }

    const key = locationKey(query);
    // A country always wins over a same-named city (Singapore, Hong Kong):
    // the country's inventory is a superset of that city's.
    const country = findCountry(catalog, key);
    if (country) return { status: "resolved", record: toCountryRecord(country) };

    const cityMatches = catalog.cities.filter((c) => locationKey(c.name) === key);
    if (!cityMatches.length) return null;
    if (cityMatches.length === 1) return { status: "resolved", record: toCityRecord(cityMatches[0]) };

    // Same city name in several countries. The curated destination list is
    // the site's authoritative market list (Find Room navigates by it), so a
    // single curated match is taken as the intended one; anything else is
    // genuinely ambiguous and the user chooses — never a silent guess.
    const curated = cityMatches.filter((c) => c.curated);
    if (curated.length === 1) return { status: "resolved", record: toCityRecord(curated[0]) };
    return { status: "ambiguous", candidates: cityMatches.map(toCityRecord) };
}

// Canonical {code, fullName} for a country given as a curated code ("UK"),
// Amber full name ("United Kingdom") or a known alias, any casing. Returns
// null for anything unknown — callers must not invent a country.
async function canonicalizeCountry(value) {
    const key = locationKey(value);
    if (!key) return null;
    return findCountry(await loadCatalog(), key);
}

// The curated cities for a country — the same country->cities list Find
// Room's ?country= browse already joins on (accommodationIndex.js's
// getCitiesListings header explains why).
function curatedCitiesForCountry(country) {
    if (!country) return [];
    return DESTINATIONS.filter((d) => countryFromCodeOrName(d.country).fullName === country.fullName).map((d) => d.name);
}

module.exports = {
    resolveLocationQuery,
    canonicalizeCountry,
    curatedCitiesForCountry,
    locationKey,
    LOCATION_INDEX_KEY,
    // Test-only: lets a verify script reset the per-instance summary cache.
    _resetLocationIndexCache: () => { locationIndexCache = null; locationIndexCacheAt = 0; },
};
