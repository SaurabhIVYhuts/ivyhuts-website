#!/usr/bin/env node
// University Housing — city / country search verification.
//
// Covers the backend half of the universal (university / city / country)
// search: location-intent resolution (api/_lib/locationResolver.js +
// resolveHousingSearch/resolveGoogleMapsCandidate in
// universityResolveService.js), the city/country canonical-inventory
// queries (accommodationIndex.js getCountryListingsPage,
// accommodationInventoryService.js getCitySearchInventory) and the
// /api/university-housing/inventory route's type=city|country branch.
// The page-level behaviour (map/cards sharing one result set, stale
// searches, empty vs error states) is covered by
// src/components/universityHousing/AccommodationSearchExperience.test.js.
//
// SAFETY / DETERMINISM: no real Mongo, Redis or Amber. AccommodationResidence/
// AccommodationIndexMeta statics are replaced with an in-memory fixture store
// that evaluates the real query objects these functions build ($or/$in/null
// equality, sort/skip/limit), Redis env vars are removed (sharedStore's
// in-memory fallback), and global.fetch counts every outbound call — the
// Amber-safety assertions require that count to stay at zero.
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const LIB = path.join(ROOT, "api", "_lib");

for (const k of ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_URL", "KV_REST_API_TOKEN"]) delete process.env[k];

let passed = 0;
let failed = 0;
const failures = [];
async function test(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  PASS  ${name}`);
    } catch (err) {
        failed++;
        failures.push({ name, message: err.message });
        console.log(`  FAIL  ${name}\n        ${err.stack || err.message}`);
    }
}

// ── outbound network counter (must stay at zero) ──
const fetchCalls = [];
global.fetch = async (url) => {
    fetchCalls.push(String(url));
    throw new Error(`unexpected network call in test: ${url}`);
};

// ── in-memory Mongo stand-in ──
let docs = [];
let nextId = 1;
let failReads = false;
function fixture(propertyId, city, country, overrides = {}) {
    return {
        _id: nextId++,
        source: "amber",
        propertyId: String(propertyId),
        slug: `slug-${propertyId}`,
        propertyName: `Property ${propertyId}`,
        city,
        country,
        latitude: 53.47,
        longitude: -2.24,
        price: { amount: 200, currency: "£" },
        priceDuration: "week",
        priceWeekly: 200,
        available: true,
        roomTypes: ["Studio"],
        amenities: [],
        badges: [],
        nearbyUniversities: [],
        nearbyPlaces: [],
        ...overrides,
    };
}
function matchValue(docValue, cond) {
    if (cond && typeof cond === "object" && !Array.isArray(cond) && "$in" in cond) return cond.$in.includes(docValue);
    if (cond === null) return docValue === null || docValue === undefined;
    return docValue === cond;
}
function matches(doc, query) {
    return Object.entries(query).every(([key, cond]) => {
        if (key === "$or") return cond.some((q) => matches(doc, q));
        return matchValue(doc[key], cond);
    });
}
const queryLog = [];
function makeCursor(query) {
    queryLog.push(query);
    let sortSpec = null;
    let skipN = 0;
    let limitN = Infinity;
    const cursor = {
        sort(spec) { sortSpec = spec; return cursor; },
        skip(n) { skipN = n; return cursor; },
        limit(n) { limitN = n; return cursor; },
        async lean() {
            if (failReads) throw new Error("simulated Mongo read failure");
            let out = docs.filter((d) => matches(d, query)).map((d) => ({ ...d }));
            if (sortSpec) {
                const keys = Object.entries(sortSpec);
                out.sort((a, b) => {
                    for (const [k, dir] of keys) {
                        const av = a[k] === true ? 1 : a[k] === false ? 0 : a[k];
                        const bv = b[k] === true ? 1 : b[k] === false ? 0 : b[k];
                        if (av < bv) return -dir;
                        if (av > bv) return dir;
                    }
                    return 0;
                });
            }
            return out.slice(skipN, skipN + limitN);
        },
    };
    return cursor;
}

const mongodb = require(path.join(LIB, "mongodb.js"));
mongodb.connectToDatabase = async () => {};
const AccommodationResidence = require(path.join(LIB, "models", "AccommodationResidence.js"));
const AccommodationIndexMeta = require(path.join(LIB, "models", "AccommodationIndexMeta.js"));
AccommodationResidence.find = (query) => makeCursor(query);
AccommodationResidence.countDocuments = async (query) => {
    if (failReads) throw new Error("simulated Mongo read failure");
    return docs.filter((d) => matches(d, query)).length;
};
// Every city is FRESH, so getCityListings never attempts a refresh.
AccommodationIndexMeta.findOne = (query) => ({ lean: async () => ({ city: query.city, status: "ok", lastRefreshedAt: new Date() }) });

const sharedStore = require(path.join(LIB, "sharedStore.js"));
const accommodationIndex = require(path.join(LIB, "accommodationIndex.js"));
const inventoryService = require(path.join(LIB, "accommodationInventoryService.js"));
const locationResolver = require(path.join(LIB, "locationResolver.js"));
const resolveService = require(path.join(LIB, "universityResolveService.js"));
const inventoryRoute = require(path.join(LIB, "routes", "content", "university-housing", "inventory.js"));
const resolveRoute = require(path.join(LIB, "routes", "crm-tools", "universities-resolve.js"));

function seedInventory() {
    nextId = 1;
    docs = [
        // UK — Manchester: one central, one with NO coordinates, one ~30km out
        // (outside any university radius but still in the city).
        fixture("m1", "manchester", "United Kingdom"),
        fixture("m2", "manchester", "United Kingdom", { latitude: null, longitude: null }),
        fixture("m3", "manchester", "United Kingdom", { latitude: 53.72, longitude: -2.6, available: false }),
        fixture("s1", "salford", "United Kingdom", { latitude: 53.48, longitude: -2.29 }),
        fixture("l1", "london", "United Kingdom", { latitude: 51.5, longitude: -0.12 }),
        fixture("l2", "london", "United Kingdom", { latitude: 51.52, longitude: -0.1 }),
        // country never captured: included only via its curated UK city
        fixture("e1", "edinburgh", null, { latitude: 55.95, longitude: -3.19 }),
        // a real UK city NOT in the curated destinations list
        fixture("y1", "york", "United Kingdom", { latitude: 53.96, longitude: -1.08 }),
        // same city name, different country
        fixture("lc1", "london", "Canada", { latitude: 42.98, longitude: -81.25 }),
        fixture("b1", "berlin", "Germany", { latitude: 52.52, longitude: 13.4 }),
        fixture("b2", "berlin", "Germany", { latitude: 52.5, longitude: 13.38 }),
        fixture("mu1", "munich", "Germany", { latitude: 48.14, longitude: 11.58 }),
        fixture("ha1", "hamburg", "Germany", { latitude: null, longitude: null }),
    ];
}

function mockRes() {
    const res = { statusCode: 200, headers: {}, body: undefined };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    res.setHeader = (k, v) => { res.headers[k] = v; };
    res.end = () => res;
    return res;
}
async function callInventory(query) {
    const res = mockRes();
    await inventoryRoute({ method: "GET", query, headers: {} }, res);
    return res;
}
const ids = (list) => list.map((d) => d.propertyId).sort();

async function main() {
    console.log("=== University Housing — city / country search verification ===\n");
    const quiet = console.log;

    // ══════════════ RESOLUTION ══════════════
    await sharedStore.sharedSet(locationResolver.LOCATION_INDEX_KEY, {
        countries: [{ name: "United Kingdom", cityCount: 30 }, { name: "Canada", cityCount: 5 }, { name: "United States", cityCount: 20 }],
        cities: [
            { name: "York", country: "United Kingdom" },
            { name: "London", country: "Canada" },
            { name: "Springfield", country: "United States" },
            { name: "Springfield", country: "Canada" },
        ],
    }, 300);
    locationResolver._resetLocationIndexCache();

    await test("CITY: 'Manchester' resolves to a CITY record with its country, no coordinates, not a university", async () => {
        const r = await resolveService.resolveHousingSearch("Manchester");
        assert.strictEqual(r.status, "resolved");
        assert.strictEqual(r.record.type, "CITY");
        assert.strictEqual(r.record.city, "Manchester");
        assert.strictEqual(r.record.country, "United Kingdom");
        assert.strictEqual(r.record.latitude, null);
        assert.strictEqual(r.record.longitude, null);
    });

    await test("CITY: case, whitespace, punctuation and hyphen variants resolve to the same city identity", async () => {
        const base = (await resolveService.resolveHousingSearch("Newcastle Upon Tyne")).record.id;
        for (const q of ["  newcastle upon tyne ", "NEWCASTLE-UPON-TYNE", "Newcastle  upon   Tyne"]) {
            const r = await resolveService.resolveHousingSearch(q);
            assert.strictEqual(r.status, "resolved", q);
            assert.strictEqual(r.record.id, base, q);
        }
        assert.strictEqual((await resolveService.resolveHousingSearch(" MANCHESTER ")).record.id, (await resolveService.resolveHousingSearch("Manchester")).record.id);
    });

    await test("CITY: a crawl-only (uncurated) real city still resolves", async () => {
        const r = await resolveService.resolveHousingSearch("york");
        assert.strictEqual(r.status, "resolved");
        assert.deepStrictEqual([r.record.type, r.record.city, r.record.country], ["CITY", "York", "United Kingdom"]);
    });

    await test("CITY: same city name in different countries is never mixed — curated market wins, explicit qualifier selects the other, otherwise ambiguous", async () => {
        const london = await resolveService.resolveHousingSearch("London");
        assert.strictEqual(london.record.country, "United Kingdom", "curated London (UK) is the single curated match");
        const londonCa = await resolveService.resolveHousingSearch("London, Canada");
        assert.deepStrictEqual([londonCa.record.type, londonCa.record.city, londonCa.record.country], ["CITY", "London", "Canada"]);
        const springfield = await resolveService.resolveHousingSearch("Springfield");
        assert.strictEqual(springfield.status, "ambiguous");
        assert.deepStrictEqual(springfield.candidates.map((c) => c.country).sort(), ["Canada", "United States"]);
        assert.ok(springfield.candidates.every((c) => c.type === "CITY"));
    });

    await test("COUNTRY: code, full name, alias and casing all resolve to the same COUNTRY record — never its capital", async () => {
        for (const q of ["UK", "uk", "U.K.", "United Kingdom", "united kingdom", "Great Britain"]) {
            const r = await resolveService.resolveHousingSearch(q);
            assert.strictEqual(r.status, "resolved", q);
            assert.strictEqual(r.record.type, "COUNTRY", q);
            assert.strictEqual(r.record.country, "United Kingdom", q);
            assert.strictEqual(r.record.city, null, `${q} must not become a capital-city search`);
        }
    });

    await test("COUNTRY: a nation inside a country ('England') is NOT promoted to the whole United Kingdom", async () => {
        assert.strictEqual(await locationResolver.resolveLocationQuery("England"), null);
    });

    await test("UNIVERSITY: an exact curated university still resolves as a university (Tier 1 wins over location intent)", async () => {
        const r = await resolveService.resolveHousingSearch("University of Manchester");
        assert.strictEqual(r.status, "resolved");
        assert.strictEqual(r.record.type, "UNIVERSITY");
        assert.ok(Number.isFinite(r.record.latitude) && Number.isFinite(r.record.longitude));
    });

    await test("UNIVERSITY: a partial match containing a city name is never swallowed as that city", async () => {
        assert.strictEqual(await locationResolver.resolveLocationQuery("Manchester Metropolitan University"), null);
        assert.strictEqual(await locationResolver.resolveLocationQuery("Manchester Business"), null);
    });

    await test("OPT-IN: resolveUniversity() (CRM/assistant callers) is unchanged and never returns a CITY/COUNTRY record", () => {
        const src = fs.readFileSync(path.join(LIB, "universityResolveService.js"), "utf8");
        const body = src.slice(src.indexOf("async function resolveUniversity("), src.indexOf("async function resolveHousingSearch("));
        assert.ok(!/resolveLocationQuery/.test(body), "resolveUniversity must not call the location resolver");
    });

    await test("GOOGLE MAPS: a Maps place named for a city resolves to that CITY (scope=location only)", async () => {
        const res = mockRes();
        await resolveRoute({ method: "GET", query: { q: "https://www.google.com/maps/place/Manchester/@53.4808,-2.2426,12z", scope: "location" }, headers: {} }, res);
        assert.strictEqual(res.body.status, "resolved", JSON.stringify(res.body));
        assert.strictEqual(res.body.data.type, "CITY");
        assert.strictEqual(res.body.data.city, "Manchester");
    });

    await test("GOOGLE MAPS: a Maps place for a curated university still resolves to the university with the coordinate cross-check", async () => {
        const r = await resolveService.resolveGoogleMapsCandidate({ name: "University of Manchester", latitude: 53.4668, longitude: -2.2339 }, { includeLocations: true });
        assert.strictEqual(r.status, "resolved");
        assert.strictEqual(r.record.type, "UNIVERSITY");
    });

    await test("REDIS DOWN: the crawl summary read failing degrades to curated cities/countries — no throw", async () => {
        const original = sharedStore.sharedGet;
        delete require.cache[require.resolve(path.join(LIB, "locationResolver.js"))];
        sharedStore.sharedGet = async () => { throw new Error("simulated Redis outage"); };
        console.log = () => {};
        try {
            const fresh = require(path.join(LIB, "locationResolver.js"));
            const manchester = await fresh.resolveLocationQuery("Manchester");
            assert.strictEqual(manchester.record.type, "CITY");
            assert.strictEqual(await fresh.resolveLocationQuery("Springfield"), null, "crawl-only cities are simply unavailable while Redis is down");
            const uk = await fresh.canonicalizeCountry("united kingdom");
            assert.strictEqual(uk.fullName, "United Kingdom");
        } finally {
            console.log = quiet;
            sharedStore.sharedGet = original;
        }
    });

    // ══════════════ INVENTORY ══════════════
    seedInventory();

    await test("UNIVERSITY MODE (no type): unchanged — Manchester university search still includes its verified market area (Salford)", async () => {
        const res = await callInventory({ city: "Manchester" });
        assert.strictEqual(res.statusCode, 200);
        assert.deepStrictEqual(ids(res.body.residences), ["m1", "m2", "m3", "s1"]);
        assert.strictEqual(res.body.locationType, undefined, "university responses keep their original shape");
    });

    await test("CITY: returns every Manchester listing — including one with no coordinates and one far outside any university radius", async () => {
        const res = await callInventory({ type: "city", city: "Manchester", country: "UK" });
        assert.strictEqual(res.statusCode, 200);
        assert.deepStrictEqual(ids(res.body.residences), ["m1", "m2", "m3"], "exactly the city — no Salford market expansion, nothing dropped");
        assert.strictEqual(res.body.total, 3);
        assert.strictEqual(res.body.hasMore, false);
        assert.strictEqual(res.body.locationType, "city");
        assert.strictEqual(res.body.country, "United Kingdom");
    });

    await test("CITY: 'London, United Kingdom' excludes London, Canada (structured country) while keeping rows whose country was never recorded", async () => {
        docs.push(fixture("ln", "london", null));
        try {
            const uk = await callInventory({ type: "city", city: "London", country: "united kingdom" });
            assert.deepStrictEqual(ids(uk.body.residences), ["l1", "l2", "ln"]);
            const ca = await callInventory({ type: "city", city: "London", country: "Canada" });
            assert.deepStrictEqual(ids(ca.body.residences), ["lc1", "ln"]);
        } finally {
            docs = docs.filter((d) => d.propertyId !== "ln");
        }
    });

    await test("COUNTRY: returns properties from multiple UK cities (incl. an uncurated city and a null-country row in a curated UK city) and nothing from Canada/Germany", async () => {
        const res = await callInventory({ type: "country", country: "UK" });
        assert.strictEqual(res.statusCode, 200);
        assert.deepStrictEqual(ids(res.body.residences), ["e1", "l1", "l2", "m1", "m2", "m3", "s1", "y1"]);
        const cities = new Set(res.body.residences.map((d) => d.city));
        assert.ok(cities.size >= 5, "country search must span many cities, not just the capital");
        assert.ok(!res.body.residences.some((d) => d.country === "Canada" || d.country === "Germany"));
        assert.strictEqual(res.body.total, 8);
        assert.strictEqual(res.body.country, "United Kingdom");
    });

    await test("CITY: London (United Kingdom) returns every London listing — multiple rows, none from London, Canada", async () => {
        const res = await callInventory({ type: "city", city: "London", country: "UK" });
        assert.strictEqual(res.statusCode, 200);
        assert.deepStrictEqual(ids(res.body.residences), ["l1", "l2"]);
        assert.ok(!res.body.residences.some((d) => d.country === "Canada"));
    });

    await test("COUNTRY: Germany spans several German cities (not just the capital), including a row without coordinates", async () => {
        const res = await callInventory({ type: "country", country: "Germany" });
        assert.strictEqual(res.statusCode, 200);
        assert.deepStrictEqual(ids(res.body.residences), ["b1", "b2", "ha1", "mu1"]);
        assert.deepStrictEqual(Array.from(new Set(res.body.residences.map((d) => d.city))).sort(), ["berlin", "hamburg", "munich"]);
        assert.strictEqual(res.body.total, 4);
    });

    await test("SCHEMA: the city/country filters use real, indexed AccommodationResidence fields with the stored value format (lowercase city, Amber long-name country)", () => {
        const schema = AccommodationResidence.schema;
        assert.strictEqual(schema.path("city").instance, "String");
        assert.strictEqual(schema.path("country").instance, "String");
        const indexed = schema.indexes().map(([fields]) => Object.keys(fields).join(","));
        assert.ok(indexed.includes("city") && indexed.includes("country"), "both query fields must be indexed");
        // Every writer stores country as Amber's location.country.long_name and city via normalizeCityName.
        const writerSrc = fs.readFileSync(path.join(LIB, "accommodationIndex.js"), "utf8");
        assert.ok(writerSrc.includes("country: raw.location?.country?.long_name || null"));
        assert.ok(/city: normalizedCity,/.test(writerSrc));
        const mapped = accommodationIndex.mapAmberItemToResidence({ id: 7, name: "X", location: { country: { long_name: "Germany" } } }, "munich");
        assert.strictEqual(mapped.country, "Germany");
        assert.strictEqual(mapped.city, "munich");
    });

    await test("COUNTRY: the query uses the structured country field (+ curated-city fallback only for rows with no country)", async () => {
        queryLog.length = 0;
        await inventoryService.getCountrySearchInventoryPage("United Kingdom", { fallbackCityNames: ["London", "Edinburgh"] });
        const q = queryLog[0];
        assert.deepStrictEqual(q, { $or: [{ country: "United Kingdom" }, { country: null, city: { $in: ["london", "edinburgh"] } }] });
    });

    await test("COUNTRY: a country with no inventory is an empty 200 result, not an error", async () => {
        const res = await callInventory({ type: "country", country: "France" });
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.body.ok, true);
        assert.deepStrictEqual(res.body.residences, []);
        assert.strictEqual(res.body.total, 0);
        assert.strictEqual(res.body.hasMore, false);
    });

    await test("PAGINATION: paging a country with limit=3 yields the complete set exactly once, with consistent total/hasMore", async () => {
        const all = [];
        let page = 1;
        let last;
        do {
            // eslint-disable-next-line no-await-in-loop
            last = await callInventory({ type: "country", country: "United Kingdom", page: String(page), limit: "3" });
            assert.strictEqual(last.body.total, 8);
            assert.strictEqual(last.body.page, page);
            all.push(...last.body.residences);
            page++;
        } while (last.body.hasMore && page < 10);
        assert.strictEqual(page - 1, 3, "8 rows at 3 per page = 3 pages");
        assert.strictEqual(all.length, 8);
        assert.strictEqual(new Set(all.map((d) => d.propertyId)).size, 8, "no row repeated across pages");
        assert.strictEqual(all.findIndex((d) => d.available === false), all.length - 1, "available rows are paged first");
    });

    await test("PAGINATION: limit is capped server-side", async () => {
        const r = await accommodationIndex.getCountryListingsPage("United Kingdom", { limit: 100000 });
        assert.strictEqual(r.limit, accommodationIndex.COUNTRY_PAGE_MAX_LIMIT);
    });

    await test("PRICING/AVAILABILITY: canonical rows are returned verbatim — price, duration, weekly price and sold-out flag untouched", async () => {
        const res = await callInventory({ type: "city", city: "Manchester" });
        const m3 = res.body.residences.find((d) => d.propertyId === "m3");
        assert.deepStrictEqual(m3.price, { amount: 200, currency: "£" });
        assert.strictEqual(m3.priceDuration, "week");
        assert.strictEqual(m3.priceWeekly, 200);
        assert.strictEqual(m3.available, false);
    });

    await test("VALIDATION: missing city/country for a typed search is a 400, not an empty result", async () => {
        assert.strictEqual((await callInventory({ type: "city" })).statusCode, 400);
        assert.strictEqual((await callInventory({ type: "country" })).statusCode, 400);
    });

    await test("FAILURE: an inventory read failure is a 502 error response, never a false empty success", async () => {
        failReads = true;
        console.log = () => {};
        try {
            const city = await callInventory({ type: "city", city: "Manchester" });
            const country = await callInventory({ type: "country", country: "UK" });
            for (const res of [city, country]) {
                assert.strictEqual(res.statusCode, 502);
                assert.strictEqual(res.body.ok, false);
                assert.strictEqual(res.body.residences, undefined);
            }
        } finally {
            console.log = quiet;
            failReads = false;
        }
    });

    await test("DATABASE NOT CONFIGURED (the reported '0 properties' bug): city, country and university requests return a 503 error, never a 200 empty result", async () => {
        const originalConnect = mongodb.connectToDatabase;
        const routePath = require.resolve(path.join(LIB, "routes", "content", "university-housing", "inventory.js"));
        delete require.cache[routePath];
        mongodb.connectToDatabase = async () => { throw new mongodb.MongoNotConfiguredError(); };
        console.log = () => {};
        try {
            const route = require(routePath);
            for (const query of [{ type: "city", city: "London", country: "UK" }, { type: "country", country: "Germany" }, { city: "London" }]) {
                const res = mockRes();
                // eslint-disable-next-line no-await-in-loop
                await route({ method: "GET", query, headers: {} }, res);
                assert.strictEqual(res.statusCode, 503, JSON.stringify(query));
                assert.strictEqual(res.body.ok, false);
                assert.strictEqual(res.body.error, "inventory_unavailable");
                assert.strictEqual(res.body.residences, undefined);
            }
        } finally {
            console.log = quiet;
            mongodb.connectToDatabase = originalConnect;
            delete require.cache[routePath];
        }
    });

    await test("AMBER SAFETY: every city/country/university search above made ZERO outbound calls (no Amber, no Redis, no geocoder)", () => {
        assert.deepStrictEqual(fetchCalls, []);
    });

    await test("AMBER SAFETY: the new resolver is isolated like every discovery file — no Amber gateway/index imports", () => {
        const src = fs.readFileSync(path.join(LIB, "locationResolver.js"), "utf8");
        assert.ok(!/require\([^)]*(amberGateway|accommodationIndex|searchIndex|insightsMarket)/.test(src));
        assert.ok(!/amberstudent\.com/.test(src));
        const marketSrc = fs.readFileSync(path.join(LIB, "insightsMarket.js"), "utf8");
        const key = /const LOCATION_INDEX_KEY = "([^"]+)"/.exec(marketSrc)[1];
        assert.strictEqual(locationResolver.LOCATION_INDEX_KEY, key, "must read the crawl's own location-summary key");
    });

    await test("AMBER SAFETY: the country query path is read-only — it never calls attemptCityRefresh/fetchListings", () => {
        const src = fs.readFileSync(path.join(LIB, "accommodationIndex.js"), "utf8");
        const body = src.slice(src.indexOf("async function getCountryListingsPage("), src.indexOf("module.exports"));
        assert.ok(!/attemptCityRefresh|requestBackgroundRefresh|fetchListings|fetchAmber/.test(body));
    });

    console.log(`\n=== ${passed} passed, ${failed} failed ===`);
    if (failed) {
        for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
        process.exitCode = 1;
    }
}

main().catch((err) => {
    console.error("Verification script crashed:", err);
    process.exitCode = 1;
});
