// Milestone 8 (IVYHUTS_MILESTONE_8_REFRESH_LIFECYCLE_REPORT.md, Part 6):
// canonical accommodation inventory service — a single, named boundary in
// front of the canonical Mongo inventory (`AccommodationResidence` +
// `AccommodationIndexMeta`), built to be a future consumer's ONE way to ask
// "what accommodation inventory exists for X," instead of each consumer
// reaching into `accommodationIndex.js`'s individual functions directly.
//
// IMPORTANT — this is a NEW BOUNDARY, not new logic: every function here
// wraps an already-existing, already-tested function in `accommodationIndex.js`
// (unchanged this milestone beyond the Part 1/3 lifecycle/persistence fixes).
// No normalization, availability, or pricing rule is duplicated or
// reimplemented here — see `IVYHUTS_AMBER_MAPPING_INVENTORY.md` for why a
// SECOND parallel implementation would be exactly the risk this milestone's
// brief warns against.
//
// NOT YET WIRED TO ANY CONSUMER (Part 15's explicit scope: "backend
// architecture only" — University Housing, Find Room, Student Planner, and
// Property Detail all remain on their pre-existing call paths this
// milestone). This module exists so Milestone 9's University Housing
// migration has a real, already-tested boundary to migrate ONTO, rather than
// designing it during that migration under time pressure.
"use strict";

const accommodationIndex = require("./accommodationIndex");
const AccommodationResidence = require("./models/AccommodationResidence");
const AccommodationIndexMeta = require("./models/AccommodationIndexMeta");
const { connectToDatabase, MongoNotConfiguredError } = require("./mongodb");
const { normalizeCityName } = require("./amberGateway");
const { resolveMarketCities } = require("./marketAreas");

// getCityInventory(city) — the whole known city inventory, Mongo-first,
// controlled-refresh-on-stale. Thin wrapper over accommodationIndex.js's
// getCityListings() (Find Room's own `?city=` data source, unchanged) — NOT
// a second implementation of its freshness/refresh logic.
async function getCityInventory(city, options = {}) {
    return accommodationIndex.getCityListings(city, options);
}

// getRankedCityInventory(city, opts) — the ranked/budget-fit top-N view
// Student Planner uses. Thin wrapper over getCityResidences() — same
// reasoning as above.
async function getRankedCityInventory(city, options = {}) {
    return accommodationIndex.getCityResidences(city, options);
}

// getAccommodationInventory({city, priority, source}) — Milestone 20's
// shared canonical query service: "what accommodation should be shown for
// this location," expanded to the location's verified market area
// (marketAreas.js) WITHOUT ever touching AccommodationResidence.city.
//
// Deliberately a thin composition of already-existing, already-tested
// functions — getCitiesListings() (Milestone 11, one combined Mongo $in
// query, zero Amber calls) for a multi-city market, or getCityListings()
// (Milestone 8, unchanged single-city behavior/freshness contract
// preserved exactly) when the requested city has no market-area entry.
// No new Mongo query shape, no new normalization, no new availability or
// pricing logic — see accommodationIndex.js's own functions for those.
//
// Dedup by propertyId is defensive, not corrective: AccommodationResidence's
// own {source, propertyId} unique index already makes a true duplicate
// structurally impossible (a given property can only ever be stored under
// ONE city at a time), so this can never actually trigger today — kept
// explicit anyway per this milestone's own instruction, and exercised by
// a synthetic test (scripts/verify-milestone-20-market-area.js) since no
// real duplicate exists to test it against.
async function getAccommodationInventory({ city, priority = "MEDIUM", source = "accommodation-query" } = {}) {
    const primaryCity = normalizeCityName(city);
    const marketCities = resolveMarketCities(city);
    // Bug found and fixed this milestone: a PURE ALIAS entry (one resolved
    // city, different from the requested one — e.g. "city of westminster" ->
    // ["london"]) has marketCities.length === 1, so the old `> 1` check sent
    // it down the single-city fast path using the ORIGINAL unresolved `city`
    // string, never the alias — silently undoing the whole point of adding
    // the alias. The correct condition is "did resolution change anything at
    // all," not "did it expand to more than one city."
    const isPlainSingleCity = marketCities.length === 1 && marketCities[0] === primaryCity;
    const result = isPlainSingleCity
        ? await accommodationIndex.getCityListings(city, { priority, source })
        : await accommodationIndex.getCitiesListings(marketCities);

    const seen = new Set();
    const residences = result.residences.filter((doc) => {
        if (seen.has(doc.propertyId)) return false;
        seen.add(doc.propertyId);
        return true;
    });

    return {
        status: result.status,
        residences,
        location: { primaryCity, marketCities },
    };
}

// getCountryInventory(cityNames) — Milestone 11's canonical multi-city read
// for Find Room's `?country=` browse. Thin wrapper over
// accommodationIndex.js's getCitiesListings() — takes the city-name list the
// frontend's own curated DESTINATIONS dataset already resolves for a given
// country (see that function's own header for why city names, not a country
// string, are the correct join key here).
async function getCountryInventory(cityNames) {
    return accommodationIndex.getCitiesListings(cityNames);
}

// getPropertyBySourceId(sourceId) — canonical-identity lookup directly
// against the Mongo mirror (NOT a live Amber call — for that, existing
// callers already use amberApi.js's getPropertyBySlug()/fetchAmber
// type:"detail", which this service deliberately does not wrap, per this
// milestone's own "separate canonical data from live Amber data" instruction
// — a property's full live detail is intentionally NOT part of the
// canonical Mongo mirror, see AccommodationResidence.js's own header on why).
// Returns the raw Mongo document (already-normalized shape, same as every
// other canonical-Mongo consumer reads) or null if genuinely not indexed.
async function getPropertyBySourceId(sourceId, source = "amber") {
    try {
        await connectToDatabase();
    } catch (err) {
        if (err instanceof MongoNotConfiguredError) return null;
        throw err;
    }
    return AccommodationResidence.findOne({ source, propertyId: String(sourceId) }).lean();
}

// getInventoryStatus(city) — the freshness/lifecycle state for a city,
// without triggering any refresh (a pure read, for a future diagnostics
// surface or a consumer that wants to know status before deciding to wait).
// Thin wrapper over accommodationIndex.js's own classifyCityState() — same
// canonical state machine every read path already uses (FRESH/STALE/
// EXPIRED/MISSING/FAILED_COOLDOWN), extended this milestone with the
// operation-lifecycle fields (operationId/refreshStatus) for visibility into
// an IN-PROGRESS refresh specifically (see accommodationHealth.js for the
// existing, separate full-collection diagnostic; this is the single-city
// equivalent, safe to call per-request).
async function getInventoryStatus(city) {
    const normalizedCity = normalizeCityName(city);
    try {
        await connectToDatabase();
    } catch (err) {
        if (err instanceof MongoNotConfiguredError) return { city: normalizedCity, state: "MISSING", residenceCount: 0 };
        throw err;
    }
    const [meta, residenceCount] = await Promise.all([
        AccommodationIndexMeta.findOne({ city: normalizedCity }).lean(),
        AccommodationResidence.countDocuments({ city: normalizedCity }),
    ]);
    const state = accommodationIndex.classifyCityState(meta, Date.now());
    return {
        city: normalizedCity,
        state,
        residenceCount,
        lastRefreshedAt: meta?.lastRefreshedAt || null,
        lastAttemptedAt: meta?.lastAttemptedAt || null,
        operationId: meta?.operationId || null,
        refreshStatus: meta?.refreshStatus || null,
        consecutiveFailures: meta?.consecutiveFailures || 0,
    };
}

// requestCityRefresh(city, opts) — the ONE way a future consumer should
// trigger a controlled refresh, rather than importing attemptCityRefresh
// directly. Thin wrapper, same lock/budget/gateway guarantees as every
// existing caller (cacheWarmer.js, getCityListings/getCityResidences,
// scripts/backfill-accommodation-inventory.js) — this does not create a
// second refresh mechanism, it names the existing one.
async function requestCityRefresh(city, { priority = "LOW", source = "accommodation-inventory-service", timeoutMs } = {}) {
    const normalizedCity = normalizeCityName(city);
    return accommodationIndex.attemptCityRefresh(normalizedCity, priority, source, { timeoutMs });
}

module.exports = {
    getCityInventory,
    getAccommodationInventory,
    getRankedCityInventory,
    getCountryInventory,
    getPropertyBySourceId,
    getInventoryStatus,
    requestCityRefresh,
};
