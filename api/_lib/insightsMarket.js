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
const { sharedGet, sharedSet, acquireLock, releaseLock } = require("./sharedStore");
const { fetchListings, RATE_BUDGET_PER_MINUTE } = require("./amberGateway");
const { getInventoryStats } = require("./inventoryStats");

const PAGE_LIMIT = 50; // Amber's own max items per page
const PAGES_PER_ADVANCE = RATE_BUDGET_PER_MINUTE; // at most one full shared budget window's worth of page fetches per call
const CRAWL_KEY = "insights:marketCrawl:v2";
const CRAWL_LOCK_KEY = "insights:marketCrawl:v2:lock";
const CRAWL_LOCK_TTL_MS = 20_000;
// A stale/expired crawl just starts over from page 1 — cheap to redo and
// keeps the breakdown from drifting too far behind real inventory changes.
const CRAWL_TTL_SECONDS = 3 * 60 * 60;

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
        startedAt: Date.now(),
        updatedAt: Date.now(),
    };
}

async function loadCrawlState() {
    const state = await sharedGet(CRAWL_KEY);
    return state || freshCrawlState();
}

async function saveCrawlState(state) {
    state.updatedAt = Date.now();
    await sharedSet(CRAWL_KEY, state, CRAWL_TTL_SECONDS);
}

function bucketItem(state, raw, available) {
    const item = normalizeItem(raw, available);
    if (!item) return;
    const { country, locality: city } = item;

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

        for (const raw of items) bucketItem(state, raw, availableFlag);
        side.fetchedCount += items.length;
        side.nextPage += 1;

        if (items.length === 0 || (side.expectedTotal != null && side.fetchedCount >= side.expectedTotal)) {
            side.done = true;
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
    const lockToken = await acquireLock(CRAWL_LOCK_KEY, CRAWL_LOCK_TTL_MS);
    if (!lockToken) {
        // Someone else is already advancing the crawl right now — just
        // return whatever's currently persisted rather than double-fetching.
        return loadCrawlState();
    }
    try {
        const state = await loadCrawlState();
        if (state.soldOut.done && state.available.done) return state; // nothing left to do

        const usedSoldOut = await advanceCrawlSide(state, "soldOut", false, Math.ceil(PAGES_PER_ADVANCE / 2));
        const usedAvailable = await advanceCrawlSide(state, "available", true, PAGES_PER_ADVANCE - usedSoldOut);
        if (usedSoldOut + usedAvailable > 0) await saveCrawlState(state);
        return state;
    } finally {
        await releaseLock(CRAWL_LOCK_KEY, lockToken);
    }
}

// Builds the full market intelligence payload for /api/insights/market.
// `country`/`city` filter the already-accumulated crawl aggregate — they
// never change what's crawled (the crawl always covers the whole catalog,
// which is what makes the totals reconcile), only what's returned.
async function getMarketIntelligence({ country, city } = {}) {
    const state = await advanceCrawl();
    const siteWide = await getInventoryStats();

    const cities = [];
    let totalSoldOut = 0;
    let totalAvailable = 0;
    for (const [countryName, countryBucket] of Object.entries(state.countries)) {
        if (country && countryName !== country) continue;
        for (const [cityName, cityBucket] of Object.entries(countryBucket.cities)) {
            if (city && cityName !== city) continue;
            const total = cityBucket.soldOut + cityBucket.available;
            totalSoldOut += cityBucket.soldOut;
            totalAvailable += cityBucket.available;
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
    }
    cities.sort((a, b) => b.soldOut - a.soldOut);

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
        // Kept for the frontend's existing "coverage" copy — now reports
        // real crawl progress (properties counted so far) rather than a
        // curated city list's coverage.
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
    };
}

module.exports = { getMarketIntelligence };
