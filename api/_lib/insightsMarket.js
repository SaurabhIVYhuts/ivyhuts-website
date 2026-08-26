// Real market intelligence for the /insight dashboard, guaranteed to
// reconcile with the homepage's Sold Out counter.
//
// A previous version of this file queried Amber per-city from a curated
// destination list (src/data/destinations.js) and summed the results — that
// structurally CANNOT reach the homepage's site-wide total, because that
// curated list is explicitly "not Amber inventory enumeration" (see that
// file's own header comment): Amber can have sold-out properties in cities
// IVYHUTS doesn't market on the homepage at all, so no sum over a partial
// city list can ever equal the true total.
//
// This version instead does what api/_lib/inventoryStats.js's site-wide
// number itself is built from, taken further: a full, resumable, paginated
// crawl of Amber's ENTIRE `/inventories` catalog (both available=true and
// available=false), bucketing every single item by its own real
// country/city as we go. Because every item is counted exactly once, the
// sum across every bucket is mathematically guaranteed to equal the crawl's
// own total once it finishes — no curated list, no undercount.
//
// The crawl is resumable and budget-safe: progress (next page per side,
// accumulated per-country/per-city aggregates) is persisted in the shared
// store (Redis, or the in-memory fallback in local dev) under CRAWL_KEY.
// Each call to getMarketIntelligence() advances the crawl by at most
// PAGES_PER_ADVANCE real Amber page fetches (LOW priority, through the same
// coordinated fetchListings() gateway every real page view uses — full
// budget/lock/cooldown protection, see amberGateway.js) and returns
// whatever's been accumulated so far, plus how much of the catalog remains.
// The frontend polls this endpoint every ~15s (see InsightPage.js) until
// `crawlProgress.complete` is true, so the full ~87-page catalog (at the
// 6-requests/minute shared budget) finishes in a few minutes without ever
// bursting Amber or blocking a single request on the whole crawl.
const { sharedGet, sharedSet, acquireLock, releaseLock, RedisUnavailableError, log } = require("./sharedStore");
const { fetchListings, RATE_BUDGET_PER_MINUTE, normalizeCityName } = require("./amberGateway");
const { getInventoryStats } = require("./inventoryStats");
const { connectToDatabase } = require("./mongodb");
const { mapAmberItemToResidence, persistResidencesRaw } = require("./accommodationIndex");
const AccommodationResidence = require("./models/AccommodationResidence");
const CAMPUS_UNIVERSITIES = require("./campusUniversities.json");
const COUNTRY_FULL_NAMES = require("./countryFullNames.json");

const PAGE_LIMIT = 50; // Amber's own max items per page
const PAGES_PER_ADVANCE = RATE_BUDGET_PER_MINUTE; // at most one full shared budget window's worth of page fetches per call
const CRAWL_KEY = "insights:marketCrawl:v2";
const CRAWL_LOCK_KEY = "insights:marketCrawl:v2:lock";
const CRAWL_LOCK_TTL_MS = 20_000;
// Defensive cap on the full sold-out property list kept in the crawl state —
// real sold-out volume is far smaller than this (low thousands at most), but
// this keeps a single Redis value bounded regardless of catalog growth.
const SOLD_OUT_PROPERTIES_CAP = 5000;
// A stale/expired crawl just starts over from page 1 — cheap to redo, but
// the TTL clock only resets on a successful advance, and a *completed*
// crawl is never touched again until it expires. So this value isn't just
// "how fresh is the data" — it's "how long a finished crawl survives before
// silently restarting from zero." The 08:00 IST daily digest
// (api/_lib/insightsDigest.js) refuses to save a snapshot unless the crawl
// is complete at that exact moment, so the old 3-hour TTL meant completion
// had to line up with a fixed clock time purely by luck: a full pass takes
// on the order of an hour once (at 6 pages/tick, every 5 min, shared with
// every other Amber caller — see advanceCrawl below), which is close enough
// to 3 hours that the crawl could easily be mid-reset right at 08:00 IST on
// any given day, not just the day this feature launched. 26 hours (a full
// day plus headroom) means a crawl that completes at all in a day stays
// "done" straight through the next day's 08:00 IST digest, decoupling
// completion from the digest's fixed schedule.
const CRAWL_TTL_SECONDS = 26 * 60 * 60;

// A tiny, purpose-built summary derived from `state.countries` — every real
// country/city the full crawl has discovered so far, and NOTHING else (no
// per-city price stats, no samples, no the full sold-out property list —
// those stay in CRAWL_KEY's ~900KB blob). This is what api/_lib/searchIndex.js
// reads for comprehensive country/city coverage: a global search request
// must never pay the cost of fetching/parsing the full crawl-state blob just
// to answer "does this city exist" — confirmed live to take ~1-1.5s for the
// full blob vs. this summary, which is two orders of magnitude smaller
// (roughly a few hundred country/city name pairs, well under the crawl's own
// nearly-1MB size). Kept as its OWN shared-store key (not derived on read
// from CRAWL_KEY) so a cold /api/search request only ever pays for a small,
// fast Redis GET, never the large one.
const LOCATION_INDEX_KEY = "search:locationIndex:v1";
const LOCATION_INDEX_TTL_SECONDS = CRAWL_TTL_SECONDS;

// Pure — takes an already-loaded crawl state, returns the small summary.
// Exported separately from saveLocationIndex so a caller (or a test) can
// inspect the derivation without needing write access to the shared store.
function buildLocationIndex(state) {
    const countries = [];
    const cities = [];
    for (const [countryName, bucket] of Object.entries(state?.countries || {})) {
        const countryTotal = (bucket.soldOut || 0) + (bucket.available || 0);
        if (countryTotal <= 0) continue;
        const cityNames = Object.keys(bucket.cities || {});
        countries.push({ name: countryName, cityCount: cityNames.length });
        for (const cityName of cityNames) {
            const cityBucket = bucket.cities[cityName];
            const cityTotal = (cityBucket.soldOut || 0) + (cityBucket.available || 0);
            // "Unknown" is Amber's own placeholder for a missing locality —
            // real inventory, but not a real, nameable city, so it would only
            // ever confuse a location search rather than help one.
            if (cityTotal <= 0 || !cityName || cityName === "Unknown") continue;
            cities.push({ name: cityName, country: countryName });
        }
    }
    return { countries, cities, updatedAt: Date.now() };
}

// Writes the summary — called every time advanceCrawl() runs (see below),
// on the SAME cadence as the existing 5-minute cron, so if the crawl
// discovers a new country/city on some future pass, the search-facing
// summary picks it up automatically within one cron tick, with zero
// additional Amber calls (this only re-reads/re-derives state the crawl
// already fetched — no network call to Amber of its own). Best-effort: a
// failure here must never break the crawl itself, only leave the search
// summary stale until the next tick retries.
async function saveLocationIndex(state) {
    try {
        const summary = buildLocationIndex(state);
        await sharedSet(LOCATION_INDEX_KEY, summary, LOCATION_INDEX_TTL_SECONDS);
    } catch (err) {
        log(`[insightsMarket] action=LOCATION_INDEX_SAVE_FAILED error=${err.message}`);
    }
}

// What api/_lib/searchIndex.js actually reads — small and fast, or null if
// the crawl has never completed a tick since this summary existed (falls
// back to curated-only coverage until the next cron tick populates it).
function loadLocationIndex() {
    return sharedGet(LOCATION_INDEX_KEY);
}

// ── Complete search dataset (countries + cities + universities), for the
// property-search-out-of-scope Global Search phase. Conceptually the
// "search-data.json" the product spec describes — physically a shared-store
// key (SEARCH_DATA_KEY below), not a file on disk, because Vercel serverless
// functions have no persistent/writable filesystem across invocations; the
// shared store IS this project's existing mechanism for "a generated
// artifact the crawl produces and other requests read" (see LOCATION_INDEX_KEY
// above, or amber:invstats:aggregate). api/search-data.js serves this key's
// contents as real JSON over HTTP, which is what the frontend actually
// fetches — so from the browser's point of view it IS a JSON document, just
// backed by Redis instead of a static file, and kept up to date by the
// existing crawl cron instead of a build step. ──
const SEARCH_DATA_KEY = "search:searchData:v1";
const SEARCH_DATA_TTL_SECONDS = CRAWL_TTL_SECONDS;

function slugify(str) {
    return String(str || "")
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}

// Every REAL university/college name in the inventory: the curated,
// hand-verified campusUniversities.json (real coordinates/aliases) PLUS
// every DISTINCT name extracted from properties' own nearby-place data (see
// accommodationIndex.js's getNearbyUniversities — same free-text signal
// PropertyListingPage.js's University/Area filter already trusts). This is
// a background/generation-time read of AccommodationResidence (as part of
// the crawl's own lifecycle, same as LOCATION_INDEX_KEY above), NOT a
// per-keystroke property query — the live /api/search-data endpoint only
// ever reads the already-computed result of this function, never runs it
// itself. Never fabricates: an extracted entry is exactly the string Amber's
// own data reported, nothing invented. Best-effort — a Mongo failure here
// just means the university list stays curated-only until the next tick.
async function buildSearchDataUniversities() {
    const universities = [];
    const seen = new Set();
    for (const u of CAMPUS_UNIVERSITIES) {
        const key = String(u.name).trim().toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        universities.push({
            name: u.name, city: u.city || null, country: u.country || null,
            slug: slugify(u.name), aliases: u.aliases || [], curated: true,
        });
    }
    try {
        await connectToDatabase();
        const rows = await AccommodationResidence.aggregate([
            { $match: { nearbyUniversities: { $exists: true, $ne: [] } } },
            { $unwind: "$nearbyUniversities" },
            { $group: { _id: "$nearbyUniversities", city: { $first: "$city" }, country: { $first: "$country" } } },
        ]);
        for (const row of rows) {
            const key = String(row._id).trim().toLowerCase();
            if (seen.has(key)) continue; // already represented by a curated, hand-verified record
            seen.add(key);
            universities.push({
                name: row._id, city: row.city || null, country: row.country || null,
                slug: slugify(row._id), aliases: [], curated: false,
            });
        }
    } catch (err) {
        log(`[insightsMarket] action=SEARCH_DATA_UNIVERSITIES_FAILED error=${err.message}`);
    }
    return universities;
}

// Real, known abbreviations for the handful of curated countries whose
// short code genuinely differs from their full name (UK, USA, UAE) — these
// are the SAME codes destinations.json/searchIndex.js already treat as
// equivalent to the full name, surfaced here as an explicit alias rather
// than invented. A crawl-only country with no curated equivalent gets no
// alias (nothing to draw one from without guessing).
function countryAliases(fullName) {
    for (const [code, full] of Object.entries(COUNTRY_FULL_NAMES)) {
        if (full === fullName && code !== fullName) return [code];
    }
    return [];
}

// The /insight dashboard's country dropdown (src/data/destinations.js) sends
// curated short codes ("UK", "USA", "UAE") — the same codes COUNTRY_FULL_NAMES
// already maps to Amber's real full country name. Every real record this
// file buckets by (state.countries, stored snapshot country/city fields) uses
// that full name, since it comes straight from Amber's own
// location.country.long_name (see normalizeItem above) — never the curated
// short code. Resolving here means every country-filter comparison in this
// file compares like with like instead of "UK" !== "United Kingdom" silently
// matching zero rows. A country with no curated code (crawl-only) passes
// through unchanged.
function resolveCountryFilter(country) {
    if (!country) return country;
    return COUNTRY_FULL_NAMES[country] || country;
}

// Pure — builds the complete {countries, cities, universities} dataset from
// an already-loaded crawl state plus the university sources above. Countries/
// cities reuse buildLocationIndex's own derivation (same real crawl data, so
// there is exactly one place that decides "what counts as a real discovered
// city") — this just adds the slug/alias fields the frontend dataset shape
// needs on top.
async function buildSearchData(state) {
    const location = buildLocationIndex(state);
    const countries = location.countries.map((c) => ({
        name: c.name, slug: slugify(c.name), aliases: countryAliases(c.name), cityCount: c.cityCount,
    }));
    const cities = location.cities.map((c) => ({
        name: c.name, country: c.country, slug: slugify(c.name), aliases: [],
    }));
    const universities = await buildSearchDataUniversities();
    return { countries, cities, universities, updatedAt: Date.now() };
}

// Called every time advanceCrawl() runs (see below) — same cadence/failure
// philosophy as saveLocationIndex above: never breaks the crawl itself, just
// leaves the dataset stale (or, on the very first tick after this code
// deploys, absent — api/search-data.js has its own curated-only fallback for
// exactly that gap) until the next tick retries.
async function saveSearchData(state) {
    try {
        const data = await buildSearchData(state);
        await sharedSet(SEARCH_DATA_KEY, data, SEARCH_DATA_TTL_SECONDS);
    } catch (err) {
        log(`[insightsMarket] action=SEARCH_DATA_SAVE_FAILED error=${err.message}`);
    }
}

// What api/search-data.js actually serves — small (countries + cities +
// universities only, no per-city price stats or sold-out property lists)
// and pre-computed, so the endpoint itself never touches Amber, Mongo, or
// the full crawl blob at request time.
function loadSearchData() {
    return sharedGet(SEARCH_DATA_KEY);
}

// Grows LOCATION_INDEX_KEY/SEARCH_DATA_KEY incrementally from REAL traffic —
// any real listings/detail Amber response the site already fetches for
// other reasons (a user browsing a city, viewing a property) — instead of
// waiting for the crawl's next full pass. A country/city genuinely in
// Amber's catalog that the crawl's LAST completed pass didn't discover
// (confirmed live: Darwin, Australia — 2 real properties, added to Amber's
// catalog after the crawl's last pass finished and the crawl then sat idle)
// becomes searchable the first time ANY real request happens to surface it.
//
// Captures BOTH `location.locality` (fine-grained, e.g. "Casuarina") AND
// `location.district` (the broader city/metro name, e.g. "City of Darwin")
// as separate real city entries — confirmed live that Amber's own address
// hierarchy splits these two levels, and a search for "Darwin" only matches
// district ("City of Darwin" / "Darwin Municipality"), never locality alone.
// Both are used completely verbatim, exactly as Amber sent them — never
// cleaned/parsed/renamed ("City of Darwin" is NOT rewritten to "Darwin"),
// since guessing at that transformation risks being wrong for some other
// district's naming convention. matchRank's existing word-boundary tier
// already ranks "darwin" as a strong (not just substring) match against
// "city of darwin" without any special-casing needed here.
//
// Deliberately does NOT touch insights:marketCrawl:v2 (the full crawl
// state the /insight market-intelligence dashboard depends on) — that
// key's per-property counts are only accurate as a single coherent full
// pass, so incrementally poking new cities into it here would silently
// corrupt its numbers. This function only ever touches the two small
// search-facing summaries, which have no such "one coherent pass" constraint
// — a duplicate-safe union is exactly what they need. Same growth
// philosophy already proven for universities (accommodationIndex.js's
// getNearbyUniversities), applied here to countries/cities instead. Zero
// new Amber calls: only ever reads items a response already fetched for a
// different reason (see api/amber.js's indexOnRead, which is what calls this).
function realCityNamesFor(item) {
    const names = new Set();
    const locality = item?.location?.locality?.long_name;
    const district = item?.location?.district?.long_name;
    if (locality) names.add(locality);
    if (district) names.add(district);
    return Array.from(names);
}

async function growSearchDataFromRealTraffic(items) {
    if (!items || !items.length) return;
    try {
        const [locationIndex, searchData] = await Promise.all([loadLocationIndex(), loadSearchData()]);
        if (!locationIndex && !searchData) return; // nothing to grow yet — the crawl's first tick creates the base

        let locationChanged = false;
        let searchDataChanged = false;
        const locCountries = locationIndex ? [...locationIndex.countries] : null;
        const locCities = locationIndex ? [...locationIndex.cities] : null;
        const locCountrySet = locationIndex ? new Set(locCountries.map((c) => c.name)) : null;
        const locCityKeySet = locationIndex ? new Set(locCities.map((c) => `${c.name}|${c.country}`)) : null;

        const sdCountries = searchData ? [...searchData.countries] : null;
        const sdCities = searchData ? [...searchData.cities] : null;
        const sdCountrySet = searchData ? new Set(sdCountries.map((c) => c.name)) : null;
        const sdCityKeySet = searchData ? new Set(sdCities.map((c) => `${c.name}|${c.country}`)) : null;

        for (const item of items) {
            const country = item?.location?.country?.long_name;
            if (!country) continue;
            for (const city of realCityNamesFor(item)) {
                if (!city || city === "Unknown") continue;
                const cityKey = `${city}|${country}`;

                if (locationIndex) {
                    if (!locCountrySet.has(country)) { locCountries.push({ name: country, cityCount: 0 }); locCountrySet.add(country); locationChanged = true; }
                    if (!locCityKeySet.has(cityKey)) { locCities.push({ name: city, country }); locCityKeySet.add(cityKey); locationChanged = true; }
                }
                if (searchData) {
                    if (!sdCountrySet.has(country)) { sdCountries.push({ name: country, slug: slugify(country), aliases: countryAliases(country), cityCount: 0 }); sdCountrySet.add(country); searchDataChanged = true; }
                    if (!sdCityKeySet.has(cityKey)) { sdCities.push({ name: city, country, slug: slugify(city), aliases: [] }); sdCityKeySet.add(cityKey); searchDataChanged = true; }
                }
            }
        }

        if (locationChanged) {
            for (const c of locCountries) c.cityCount = locCities.filter((ct) => ct.country === c.name).length;
            await sharedSet(LOCATION_INDEX_KEY, { countries: locCountries, cities: locCities, updatedAt: Date.now() }, LOCATION_INDEX_TTL_SECONDS);
        }
        if (searchDataChanged) {
            for (const c of sdCountries) c.cityCount = sdCities.filter((ct) => ct.country === c.name).length;
            await sharedSet(SEARCH_DATA_KEY, { ...searchData, countries: sdCountries, cities: sdCities, updatedAt: Date.now() }, SEARCH_DATA_TTL_SECONDS);
        }
    } catch (err) {
        log(`[insightsMarket] action=GROW_SEARCH_DATA_FAILED error=${err.message}`);
    }
}

function toNumber(v) {
    if (v == null) return null;
    const n = typeof v === "number" ? v : Number(String(v).replace(/[^0-9.-]/g, ""));
    return Number.isFinite(n) ? n : null;
}

// Amber's `pricing.currency` is inconsistently formatted across markets —
// confirmed against live data: UK/USA send an English word ("pound",
// "dollar"), other markets send a lowercase ISO-ish code ("cad", "aud").
// Base mapping mirrors src/services/amberMapper.js's CURRENCY_SYMBOLS
// (duplicated, not imported — api/_lib is plain CommonJS, src/services is an
// ES module meant for CRA's build), extended with every currency observed
// across Amber's real markets so a management dashboard never shows a raw
// currency word.
const CURRENCY_SYMBOLS = {
    pound: "£", gbp: "£",
    dollar: "$", usd: "$",
    euro: "€", eur: "€",
    cad: "C$", "canadian dollar": "C$",
    aud: "A$", "australian dollar": "A$",
    sgd: "S$", "singapore dollar": "S$",
    nzd: "NZ$", "new zealand dollar": "NZ$",
    hkd: "HK$", "hong kong dollar": "HK$",
    aed: "AED", dirham: "AED", "uae dirham": "AED",
    chf: "CHF", "swiss franc": "CHF",
    krw: "₩", won: "₩",
    jpy: "¥", yen: "¥",
    myr: "RM", ringgit: "RM", "malaysian ringgit": "RM",
    pln: "zł", zloty: "zł",
    czk: "Kč", koruna: "Kč",
    dkk: "kr", krone: "kr",
};
// Unmapped currencies fall back to the raw code UPPERCASED (e.g. "THB"),
// never the lowercase raw word Amber sent.
function currencySymbol(raw) {
    if (!raw) return "";
    const key = String(raw).trim().toLowerCase();
    return CURRENCY_SYMBOLS[key] || String(raw).toUpperCase();
}

// Minimal, read-only mirror of the field paths src/services/amberMapper.js
// already uses on the frontend — duplicated for the CommonJS/ESM boundary
// reason noted above.
function normalizeItem(raw, available) {
    if (!raw || typeof raw !== "object") return null;
    const loc = raw.location || {};
    const pricing = raw.pricing || {};
    return {
        id: raw.id ?? null,
        slug: raw.canonical_name || null,
        name: raw.name || "Student Accommodation",
        country: loc.country?.long_name || "Unknown",
        locality: loc.locality?.long_name || "Unknown",
        pincode: loc.postal_code?.long_name || null,
        available,
        minPrice: toNumber(pricing.min_price ?? pricing.available_price),
        currency: currencySymbol(pricing.currency) || null,
    };
}

function extractResultArray(json) {
    return Array.isArray(json?.data?.result) ? json.data.result : [];
}

function freshCrawlState() {
    return {
        soldOut: { nextPage: 1, expectedTotal: null, fetchedCount: 0, done: false },
        available: { nextPage: 1, expectedTotal: null, fetchedCount: 0, done: false },
        countries: {}, // { [country]: { soldOut, available, cities: { [city]: { soldOut, available, priceSum, priceCount, priceMin, priceMax, currency, samples: [...] } } } }
        postcodes: {}, // { [postcode]: { postcode, city, country, soldOut, available } } — only populated when Amber actually returns a postal code
        soldOutProperties: [], // full (uncapped-per-city) list of sold-out items, capped overall at SOLD_OUT_PROPERTIES_CAP — the source for postcode/property-level daily-snapshot reporting
        startedAt: Date.now(),
        updatedAt: Date.now(),
    };
}

async function loadCrawlState() {
    const state = await sharedGet(CRAWL_KEY);
    return state || freshCrawlState();
}

// Same graceful-degradation philosophy as amberGateway.js's
// staleOnRedisFailure: a Redis blip mid-request must never surface as a hard
// failure of the whole /insight dashboard. Unlike Amber's cache (which has a
// stale copy to fall back to), the crawl state has no per-request fallback
// but zero/fresh — so a Redis outage here temporarily narrows the
// country/city/property breakdown to whatever this one response manages to
// (re)fetch, rather than 503ing the entire dashboard. The authoritative
// headline KPIs (siteWide, from getInventoryStats) are unaffected either way
// — see buildFullBreakdown's own comment on why those never depend on this
// crawl state.
async function safeLoadCrawlState() {
    try {
        return await loadCrawlState();
    } catch (err) {
        if (!(err instanceof RedisUnavailableError)) throw err;
        log(`[insightsMarket] action=CRAWL_STATE_LOAD_FAILED_REDIS_UNAVAILABLE error=${err.message}`);
        return freshCrawlState();
    }
}

async function saveCrawlState(state) {
    state.updatedAt = Date.now();
    await sharedSet(CRAWL_KEY, state, CRAWL_TTL_SECONDS);
}

function bucketItem(state, raw, available) {
    const item = normalizeItem(raw, available);
    if (!item) return;
    const { country, locality: city, pincode } = item;

    if (!state.countries[country]) state.countries[country] = { soldOut: 0, available: 0, cities: {} };
    const countryBucket = state.countries[country];
    if (available) countryBucket.available += 1;
    else countryBucket.soldOut += 1;

    if (!countryBucket.cities[city]) {
        countryBucket.cities[city] = { soldOut: 0, available: 0, priceSum: 0, priceCount: 0, priceMin: null, priceMax: null, currency: null, samples: [] };
    }
    const cityBucket = countryBucket.cities[city];
    if (available) cityBucket.available += 1;
    else cityBucket.soldOut += 1;

    if (Number.isFinite(item.minPrice)) {
        cityBucket.priceSum += item.minPrice;
        cityBucket.priceCount += 1;
        cityBucket.priceMin = cityBucket.priceMin == null ? item.minPrice : Math.min(cityBucket.priceMin, item.minPrice);
        cityBucket.priceMax = cityBucket.priceMax == null ? item.minPrice : Math.max(cityBucket.priceMax, item.minPrice);
    }
    if (!cityBucket.currency && item.currency) cityBucket.currency = item.currency;
    // At most 4 sample properties kept per city — enough for a
    // representative preview in the drilldown table, never the full list.
    if (cityBucket.samples.length < 4) {
        cityBucket.samples.push({
            id: item.id,
            slug: item.slug,
            name: item.name,
            country,
            city,
            locality: city,
            pincode: item.pincode,
            available,
            minPrice: item.minPrice,
            currency: item.currency,
        });
    }

    // Postcode-level bucketing — only when Amber actually returned one.
    // Many listings have no postal_code at all; a bucket keyed on null would
    // just be noise, not a real postcode breakdown, so those are skipped.
    if (pincode) {
        if (!state.postcodes) state.postcodes = {};
        if (!state.postcodes[pincode]) {
            state.postcodes[pincode] = { postcode: pincode, city, country, soldOut: 0, available: 0 };
        }
        if (available) state.postcodes[pincode].available += 1;
        else state.postcodes[pincode].soldOut += 1;
    }

    // Full sold-out property record (not sampled) — this is exactly what
    // sold-out market intelligence needs to report on. Capped defensively so
    // the shared-store value can never grow unbounded.
    if (!available) {
        if (!state.soldOutProperties) state.soldOutProperties = [];
        if (state.soldOutProperties.length < SOLD_OUT_PROPERTIES_CAP) {
            state.soldOutProperties.push({
                id: item.id,
                slug: item.slug,
                name: item.name,
                country,
                city,
                locality: city,
                pincode: item.pincode,
                available: false,
                minPrice: item.minPrice,
                currency: item.currency,
            });
        }
    }
}

// Writes every item this crawl page fetched into the SAME AccommodationResidence
// mirror api/amber.js's index-on-read hook and the Student Planner already
// populate/query (api/_lib/accommodationIndex.js). This is what makes the
// global search index (api/_lib/searchIndex.js) eventually cover Amber's
// ENTIRE catalog rather than only properties a real user has opened —
// reusing this cron-driven, already-budget-safe crawl (see this file's
// header) means ZERO additional Amber traffic: this crawl fetches every one
// of these items on its existing schedule regardless of whether search
// indexing exists at all. Never allowed to slow down or fail the crawl
// itself — Mongo being unconfigured or briefly unreachable just leaves this
// page's items un-indexed until the crawl's next pass revisits them.
async function persistCrawlItemsToSearchIndex(items) {
    if (!items.length) return;
    try {
        await connectToDatabase();
    } catch (err) {
        return; // not configured, or briefly unreachable — search index just stays as-is
    }
    try {
        const mapped = items
            .map((raw) => mapAmberItemToResidence(raw, normalizeCityName(raw?.location?.locality?.long_name)))
            .filter((doc) => doc && doc.city);
        if (mapped.length) await persistResidencesRaw(mapped);
    } catch (err) {
        // Best-effort — a search-index write failure must never break the crawl.
    }
}

// Advances one side of the crawl (sold-out or available) by up to
// `callBudget` real page fetches. Stops early (leaving `done: false`) on any
// error/skip so the next advance call just resumes from the same page — a
// busy/cooled-down Amber never loses crawl progress, it just pauses it.
async function advanceCrawlSide(state, sideKey, availableFlag, callBudget) {
    const side = state[sideKey];
    let callsUsed = 0;
    while (callsUsed < callBudget && !side.done) {
        let result;
        try {
            result = await fetchListings({ page: side.nextPage, limit: PAGE_LIMIT, available: availableFlag }, "LOW", `insights-market-crawl-${sideKey}`);
        } catch {
            break; // budget exhausted, cooldown, lock busy, upstream error — resume next advance
        }
        callsUsed += 1;
        const json = result?.data;
        if (!json) break; // gateway deliberately skipped (LOW priority, budget tight) — resume next advance

        const items = extractResultArray(json);
        const metaCount = Number.isFinite(json?.data?.meta?.count) ? json.data.meta.count : null;
        if (side.expectedTotal == null && metaCount != null) side.expectedTotal = metaCount;
        // Amber's own pagination cursor: null once `current_page` is past its
        // last real page. Distinct from `items.length === 0` (which can also
        // mean a transient blip on a page that isn't actually the end) — this
        // is Amber explicitly saying "there is nothing after this."
        const noMorePages = json?.data?.meta?.next === null;

        for (const raw of items) bucketItem(state, raw, availableFlag);
        await persistCrawlItemsToSearchIndex(items);
        side.fetchedCount += items.length;

        // Once Amber has told us the real total (meta.count, captured above —
        // present on essentially every response, even an anomalous one), that
        // count is authoritative for "are we done," not "did this particular
        // page come back empty." A page can legitimately come back empty for
        // reasons that have nothing to do with having reached the end (a
        // transient upstream hiccup, a momentarily bad cache entry) — trusting
        // `items.length === 0` unconditionally let exactly that happen once:
        // page 1 of the sold-out side came back empty while expectedTotal was
        // very much nonzero, and the crawl latched `done: true` with
        // fetchedCount stuck at 0 — a "complete" snapshot that silently
        // reported zero sold-out inventory across every city. Only fall back
        // to the empty-page heuristic when we have no count to trust yet.
        if (side.expectedTotal != null) {
            side.done = side.fetchedCount >= side.expectedTotal;
        } else if (items.length === 0) {
            side.done = true;
        }
        // `expectedTotal` is a snapshot from whichever page happened to be
        // fetched first — on this resumable, rate-limited crawl that can be
        // days before the last page is reached, and Amber's real inventory
        // count drifts during that window (properties sell out / relist).
        // Confirmed live: a stale expectedTotal that's now a few items higher
        // than what's actually left made the crawl retry the same
        // past-the-end page forever, never reaching `done`. Amber's own
        // cursor (`noMorePages`, checked regardless of items.length) is
        // always current, so it overrides a stale count instead of the crawl
        // waiting on inventory that no longer exists.
        if (!side.done && noMorePages) side.done = true;

        // Don't advance past a page that came back suspiciously empty while
        // we know there's more to find (expectedTotal not yet reached) — retry
        // the same page next tick instead of silently skipping it forever.
        if (items.length > 0 || side.done) {
            side.nextPage += 1;
        }
    }
    return callsUsed;
}

// Advances both sides of the crawl by a combined total of at most
// PAGES_PER_ADVANCE page fetches this call — never more, regardless of how
// many callers invoke this concurrently, since PAGES_PER_ADVANCE itself
// already equals the shared per-minute budget and fetchListings enforces
// that budget centrally besides. Lock-protected so two concurrent requests
// (e.g. a manual refresh landing mid-background-poll) advance the crawl
// once, not twice.
async function advanceCrawl() {
    // A Redis blip on the lock acquire itself (not "lock held by someone
    // else" — a genuine timeout/outage) previously threw straight out of
    // this function as an uncaught RedisUnavailableError, 503ing the whole
    // /insight dashboard. Same degrade as the lock-busy branch below: serve
    // whatever's currently loadable rather than fail the request.
    let lockToken;
    try {
        lockToken = await acquireLock(CRAWL_LOCK_KEY, CRAWL_LOCK_TTL_MS);
    } catch (err) {
        if (!(err instanceof RedisUnavailableError)) throw err;
        log(`[insightsMarket] action=CRAWL_LOCK_ACQUIRE_FAILED_REDIS_UNAVAILABLE error=${err.message}`);
        return safeLoadCrawlState();
    }
    if (!lockToken) {
        // Someone else is already advancing the crawl right now — just
        // return whatever's currently persisted rather than double-fetching.
        return safeLoadCrawlState();
    }
    try {
        const state = await safeLoadCrawlState();
        if (state.soldOut.done && state.available.done) {
            // Nothing left to fetch, but still keep the lightweight
            // search-facing summaries (see LOCATION_INDEX_KEY/SEARCH_DATA_KEY
            // above) fresh on every tick — cheap (no Amber call, just
            // re-deriving from state already in hand, plus one Mongo
            // aggregate for universities) and is what lets a newly-deployed
            // reader of these summaries see real data within one cron tick
            // instead of waiting up to CRAWL_TTL_SECONDS for the crawl to restart.
            await saveLocationIndex(state);
            await saveSearchData(state);
            return state;
        }

        const usedSoldOut = await advanceCrawlSide(state, "soldOut", false, Math.ceil(PAGES_PER_ADVANCE / 2));
        const usedAvailable = await advanceCrawlSide(state, "available", true, PAGES_PER_ADVANCE - usedSoldOut);
        if (usedSoldOut + usedAvailable > 0) {
            try {
                await saveCrawlState(state);
            } catch (err) {
                if (!(err instanceof RedisUnavailableError)) throw err;
                // We have a perfectly good in-memory state with real,
                // freshly-fetched pages in hand — Redis merely failed to
                // *persist* it for the next call. Still return it to this
                // request; the next advance just re-fetches these same pages.
                log(`[insightsMarket] action=CRAWL_STATE_SAVE_FAILED_REDIS_UNAVAILABLE error=${err.message}`);
            }
            await saveLocationIndex(state);
            await saveSearchData(state);
        }
        return state;
    } finally {
        await releaseLock(CRAWL_LOCK_KEY, lockToken);
    }
}

function computeMedian(sortedNums) {
    if (!sortedNums.length) return null;
    const mid = Math.floor(sortedNums.length / 2);
    if (sortedNums.length % 2 === 0) return Math.round((sortedNums[mid - 1] + sortedNums[mid]) / 2);
    return sortedNums[mid];
}

// Builds the full market intelligence payload from an already-loaded crawl
// state — a pure function so it can be reused by the live /api/insights/market
// endpoint (called every request, no extra Amber cost) and by the daily
// digest job (which calls it once after topping up the crawl). `country`/
// `city` filter the already-accumulated aggregate — they never change what's
// crawled (the crawl always covers the whole catalog, which is what makes
// the totals reconcile), only what's returned.
//
// Returns a superset of the original /api/insights/market shape
// ({siteWide, crawlProgress, coverage, cities}) plus countries[]/postcodes[]/
// properties[]/pricing{} — existing consumers of the original fields are
// unaffected by the additions.
function buildFullBreakdown(state, siteWide, { country, city } = {}) {
    const countryFilter = resolveCountryFilter(country);
    const cities = [];
    const countryTotals = {};
    let totalSoldOut = 0;
    let totalAvailable = 0;

    for (const [countryName, countryBucket] of Object.entries(state.countries)) {
        if (countryFilter && countryName !== countryFilter) continue;
        let countrySoldOut = 0;
        let countryAvailable = 0;
        for (const [cityName, cityBucket] of Object.entries(countryBucket.cities)) {
            if (city && cityName !== city) continue;
            const total = cityBucket.soldOut + cityBucket.available;
            totalSoldOut += cityBucket.soldOut;
            totalAvailable += cityBucket.available;
            countrySoldOut += cityBucket.soldOut;
            countryAvailable += cityBucket.available;
            cities.push({
                city: cityName,
                country: countryName,
                cached: true,
                total,
                soldOut: cityBucket.soldOut,
                available: cityBucket.available,
                soldOutRate: total ? cityBucket.soldOut / total : null,
                avgAskingPrice: cityBucket.priceCount ? Math.round(cityBucket.priceSum / cityBucket.priceCount) : null,
                minAskingPrice: cityBucket.priceMin,
                maxAskingPrice: cityBucket.priceMax,
                currency: cityBucket.currency,
                properties: cityBucket.samples,
            });
        }
        if (countrySoldOut + countryAvailable > 0) countryTotals[countryName] = { soldOut: countrySoldOut, available: countryAvailable };
    }
    cities.sort((a, b) => b.soldOut - a.soldOut);

    // Countries ranked by sold-out count, with each one's share of the
    // total sold-out inventory (never an invented percentage).
    const countries = Object.entries(countryTotals)
        .map(([name, t]) => ({
            country: name,
            soldOut: t.soldOut,
            available: t.available,
            total: t.soldOut + t.available,
            soldOutShare: totalSoldOut ? t.soldOut / totalSoldOut : null,
        }))
        .sort((a, b) => b.soldOut - a.soldOut)
        .map((c, i) => ({ ...c, rank: i + 1 }));

    // Postcodes ranked by sold-out count — only real postal-code data,
    // capped to the top 100 (a management dashboard table, not a full dump).
    const postcodes = Object.values(state.postcodes || {})
        .filter((p) => (!countryFilter || p.country === countryFilter) && (!city || p.city === city))
        .sort((a, b) => b.soldOut - a.soldOut)
        .slice(0, 100)
        .map((p, i) => ({
            postcode: p.postcode,
            city: p.city,
            country: p.country,
            soldOut: p.soldOut,
            available: p.available,
            total: p.soldOut + p.available,
            soldOutShare: totalSoldOut ? p.soldOut / totalSoldOut : null,
            rank: i + 1,
        }));

    // Full sold-out property list (source of truth for the Property
    // Intelligence / "strongest sold-out presence" section), filtered the
    // same way as everything else above.
    const properties = (state.soldOutProperties || [])
        .filter((p) => (!countryFilter || p.country === countryFilter) && (!city || p.city === city))
        .sort((a, b) => (b.minPrice ?? -1) - (a.minPrice ?? -1));

    // Pricing intelligence — average/median/min/max ASKING price of
    // sold-out inventory, computed only over items with real price data
    // (missing price is excluded, never treated as zero). Deliberately
    // scoped to sold-out inventory (not the general cached-property sample
    // the existing Pricing tab uses) since that's what this system reports
    // on; the dashboard labels this distinctly from the existing tab.
    const pricedValues = properties.filter((p) => Number.isFinite(p.minPrice)).map((p) => p.minPrice);
    const sortedPrices = [...pricedValues].sort((a, b) => a - b);
    const pricing = {
        sampleSize: pricedValues.length,
        currency: properties.find((p) => p.currency)?.currency || null,
        average: pricedValues.length ? Math.round(pricedValues.reduce((s, v) => s + v, 0) / pricedValues.length) : null,
        median: computeMedian(sortedPrices),
        min: pricedValues.length ? sortedPrices[0] : null,
        max: pricedValues.length ? sortedPrices[sortedPrices.length - 1] : null,
    };

    const complete = state.soldOut.done && state.available.done;
    return {
        siteWide,
        crawlProgress: {
            soldOutFetched: state.soldOut.fetchedCount,
            soldOutExpected: state.soldOut.expectedTotal,
            availableFetched: state.available.fetchedCount,
            availableExpected: state.available.expectedTotal,
            complete,
        },
        // Kept for the frontend's existing "coverage" copy — reports real
        // crawl progress (properties counted so far), not a curated list's.
        coverage: {
            citiesWithData: cities.length,
            totalCities: cities.length,
            itemsCounted: totalSoldOut + totalAvailable,
            itemsExpected:
                state.soldOut.expectedTotal != null && state.available.expectedTotal != null
                    ? state.soldOut.expectedTotal + state.available.expectedTotal
                    : null,
        },
        cities,
        countries,
        postcodes,
        properties,
        pricing,
        // Items the breakdown crawl has counted SO FAR — correct as the
        // denominator for the country/city/postcode share-of-counted-so-far
        // percentages above (which are inherently crawl-progress-relative),
        // but NOT the same thing as the site's real total, especially while
        // crawlProgress.complete is false.
        totalSoldOut,
        totalAvailable,
        // Authoritative headline figures — reconciled with the homepage's
        // own Sold Out counter. siteWide.total/soldOut/remaining come from
        // getInventoryStats()'s two lightweight COUNT-only Amber requests
        // (exact, not a page-by-page crawl), so these are correct
        // immediately, even on the very first request before the breakdown
        // crawl has counted more than a page or two. Only fall back to the
        // crawl's own running total in the rare case siteWide itself
        // couldn't be fetched this request (shared budget momentarily
        // exhausted) — see api/_lib/inventoryStats.js's `ready` contract.
        totalInventory: siteWide?.ready ? siteWide.total : totalSoldOut + totalAvailable,
        soldOutInventory: siteWide?.ready ? siteWide.soldOut : totalSoldOut,
        availableInventory: siteWide?.ready ? siteWide.remaining : totalAvailable,
        soldOutPercentage: (() => {
            const total = siteWide?.ready ? siteWide.total : totalSoldOut + totalAvailable;
            const soldOut = siteWide?.ready ? siteWide.soldOut : totalSoldOut;
            return total ? Math.round((soldOut / total) * 1000) / 10 : null;
        })(),
    };
}

// Builds the full market intelligence payload for /api/insights/market —
// advances the crawl by one budget window, then delegates to the pure
// buildFullBreakdown() above.
async function getMarketIntelligence({ country, city } = {}) {
    const state = await advanceCrawl();
    const siteWide = await getInventoryStats();
    return buildFullBreakdown(state, siteWide, { country, city });
}

// Re-filters an ALREADY-BUILT flat breakdown by country/city — the
// {cities, countries, postcodes, properties} shape buildFullBreakdown()
// returns above, which api/_lib/models/InsightSnapshot.js stores verbatim.
// A stored historical snapshot is a frozen document with every real
// country/city/postcode/property already broken out (not a curated list),
// so narrowing it to one country/city is pure in-memory array work — no
// Amber call, which is the whole reason a snapshot is stored in the first
// place. api/insights/snapshot.js calls this for date < today so the
// country/city dropdowns work on historical dates the same way they do live,
// instead of the filters being silently dropped for every date but today.
// totalSoldOut/totalAvailable and countries[]/postcodes[]' soldOutShare/rank
// are recomputed from the filtered subset (mirrors buildFullBreakdown's own
// derivation) so a filtered view's percentages/ranks stay internally
// consistent rather than referencing the unfiltered total. The absolute
// siteWide-derived headline figures (totalInventory/soldOutInventory/
// soldOutPercentage) are deliberately left untouched — same as live mode,
// where those are the site-wide reconciled totals, not a filter-scoped
// count (see buildFullBreakdown's own comment on that field).
function filterBreakdown(breakdown, { country, city } = {}) {
    const countryFilter = resolveCountryFilter(country);
    if (!countryFilter && !city) return breakdown;

    const matches = (row) => (!countryFilter || row.country === countryFilter) && (!city || row.city === city);
    const cities = (breakdown.cities || []).filter(matches);
    const properties = (breakdown.properties || []).filter(matches);

    let totalSoldOut = 0;
    let totalAvailable = 0;
    const countryTotals = {};
    for (const c of cities) {
        totalSoldOut += c.soldOut || 0;
        totalAvailable += c.available || 0;
        const t = countryTotals[c.country] || { soldOut: 0, available: 0 };
        t.soldOut += c.soldOut || 0;
        t.available += c.available || 0;
        countryTotals[c.country] = t;
    }

    const countries = Object.entries(countryTotals)
        .map(([name, t]) => ({
            country: name,
            soldOut: t.soldOut,
            available: t.available,
            total: t.soldOut + t.available,
            soldOutShare: totalSoldOut ? t.soldOut / totalSoldOut : null,
        }))
        .sort((a, b) => b.soldOut - a.soldOut)
        .map((c, i) => ({ ...c, rank: i + 1 }));

    const postcodes = (breakdown.postcodes || [])
        .filter(matches)
        .sort((a, b) => b.soldOut - a.soldOut)
        .map((p, i) => ({ ...p, soldOutShare: totalSoldOut ? p.soldOut / totalSoldOut : null, rank: i + 1 }));

    // Same derivation buildFullBreakdown() uses, over the now-filtered
    // `properties` — audit gap fix: this function originally left `pricing`
    // untouched, so a filtered historical view (e.g. country=UK) still
    // showed the average/median/min/max SOLD-OUT asking price across the
    // ENTIRE unfiltered snapshot while every other number on screen was
    // correctly narrowed. Sold-out-only scope matches buildFullBreakdown's
    // own documented intent, not a new decision made here.
    const pricedValues = properties.filter((p) => Number.isFinite(p.minPrice)).map((p) => p.minPrice);
    const sortedPrices = [...pricedValues].sort((a, b) => a - b);
    const pricing = {
        sampleSize: pricedValues.length,
        currency: properties.find((p) => p.currency)?.currency || null,
        average: pricedValues.length ? Math.round(pricedValues.reduce((s, v) => s + v, 0) / pricedValues.length) : null,
        median: computeMedian(sortedPrices),
        min: pricedValues.length ? sortedPrices[0] : null,
        max: pricedValues.length ? sortedPrices[sortedPrices.length - 1] : null,
    };

    return {
        ...breakdown,
        cities,
        countries,
        postcodes,
        properties,
        pricing,
        totalSoldOut,
        totalAvailable,
        coverage: breakdown.coverage
            ? { ...breakdown.coverage, citiesWithData: cities.length, totalCities: cities.length, itemsCounted: totalSoldOut + totalAvailable }
            : breakdown.coverage,
    };
}

module.exports = {
    getMarketIntelligence, buildFullBreakdown, loadCrawlState, advanceCrawl,
    // Exported for api/insights/snapshot.js — applies the same country/city
    // filtering to a stored historical snapshot's already-flat breakdown
    // (see filterBreakdown's own comment above for why no Amber call is
    // needed to do this).
    filterBreakdown, resolveCountryFilter,
    // Exported for api/_lib/searchIndex.js's comprehensive country/city
    // search — see LOCATION_INDEX_KEY's own comment for why this is a
    // separate, much smaller artifact than loadCrawlState()'s full blob.
    loadLocationIndex, buildLocationIndex, saveLocationIndex,
    // Exported for api/search-data.js — the complete countries/cities/
    // universities dataset the Global Search's client-side index loads once
    // (see SEARCH_DATA_KEY's own comment).
    loadSearchData, buildSearchData, saveSearchData,
    // Exported for api/amber.js's indexOnRead — grows the same search
    // dataset from real traffic between crawl passes (see its own header).
    growSearchDataFromRealTraffic,
};
