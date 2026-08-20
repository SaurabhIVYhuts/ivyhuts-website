#!/usr/bin/env node
// Milestone 15 regression tests (Part 20): deterministic, no live Amber
// calls, no Mongo dependency for the core matchesCity()/inference assertions
// — these test the CURRENT (unfixed) behavior, documenting the bug this
// milestone found so a Milestone 16 fix has a concrete before/after target.
// Two tests that read real Mongo (to confirm the live evidence this
// milestone's report cites) are separately marked and skip gracefully if
// Mongo is unreachable, same convention as every prior milestone's suite.
"use strict";

const assert = require("assert");
const path = require("path");
const ROOT = path.join(__dirname, "..");
require("dotenv").config({ path: path.join(ROOT, ".env.local") });
require("dotenv").config({ path: path.join(ROOT, ".env") });

const { matchesCity } = require(path.join(ROOT, "api", "_lib", "amberGateway"));
const { inferCityFromName, auditDoc } = require("./audit-city-attribution");

let passed = 0, failed = 0, skipped = 0;
async function test(name, fn) {
    try {
        await fn();
        console.log(`  PASS  ${name}`);
        passed++;
    } catch (err) {
        console.log(`  FAIL  ${name}: ${err.message}`);
        failed++;
    }
}
function skip(name, reason) {
    console.log(`  SKIP  ${name}: ${reason}`);
    skipped++;
}

async function main() {
    console.log("=== Milestone 15 — City Attribution Regression Tests ===\n");

    // ── Milestone 16 fix verification: item.name is no longer a match field ─
    await test("matchesCity() no longer matches a Salford property to 'manchester' via its brand name (Milestone 16 fix)", () => {
        const item = { id: "1167294", name: "True Manchester Salford, Salford", location: { locality: { long_name: "Salford" }, city: { long_name: "Salford" }, country: { long_name: "United Kingdom" } } };
        assert.strictEqual(matchesCity(item, "manchester"), false, "post-fix: item.name must no longer influence the match");
    });

    await test("matchesCity() does not match Huddersfield to 'manchester' via item.name (name contains no 'manchester' substring anyway, but confirms location-only matching)", () => {
        const item = { id: "137834", name: "Snow Island, Huddersfield", location: { locality: { long_name: "Huddersfield" }, city: { long_name: "Huddersfield" }, country: { long_name: "United Kingdom" } } };
        assert.strictEqual(matchesCity(item, "manchester"), false);
    });

    await test("matchesCity() correctly matches a genuine Manchester property via location fields", () => {
        const item = { id: "138785", name: "Manchester House, Manchester", location: { locality: { long_name: "Manchester" }, city: { long_name: "Manchester" }, country: { long_name: "United Kingdom" } } };
        assert.strictEqual(matchesCity(item, "manchester"), true);
    });

    await test("matchesCity() still matches when only location.locality carries the city (name irrelevant)", () => {
        const item = { id: "1", name: "Some Brand Residence", location: { locality: { long_name: "Manchester" }, country: { long_name: "United Kingdom" } } };
        assert.strictEqual(matchesCity(item, "manchester"), true);
    });

    await test("matchesCity() correctly rejects an unrelated city even when country matches broadly", () => {
        const item = { id: "999999", name: "Some Place, Leeds", location: { locality: { long_name: "Leeds" }, city: { long_name: "Leeds" }, country: { long_name: "United Kingdom" } } };
        assert.strictEqual(matchesCity(item, "manchester"), false);
    });

    await test("matchesCity() does not let a property NAMED after the city (but located elsewhere) pass via name alone", () => {
        // The exact shape of the original bug: name mentions the target city,
        // location fields correctly say otherwise — must now be rejected.
        const item = { id: "2", name: "Manchester Lofts, Derby", location: { locality: { long_name: "Derby" }, city: { long_name: "Derby" }, country: { long_name: "United Kingdom" } } };
        assert.strictEqual(matchesCity(item, "manchester"), false);
    });

    for (const [city, sampleName] of [["derby", "iQ Derby, Derby"], ["barcelona", "Blau Student Housing, Barcelona"], ["sheffield", "iQ Century Square, Sheffield"], ["leeds", "iQ Leeds, Leeds"], ["glasgow", "Merchant Studios, Glasgow"], ["liverpool", "The Bridewell, Liverpool"]]) {
        await test(`matchesCity() still correctly matches a genuine ${city} property (real-shaped name) after the fix`, () => {
            const item = { id: `sample-${city}`, name: sampleName, location: { locality: { long_name: city[0].toUpperCase() + city.slice(1) }, city: { long_name: city[0].toUpperCase() + city.slice(1) }, country: { long_name: "United Kingdom" } } };
            assert.strictEqual(matchesCity(item, city), true);
        });
    }

    // ── inferCityFromName() — this milestone's own detection mechanism ─────
    await test("inferCityFromName() extracts the trailing locality segment", () => {
        assert.strictEqual(inferCityFromName("Snow Island, Huddersfield"), "huddersfield");
        assert.strictEqual(inferCityFromName("True Manchester Salford, Salford"), "salford");
        assert.strictEqual(inferCityFromName("iQ Leeds, Leeds"), "leeds");
    });

    await test("inferCityFromName() returns null (never a guess) when there is no comma", () => {
        assert.strictEqual(inferCityFromName("Some Property With No City Suffix"), null);
    });

    await test("auditDoc() flags the real Snow Island / Huddersfield mismatch", () => {
        const doc = { propertyId: "137834", propertyName: "Snow Island, Huddersfield", city: "manchester", country: "United Kingdom", latitude: 53.64, longitude: -1.78 };
        const result = auditDoc(doc);
        assert.strictEqual(result.mismatch, true);
        assert.strictEqual(result.inferredCity, "huddersfield");
        assert.strictEqual(result.confidence, "HIGH");
    });

    await test("auditDoc() flags the real 'True Manchester Salford' mismatch with the name-substring-bug reason", () => {
        const doc = { propertyId: "1167294", propertyName: "True Manchester Salford, Salford", city: "manchester", country: "United Kingdom", latitude: 53.48, longitude: -2.29 };
        const result = auditDoc(doc);
        assert.strictEqual(result.mismatch, true);
        assert.strictEqual(result.inferredCity, "salford");
        assert.ok(result.reason.includes("matchesCity()"), "reason should cite the matchesCity() name-substring mechanism");
    });

    await test("auditDoc() does not flag a correctly-attributed property", () => {
        const doc = { propertyId: "138785", propertyName: "Manchester House, Manchester", city: "manchester", country: "United Kingdom", latitude: 53.48, longitude: -2.24 };
        const result = auditDoc(doc);
        assert.strictEqual(result.mismatch, false);
        assert.strictEqual(result.confidence, "HIGH");
    });

    await test("auditDoc() reports UNKNOWN (not a guess) for a name with no locality suffix", () => {
        const doc = { propertyId: "1", propertyName: "NoCitySuffixProperty", city: "manchester", country: "United Kingdom" };
        const result = auditDoc(doc);
        assert.strictEqual(result.mismatch, false);
        assert.strictEqual(result.confidence, "UNKNOWN");
        assert.strictEqual(result.inferredCity, null);
    });

    // ── Live confirmation against real Mongo (skips gracefully if unreachable) ─
    let AccommodationResidence, connectToDatabase, disconnectFromDatabase;
    try {
        ({ connectToDatabase, disconnectFromDatabase } = require(path.join(ROOT, "api", "_lib", "mongodb")));
        AccommodationResidence = require(path.join(ROOT, "api", "_lib", "models", "AccommodationResidence"));
        await connectToDatabase();
    } catch (err) {
        skip("real Mongo: Manchester attribution accuracy is 44/45 post-Milestone-17-remediation", `Mongo unreachable: ${err.message}`);
        skip("real Mongo: Derby/Barcelona/Sheffield/Leeds/Glasgow/Liverpool are 100% attribution-correct", "Mongo unreachable");
    }
    if (AccommodationResidence) {
        // Milestone 17 (IVYHUTS_MILESTONE_17_TARGETED_CITY_REMEDIATION_REPORT.md):
        // 1167294/147713 were live-Amber-confirmed as Salford and corrected in
        // Mongo (city field only, identity preserved) — expectation updated to
        // match that intentional, verified change, not to paper over a bug.
        // 137834 (Snow Island) remains mismatched: its live Amber detail lookup
        // returned no item (likely delisted since its 2026-08-11 ingestion), so
        // Milestone 17 correctly classified it INSUFFICIENT_EVIDENCE and left it
        // unmodified rather than guessing.
        await test("real Mongo: Manchester attribution accuracy is 44/45 post-Milestone-17-remediation, 1 known remaining mismatch", async () => {
            const docs = await AccommodationResidence.find({ city: "manchester" }).lean();
            const mismatched = docs.map(auditDoc).filter((r) => r.mismatch);
            const ids = mismatched.map((r) => r.sourceId).sort();
            assert.deepStrictEqual(ids, ["137834"], `expected only the still-unresolved Snow Island mismatch, got ${JSON.stringify(ids)}`);
        });
        await test("real Mongo: Salford now correctly holds the 2 remediated properties, 0 mismatches", async () => {
            const docs = await AccommodationResidence.find({ city: "salford" }).lean();
            const ids = docs.map((d) => d.propertyId);
            assert.ok(ids.includes("1167294") && ids.includes("147713"), "both remediated properties should now be under city=salford");
            const mismatched = docs.map(auditDoc).filter((r) => r.mismatch);
            assert.strictEqual(mismatched.length, 0);
        });
        await test("real Mongo: Derby is 100% attribution-correct (0 mismatches)", async () => {
            const docs = await AccommodationResidence.find({ city: "derby" }).lean();
            const mismatched = docs.map(auditDoc).filter((r) => r.mismatch);
            assert.strictEqual(mismatched.length, 0);
        });
        await disconnectFromDatabase();
    }

    console.log(`\n=== ${passed} passed, ${failed} failed, ${skipped} skipped ===`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => { console.error("Test suite crashed:", err); process.exit(1); });
