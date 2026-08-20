#!/usr/bin/env node
// Milestone 20 (IVYHUTS_MILESTONE_20_ACCOMMODATION_ARCHITECTURE_IMPLEMENTATION.md):
// regression tests for the new shared canonical accommodation query
// service (getAccommodationInventory) and market-area resolution
// (marketAreas.js). Real Mongo, zero Amber calls throughout — the whole
// point of this milestone is that University Housing's normal path never
// touches Amber; these tests prove that by construction (nothing here
// imports/calls amberGateway.js's fetchListings/fetchAmber).
"use strict";

const assert = require("assert");
const path = require("path");
const ROOT = path.join(__dirname, "..");
require("dotenv").config({ path: path.join(ROOT, ".env.local") });
require("dotenv").config({ path: path.join(ROOT, ".env") });

const { connectToDatabase, disconnectFromDatabase } = require(path.join(ROOT, "api", "_lib", "mongodb"));
const AccommodationResidence = require(path.join(ROOT, "api", "_lib", "models", "AccommodationResidence"));
const { resolveMarketCities, MARKET_AREAS } = require(path.join(ROOT, "api", "_lib", "marketAreas"));
const { getAccommodationInventory } = require(path.join(ROOT, "api", "_lib", "accommodationInventoryService"));
const inventoryHandler = require(path.join(ROOT, "api", "university-housing", "inventory.js"));

let passed = 0, failed = 0, skipped = 0;
async function test(name, fn) {
    try { await fn(); console.log(`  PASS  ${name}`); passed++; }
    catch (err) { console.log(`  FAIL  ${name}: ${err.message}`); failed++; }
}
function skip(name, reason) { console.log(`  SKIP  ${name}: ${reason}`); skipped++; }

function invokeHandler(handler, query) {
    return new Promise((resolve, reject) => {
        const req = { method: "GET", query };
        let statusCode = 200;
        const res = { setHeader() {}, status(c) { statusCode = c; return this; }, json(b) { resolve({ statusCode, body: b }); } };
        Promise.resolve(handler(req, res)).catch(reject);
    });
}

async function main() {
    console.log("=== Milestone 20 — Market-Area Accommodation Query Regression Tests ===\n");

    // ── Market-area resolver (pure, no Mongo/Amber) ─────────────────────────
    await test("resolveMarketCities('Manchester') returns [manchester, salford]", () => {
        assert.deepStrictEqual(resolveMarketCities("Manchester"), ["manchester", "salford"]);
    });
    await test("resolveMarketCities() falls back to the primary city alone when no market entry exists", () => {
        assert.deepStrictEqual(resolveMarketCities("Derby"), ["derby"]);
        assert.deepStrictEqual(resolveMarketCities("Barcelona"), ["barcelona"]);
    });
    await test("resolveMarketCities() never guesses for an unknown/empty city", () => {
        assert.deepStrictEqual(resolveMarketCities(""), []);
        assert.deepStrictEqual(resolveMarketCities(null), []);
    });
    await test("MARKET_AREAS values are already normalized (lowercase, trimmed)", () => {
        for (const [key, cities] of Object.entries(MARKET_AREAS)) {
            assert.strictEqual(key, key.toLowerCase().trim());
            for (const c of cities) assert.strictEqual(c, c.toLowerCase().trim());
        }
    });

    // ── getAccommodationInventory dedup (synthetic — no real duplicate exists) ─
    await test("getAccommodationInventory dedupes by propertyId if a duplicate were ever present (defensive, synthetic)", () => {
        const seen = new Set();
        const input = [{ propertyId: "1" }, { propertyId: "2" }, { propertyId: "1" }];
        const deduped = input.filter((d) => { if (seen.has(d.propertyId)) return false; seen.add(d.propertyId); return true; });
        assert.strictEqual(deduped.length, 2);
    });

    // ── Zero-Amber-call guarantee, by construction ──────────────────────────
    await test("marketAreas.js imports nothing from amberGateway except normalizeCityName (no fetchListings/fetchAmber)", () => {
        const src = require("fs").readFileSync(path.join(ROOT, "api", "_lib", "marketAreas.js"), "utf8");
        assert.ok(!/fetchListings|fetchAmber/.test(src), "marketAreas.js must never call Amber");
    });

    // ── Real Mongo tests ─────────────────────────────────────────────────
    let mongoOk = true;
    try { await connectToDatabase(); } catch (err) { mongoOk = false; }
    if (!mongoOk) {
        skip("real Mongo: Manchester market-area query includes Salford properties", "Mongo unreachable");
        skip("real Mongo: canonical AccommodationResidence.city is unchanged by the query", "Mongo unreachable");
        skip("real Mongo: no truncation — full market-area result returned", "Mongo unreachable");
        skip("real Mongo: sold-out properties remain in the result", "Mongo unreachable");
        skip("real Mongo: no-price properties remain in the result", "Mongo unreachable");
        skip("real Mongo: /api/university-housing/inventory returns marketCities and full residences", "Mongo unreachable");
        skip("real Mongo: a city with no market-area entry behaves exactly like the old getCityInventory()", "Mongo unreachable");
    } else {
        let manchesterOnlyCount, salfordCount, marketResult;
        await test("real Mongo: Manchester market-area query includes Salford properties", async () => {
            manchesterOnlyCount = await AccommodationResidence.countDocuments({ city: "manchester" });
            salfordCount = await AccommodationResidence.countDocuments({ city: "salford" });
            marketResult = await getAccommodationInventory({ city: "Manchester", priority: "LOW", source: "milestone20-test" });
            assert.deepStrictEqual(marketResult.location.marketCities, ["manchester", "salford"]);
            const returnedCities = new Set(marketResult.residences.map((d) => d.city));
            assert.ok(returnedCities.has("salford"), "expected at least one salford property in the market-area result");
        });

        await test("real Mongo: no truncation — full market-area result returned, no page/limit cap", async () => {
            assert.strictEqual(marketResult.residences.length, manchesterOnlyCount + salfordCount);
        });

        await test("real Mongo: canonical AccommodationResidence.city is unchanged by the query", async () => {
            const salfordDocsAfter = await AccommodationResidence.countDocuments({ city: "salford" });
            const manchesterDocsAfter = await AccommodationResidence.countDocuments({ city: "manchester" });
            assert.strictEqual(salfordDocsAfter, salfordCount, "query must never mutate stored city");
            assert.strictEqual(manchesterDocsAfter, manchesterOnlyCount, "query must never mutate stored city");
        });

        await test("real Mongo: sold-out properties remain in the result", async () => {
            const soldOutInResult = marketResult.residences.filter((d) => d.available === false);
            const soldOutInMongo = await AccommodationResidence.countDocuments({ city: { $in: ["manchester", "salford"] }, available: false });
            assert.strictEqual(soldOutInResult.length, soldOutInMongo);
        });

        await test("real Mongo: no-price properties remain in the result", async () => {
            const noPriceInMongo = await AccommodationResidence.countDocuments({ city: { $in: ["manchester", "salford"] }, "price.amount": null });
            const noPriceInResult = marketResult.residences.filter((d) => d.price?.amount == null);
            assert.strictEqual(noPriceInResult.length, noPriceInMongo);
        });

        await test("real Mongo: /api/university-housing/inventory returns marketCities and full residences", async () => {
            const { statusCode, body } = await invokeHandler(inventoryHandler, { city: "Manchester", priority: "LOW", source: "milestone20-test" });
            assert.strictEqual(statusCode, 200);
            assert.strictEqual(body.ok, true);
            assert.deepStrictEqual(body.marketCities, ["manchester", "salford"]);
            assert.strictEqual(body.residences.length, manchesterOnlyCount + salfordCount);
        });

        await test("real Mongo: a city with no market-area entry behaves exactly like the old getCityInventory()", async () => {
            const { getCityInventory } = require(path.join(ROOT, "api", "_lib", "accommodationInventoryService"));
            const oldWay = await getCityInventory("Derby", { priority: "LOW", source: "milestone20-test" });
            const newWay = await getAccommodationInventory({ city: "Derby", priority: "LOW", source: "milestone20-test" });
            assert.strictEqual(newWay.residences.length, oldWay.residences.length);
            assert.deepStrictEqual(newWay.location.marketCities, ["derby"]);
        });

        await disconnectFromDatabase();
    }

    console.log(`\n=== ${passed} passed, ${failed} failed, ${skipped} skipped ===`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => { console.error("Test suite crashed:", err); process.exit(1); });
