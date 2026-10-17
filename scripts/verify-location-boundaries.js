#!/usr/bin/env node
// University Housing — city / country boundary verification.
//
// Covers api/_lib/boundaryResolver.js and GET /api/location-boundary
// (api/_lib/routes/content/location-boundary.js): candidate selection on
// REAL Nominatim responses (scripts/fixtures/nominatim-boundaries.json —
// London, Manchester, New Zealand, Hong Kong, captured from the live API),
// Polygon/MultiPolygon validation, fit bounds, caching (positive, negative,
// transient), in-flight de-duplication, and isolation from inventory/Amber.
// The map rendering half is covered by
// src/components/universityHousing/UniversityHousingMap.test.js.
//
// SAFETY / DETERMINISM: no real Redis or network. Redis env vars are
// removed (sharedStore's in-memory fallback) and global.fetch serves the
// fixture, counting every call.
//
// Lookups share the real 1 req/s Nominatim rate slot, so this script takes
// several seconds by design.
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

// ── fixture-backed fetch ──
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "nominatim-boundaries.json"), "utf8"));
const overrides = new Map(); // fixture key -> results array | Error
const fetchCalls = [];
function fixtureKey(url) {
    const p = new URL(url).searchParams;
    if (p.get("city")) return `city:${p.get("city")}:${p.get("country")}`;
    if (p.get("country")) return `country:${p.get("country")}`;
    return `q:${p.get("q")}`;
}
global.fetch = async (url, options = {}) => {
    fetchCalls.push({ url: String(url), headers: options.headers || {} });
    const key = fixtureKey(String(url));
    const body = overrides.has(key) ? overrides.get(key) : FIXTURE[key] || [];
    if (body instanceof Error) throw body;
    return { ok: true, status: 200, json: async () => body };
};

const sharedStore = require(path.join(LIB, "sharedStore"));
const boundary = require(path.join(LIB, "boundaryResolver"));
const { NOMINATIM_RATE_KEY } = require(path.join(LIB, "universityDiscovery"));
const handler = require(path.join(LIB, "routes", "content", "location-boundary.js"));
const { resolveLocationBoundary, normalizeGeometry, computeFitBounds, selectCity, CACHE_PREFIX } = boundary;

function partsOf(geometry) {
    return geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
}
function assertValidGeometry(geometry) {
    assert.ok(geometry.type === "Polygon" || geometry.type === "MultiPolygon", `unexpected type ${geometry.type}`);
    for (const poly of partsOf(geometry)) {
        for (const ring of poly) {
            assert.ok(ring.length >= 4, "ring has at least 4 positions");
            assert.deepStrictEqual(ring[0], ring[ring.length - 1], "ring is closed");
            for (const [lng, lat] of ring) assert.ok(Math.abs(lng) <= 180 && Math.abs(lat) <= 90, "position in range");
        }
    }
}
function fakeRes() {
    const res = { statusCode: null, headers: {}, body: null };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
    return res;
}
function reset() {
    boundary._resetBoundaryMemo();
    overrides.clear();
    fetchCalls.length = 0;
}

(async () => {
    console.log("\nboundary selection on real Nominatim data");

    await test("London resolves to Greater London (the city's boundary), not the City of London district", async () => {
        reset();
        const r = await resolveLocationBoundary({ type: "city", city: "London", country: "UK" });
        assert.strictEqual(r.status, "found");
        assert.strictEqual(r.name, "Greater London");
        assert.strictEqual(r.source.osmId, "175342");
        assert.strictEqual(r.geometry.type, "Polygon");
        assertValidGeometry(r.geometry);
        const [[s, w], [n, e]] = r.bounds;
        assert.ok(s < 51.3 && n > 51.68 && w < -0.5 && e > 0.33, `bounds cover Greater London: ${JSON.stringify(r.bounds)}`);
        assert.strictEqual(r.attribution, "© OpenStreetMap contributors (ODbL)");
    });

    await test("Manchester resolves to its administrative relation; the place Point is never used as a boundary", async () => {
        reset();
        const r = await resolveLocationBoundary({ type: "city", city: "Manchester", country: "United Kingdom" });
        assert.strictEqual(r.status, "found");
        assert.strictEqual(r.source.osmType, "relation");
        assert.strictEqual(r.source.osmId, "146656");
        assertValidGeometry(r.geometry);
    });

    await test("New Zealand is a MultiPolygon with every island kept; the fit frame excludes the Chatham Islands across the antimeridian", async () => {
        reset();
        const r = await resolveLocationBoundary({ type: "country", country: "New Zealand" });
        assert.strictEqual(r.status, "found");
        assert.strictEqual(r.geometry.type, "MultiPolygon");
        assert.ok(r.geometry.coordinates.length > 5, "multiple island parts kept");
        assertValidGeometry(r.geometry);
        const hasChatham = r.geometry.coordinates.some((poly) => poly[0].some(([lng]) => lng < -175));
        assert.ok(hasChatham, "the Chatham Islands are still drawn");
        const [[s, w], [, e]] = r.bounds;
        assert.ok(w > 160 && e <= 180 && s < -46, `frame is the NZ mainland: ${JSON.stringify(r.bounds)}`);
    });

    await test("Hong Kong (not a 'country' in OSM) falls back to the free-text search and picks the region, not the same-named city", async () => {
        reset();
        const r = await resolveLocationBoundary({ type: "country", country: "Hong Kong" });
        assert.strictEqual(r.status, "found");
        assert.strictEqual(r.source.osmId, "913110");
        assert.strictEqual(r.geometry.type, "MultiPolygon");
        assert.strictEqual(fetchCalls.length, 2, "structured search, then the fallback");
    });

    await test("two equally good, non-overlapping same-name settlements are ambiguous — nothing is drawn rather than a guess", async () => {
        const square = (x, y) => ({ type: "Polygon", coordinates: [[[x, y], [x + 0.1, y], [x + 0.1, y + 0.1], [x, y + 0.1], [x, y]]] });
        const place = (id, x) => ({ osm_type: "relation", osm_id: id, name: "Springfield", category: "boundary", type: "administrative", addresstype: "town", place_rank: 16, importance: 0.5, namedetails: { name: "Springfield" }, geojson: square(x, 40) });
        assert.deepStrictEqual(selectCity([place(1, -90), place(2, -80)], "Springfield"), { status: "not_found", reason: "ambiguous" });
        const clearer = { ...place(2, -80), importance: 0.4 };
        assert.strictEqual(selectCity([place(1, -90), clearer], "Springfield").candidate.result.osm_id, 1);
    });

    console.log("\ngeometry validation and fit bounds");

    await test("only Polygon/MultiPolygon with valid rings are accepted; invalid parts are dropped, open rings closed, coordinates rounded", () => {
        assert.strictEqual(normalizeGeometry({ type: "Point", coordinates: [0, 0] }, 4), null);
        assert.strictEqual(normalizeGeometry({ type: "LineString", coordinates: [[0, 0], [1, 1]] }, 4), null);
        assert.strictEqual(normalizeGeometry(null, 4), null);
        assert.strictEqual(normalizeGeometry({ type: "Polygon", coordinates: [[[0, 0], [1, 0], [0, 0]]] }, 4), null, "degenerate ring");
        assert.strictEqual(normalizeGeometry({ type: "Polygon", coordinates: [[[0, 0], [200, 0], [1, 1], [0, 0]]] }, 4), null, "out of range");
        const open = normalizeGeometry({ type: "Polygon", coordinates: [[[0.123456, 0], [1, 0], [1, 1]]] }, 4);
        assert.deepStrictEqual(open.coordinates[0], [[0.1235, 0], [1, 0], [1, 1], [0.1235, 0]]);
        const multi = normalizeGeometry({ type: "MultiPolygon", coordinates: [
            [[[0, 0], [1, 0], [1, 1], [0, 0]]],
            [[["x", 0], [1, 0], [1, 1], ["x", 0]]],
            [[[5, 5], [6, 5], [6, 6], [5, 5]]],
        ] }, 4);
        assert.strictEqual(multi.type, "MultiPolygon");
        assert.strictEqual(multi.coordinates.length, 2, "the invalid part is dropped, the rest kept");
        const single = normalizeGeometry({ type: "MultiPolygon", coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]], [[["bad"]]]] }, 4);
        assert.strictEqual(single.type, "Polygon", "one valid part left becomes a Polygon");
    });

    await test("fit bounds frame the main landmass and nearby significant parts, not remote territories", () => {
        const sq = (x, y, size) => [[[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]]];
        const geometry = { type: "MultiPolygon", coordinates: [sq(0, 40, 10), sq(11, 42, 1.5), sq(-60, 0, 3)] };
        assert.deepStrictEqual(computeFitBounds(geometry), [[40, 0], [50, 12.5]]);
    });

    console.log("\ncaching and failure handling");

    await test("a found boundary is cached: repeat lookups and concurrent lookups make one Nominatim request, persisted under the boundary key", async () => {
        reset();
        await sharedStore.sharedDelete(`${CACHE_PREFIX}city:united kingdom:london`);
        const [a, b] = await Promise.all([
            resolveLocationBoundary({ type: "city", city: "London", country: "UK" }),
            resolveLocationBoundary({ type: "city", city: "london", country: "United Kingdom" }),
        ]);
        await resolveLocationBoundary({ type: "city", city: "London", country: "UK" });
        assert.strictEqual(fetchCalls.length, 1);
        assert.strictEqual(a, b, "concurrent callers share one in-flight lookup");
        const stored = await sharedStore.sharedGet(`${CACHE_PREFIX}city:united kingdom:london`);
        assert.strictEqual(stored.status, "found");

        boundary._resetBoundaryMemo(); // a fresh instance reads the shared cache, not Nominatim
        const again = await resolveLocationBoundary({ type: "city", city: "London", country: "UK" });
        assert.strictEqual(again.status, "found");
        assert.strictEqual(fetchCalls.length, 1);
    });

    await test("no polygon (Dubai is only a Point in OSM) is a cached not_found — not a fabricated boundary, not re-requested", async () => {
        reset();
        overrides.set("city:Dubai:United Arab Emirates", [{ osm_type: "node", osm_id: 31248510, name: "Dubai", category: "place", type: "city", addresstype: "city", place_rank: 16, importance: 0.7, namedetails: { name: "Dubai" }, geojson: { type: "Point", coordinates: [55.29, 25.26] } }]);
        const r = await resolveLocationBoundary({ type: "city", city: "Dubai", country: "UAE" });
        assert.strictEqual(r.status, "not_found");
        assert.strictEqual(r.geometry, undefined);
        boundary._resetBoundaryMemo();
        await resolveLocationBoundary({ type: "city", city: "Dubai", country: "UAE" });
        assert.strictEqual(fetchCalls.length, 1, "negative result served from the shared cache");
    });

    await test("a transient failure is 'unavailable', memoised briefly in-instance, and never written to the shared cache", async () => {
        reset();
        const key = `${CACHE_PREFIX}country:germany:`;
        await sharedStore.sharedDelete(key);
        overrides.set("country:Germany", new Error("socket hang up"));
        const r = await resolveLocationBoundary({ type: "country", country: "Germany" });
        assert.strictEqual(r.status, "unavailable");
        await resolveLocationBoundary({ type: "country", country: "Germany" });
        assert.strictEqual(fetchCalls.length, 1, "memoised — no retry storm");
        assert.strictEqual(await sharedStore.sharedGet(key), undefined);
    });

    await test("locations outside the site's search catalog never reach Nominatim", async () => {
        reset();
        assert.strictEqual((await resolveLocationBoundary({ type: "country", country: "Narnia" })).status, "not_found");
        assert.strictEqual((await resolveLocationBoundary({ type: "city", city: "Cair Paravel", country: "UK" })).status, "not_found");
        assert.strictEqual((await resolveLocationBoundary({ type: "region", country: "UK" })).status, "invalid");
        assert.strictEqual(fetchCalls.length, 0);
    });

    await test("Nominatim requests identify the app and share the existing Nominatim rate budget", async () => {
        reset();
        await sharedStore.sharedDelete(`${CACHE_PREFIX}city:united kingdom:manchester`); // cached by an earlier test
        await resolveLocationBoundary({ type: "city", city: "Manchester", country: "UK" });
        assert.ok(fetchCalls.length === 1 && /^https:\/\/nominatim\.openstreetmap\.org\/search\?/.test(fetchCalls[0].url));
        assert.match(fetchCalls[0].headers["User-Agent"], /IVYHUTS/);
        assert.match(fetchCalls[0].url, /polygon_geojson=1/);
        assert.strictEqual(NOMINATIM_RATE_KEY, "university:discovery:nominatim:requests");
        assert.match(fs.readFileSync(path.join(LIB, "boundaryResolver.js"), "utf8"), /waitForRateSlot\(\)/);
    });

    console.log("\nroute and isolation");

    await test("GET /api/location-boundary: found is long-cacheable, unavailable is no-store, bad input is 400, non-GET is 405", async () => {
        reset();
        let res = fakeRes();
        await handler({ method: "GET", query: { type: "country", country: "New Zealand" } }, res);
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.body.ok, true);
        assert.strictEqual(res.body.status, "found");
        assert.match(res.headers["cache-control"], /s-maxage=604800/);

        overrides.set("country:Spain", new Error("timeout"));
        res = fakeRes();
        await handler({ method: "GET", query: { type: "country", country: "Spain" } }, res);
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.body.status, "unavailable");
        assert.strictEqual(res.headers["cache-control"], "no-store");

        res = fakeRes();
        await handler({ method: "GET", query: { type: "city", country: "UK" } }, res);
        assert.strictEqual(res.statusCode, 400);
        res = fakeRes();
        await handler({ method: "POST", query: {} }, res);
        assert.strictEqual(res.statusCode, 405);
    });

    await test("boundaries and inventory are separate: neither module imports the other, and the resolver never touches Amber", () => {
        const resolverSrc = fs.readFileSync(path.join(LIB, "boundaryResolver.js"), "utf8");
        const inventorySrc = fs.readFileSync(path.join(LIB, "routes", "content", "university-housing", "inventory.js"), "utf8");
        assert.doesNotMatch(resolverSrc, /require\([^)]*(amberGateway|accommodationIndex|accommodationInventoryService)/);
        assert.doesNotMatch(inventorySrc, /boundary/i);
        assert.ok(fetchCalls.every((c) => c.url.startsWith("https://nominatim.openstreetmap.org/")), "only Nominatim was ever called");
        const routes = require(path.join(LIB, "routes", "content.js"));
        assert.ok(routes.some((r) => r.segments[0] === "location-boundary"));
        const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, "vercel.json"), "utf8"));
        assert.ok(vercel.rewrites.some((r) => r.source === "/api/location-boundary" && r.destination === "/api/content/location-boundary"));
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed) {
        for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
        process.exit(1);
    }
})();
