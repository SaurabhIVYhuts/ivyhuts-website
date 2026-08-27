#!/usr/bin/env node
// Milestone 21 (IVYHUTS_MILESTONE_21_FIND_ROOM_MIGRATION.md) regression
// tests: Find Room's /api/city-listings now shares Milestone 20's
// getAccommodationInventory() service. Most of the underlying logic is
// already covered by verify-milestone-20-market-area.js — this suite
// focuses on what's NEW/specific to this milestone: the city-listings
// route itself, structural proof no old Amber-listings dependency remains
// in normal Find Room browsing, and end-to-end completeness through the
// real handler for both a market-area city and a plain city.
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
require("dotenv").config({ path: path.join(ROOT, ".env.local") });
require("dotenv").config({ path: path.join(ROOT, ".env") });

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
        const res = {
            setHeader() {},
            status(c) { statusCode = c; return this; },
            json(body) { resolve({ statusCode, body }); },
        };
        Promise.resolve(handler(req, res)).catch(reject);
    });
}

async function main() {
    console.log("=== Milestone 21 — Find Room Migration Regression Tests ===\n");

    // ── Structural: no normal-browse Amber-listings dependency remains ─────
    await test("PropertyListingPage.js does not import getProperties (the raw Amber listings function)", () => {
        const src = fs.readFileSync(path.join(ROOT, "src", "pages", "PropertyListingPage.js"), "utf8");
        const importLine = src.split("\n").find((l) => l.includes('from "../services/amberApi"'));
        assert.ok(importLine, "expected an amberApi import line");
        assert.ok(!/\bgetProperties\b/.test(importLine), `getProperties should not be imported for normal browse; got: ${importLine}`);
    });

    await test("PropertyListingPage.js's only remaining Amber-touching paths are the documented curated-backfill and university-override exceptions", () => {
        const src = fs.readFileSync(path.join(ROOT, "src", "pages", "PropertyListingPage.js"), "utf8");
        const getPropertyBySlugCalls = (src.match(/getPropertyBySlug\(/g) || []).length;
        // One for CURATED_CITY_PROPERTIES backfill, one for accommodationOverride — both pre-existing, documented, explicit exceptions (Milestone 9/11), not normal browse.
        assert.strictEqual(getPropertyBySlugCalls, 2, `expected exactly 2 documented getPropertyBySlug() call sites, found ${getPropertyBySlugCalls}`);
    });

    await test("api/city-listings.js uses the shared getAccommodationInventory() service, not accommodationIndex directly", () => {
        const src = fs.readFileSync(path.join(ROOT, "api", "_lib", "routes", "content", "city-listings.js"), "utf8");
        assert.ok(src.includes("getAccommodationInventory"), "expected api/city-listings.js to call the Milestone 20 shared service");
        assert.ok(!/require\(["']\.\/_lib\/accommodationIndex["']\)/.test(src), "api/city-listings.js should not import accommodationIndex directly anymore");
    });

    // ── Real Mongo / real handler tests ─────────────────────────────────────
    let cityListingsHandler, connectToDatabase, disconnectFromDatabase, AccommodationResidence;
    try {
        cityListingsHandler = require(path.join(ROOT, "api", "_lib", "routes", "content", "city-listings.js"));
        ({ connectToDatabase, disconnectFromDatabase } = require(path.join(ROOT, "api", "_lib", "mongodb")));
        AccommodationResidence = require(path.join(ROOT, "api", "_lib", "models", "AccommodationResidence"));
        await connectToDatabase();
    } catch (err) {
        skip("real Mongo: /api/city-listings?city=Manchester includes Salford (market-area)", `Mongo unreachable: ${err.message}`);
        skip("real Mongo: /api/city-listings?city=Derby is unchanged (no market-area entry)", "Mongo unreachable");
        skip("real Mongo: city-listings completeness — Mongo count == API count for the expanded market", "Mongo unreachable");
        skip("real Mongo: zero Amber log lines during a normal city-listings request", "Mongo unreachable");
        console.log(`\n=== ${passed} passed, ${failed} failed, ${skipped} skipped ===`);
        process.exit(failed > 0 ? 1 : 0);
        return;
    }

    await test("real Mongo: /api/city-listings?city=Manchester includes Salford (market-area)", async () => {
        const { body } = await invokeHandler(cityListingsHandler, { city: "Manchester" });
        assert.ok(body.ok);
        assert.deepStrictEqual(body.marketCities.sort(), ["manchester", "salford"]);
        assert.ok(body.residences.some((r) => r.city === "salford"), "expected at least one salford residence in a Manchester city-listings request");
    });

    await test("real Mongo: /api/city-listings?city=Derby is unchanged (no market-area entry)", async () => {
        const { body } = await invokeHandler(cityListingsHandler, { city: "Derby" });
        assert.ok(body.ok);
        assert.deepStrictEqual(body.marketCities, ["derby"]);
        assert.ok(body.residences.every((r) => r.city === "derby"));
    });

    await test("real Mongo: city-listings completeness — Mongo count == API count for the expanded market", async () => {
        const mongoCount = await AccommodationResidence.countDocuments({ city: { $in: ["manchester", "salford"] } });
        const { body } = await invokeHandler(cityListingsHandler, { city: "Manchester" });
        assert.strictEqual(body.residences.length, mongoCount, `expected API count to equal the full market-area Mongo count (${mongoCount})`);
    });

    await test("real Mongo: zero Amber log lines during a normal city-listings request", async () => {
        const lines = [];
        const originalLog = console.log;
        console.log = (...args) => { lines.push(args.join(" ")); };
        try {
            await invokeHandler(cityListingsHandler, { city: "Manchester" });
        } finally {
            console.log = originalLog;
        }
        const amberLines = lines.filter((l) => /amber/i.test(l) && !/CITY_LISTINGS/.test(l));
        assert.strictEqual(amberLines.length, 0, `expected 0 Amber-related log lines, found: ${JSON.stringify(amberLines)}`);
    });

    await disconnectFromDatabase();
    console.log(`\n=== ${passed} passed, ${failed} failed, ${skipped} skipped ===`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => { console.error("Test suite crashed:", err); process.exit(1); });
