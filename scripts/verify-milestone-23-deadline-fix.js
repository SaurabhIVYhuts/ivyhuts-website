#!/usr/bin/env node
// Milestone 23 (deadline fix, "FINAL DEADLINE FIX" prompt) verification.
//
// Context: 4 independent, real, fresh reconciliation runs this session
// (Manchester, Derby, Barcelona, London — plus 2 prior milestones' worth of
// runs before that) found missingFromMongo=0 in every single city tested.
// There is no evidence of an Amber-ingestion data-loss bug in these
// markets. What real investigation DID find and fix:
//   1. A refresh whose Amber pagination stops early (deadline/budget/page
//      cap) could previously be marked AccommodationIndexMeta status "ok"
//      indistinguishably from a genuinely complete refresh — confirmed live
//      this session (Derby's own reconciliation pull hit PAGINATE_FAILED at
//      page 3). Fixed: fetchListings() now reports `complete`, and
//      persistResidences() records status "partial" (never "ok") when it's
//      false — the real rows found are still always persisted.
//   2. "City of Westminster" (a real Nominatim/OSM borough name a London
//      university's discovery record resolves to) had ZERO Mongo documents
//      — not an ingestion bug (London itself has 185 real documents), but a
//      pure city-string mismatch. Fixed via a marketAreas.js alias entry,
//      which also surfaced and fixed a real bug in getAccommodationInventory
//      (a pure single-city alias was being silently ignored).
//
// SAFETY: mocked global.fetch for pagination-behavior tests (zero real
// Amber calls). Mongo-writing tests scoped to "zzz-milestone23-test-*" city
// names, cleaned up before/after.
"use strict";

const assert = require("assert");
const path = require("path");
const ROOT = path.join(__dirname, "..");
require("dotenv").config({ path: path.join(ROOT, ".env.local") });
require("dotenv").config({ path: path.join(ROOT, ".env") });

let passed = 0, failed = 0, skipped = 0;
async function test(name, fn) {
    try { await fn(); console.log(`  PASS  ${name}`); passed++; }
    catch (err) {
        if (err && err.__skip) { console.log(`  SKIP  ${name}: ${err.message}`); skipped++; return; }
        console.log(`  FAIL  ${name}: ${err.stack || err.message}`); failed++;
    }
}
function skip(reason) { const e = new Error(reason); e.__skip = true; throw e; }

function freshModules(fetchImpl) {
    const files = ["sharedStore.js", "amberGateway.js", "accommodationIndex.js", "accommodationInventoryService.js", "marketAreas.js"].map((f) => path.join(ROOT, "api", "_lib", f));
    for (const f of files) delete require.cache[require.resolve(f)];
    for (const k of ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_URL", "KV_REST_API_TOKEN"]) delete process.env[k];
    global.fetch = fetchImpl;
    return {
        gateway: require(path.join(ROOT, "api", "_lib", "amberGateway.js")),
        index: require(path.join(ROOT, "api", "_lib", "accommodationIndex.js")),
        service: require(path.join(ROOT, "api", "_lib", "accommodationInventoryService.js")),
    };
}

// city-filtered, page-aware mock — item names all matchable to `city`.
function pageFetch(pagesByCity, { failOnPage } = {}) {
    return async (url) => {
        const u = new URL(url);
        const page = Number(u.searchParams.get("p")) || 1;
        const city = (u.searchParams.get("location_place_name") || "").toLowerCase();
        if (failOnPage && page === failOnPage) throw new Error("simulated deadline/budget exhaustion");
        const items = (pagesByCity[city] && pagesByCity[city][page]) || [];
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ message: "success", data: { result: items, meta: { count: items.length } } }) };
    };
}
function matchedItem(id, city) {
    return { id, name: `Fixture ${id}, ${city}`, location: { locality: { long_name: city } } };
}

let mongoAvailable = null;
async function requireMongo() {
    if (mongoAvailable === null) {
        try {
            const { connectToDatabase } = require(path.join(ROOT, "api", "_lib", "mongodb"));
            await Promise.race([connectToDatabase(), new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 8000))]);
            mongoAvailable = true;
        } catch { mongoAvailable = false; }
    }
    if (!mongoAvailable) skip("MongoDB is not reachable from this environment — skipping, not fabricating a pass");
}
async function cleanupCity(city) {
    const AccommodationResidence = require(path.join(ROOT, "api", "_lib", "models", "AccommodationResidence"));
    const AccommodationIndexMeta = require(path.join(ROOT, "api", "_lib", "models", "AccommodationIndexMeta"));
    await AccommodationResidence.deleteMany({ city });
    await AccommodationIndexMeta.deleteMany({ city });
}

async function main() {
    console.log("=== Milestone 23 — Deadline Fix Verification ===\n");

    // ── fetchListings() `complete` flag ─────────────────────────────────────
    await test("fetchListings(): a clean, single-page (partial-page) fetch reports complete=true", async () => {
        const items = [matchedItem(1, "testville"), matchedItem(2, "testville")]; // < pageSize=50 -> genuine last page
        const { gateway } = freshModules(pageFetch({ testville: { 1: items } }));
        const result = await gateway.fetchListings({ city: "testville", page: 1, limit: 150 }, "LOW", "test23");
        assert.strictEqual(result.complete, true);
    });

    await test("fetchListings(): a full page-1 that fails mid-pagination reports complete=false (the exact bug found live)", async () => {
        const page1 = Array.from({ length: 50 }, (_, i) => matchedItem(i + 1, "testville")); // full page -> loop continues
        const { gateway } = freshModules(pageFetch({ testville: { 1: page1 } }, { failOnPage: 2 }));
        const result = await gateway.fetchListings({ city: "testville", page: 1, limit: 150 }, "LOW", "test23");
        assert.strictEqual(result.complete, false, "a PAGINATE_FAILED mid-loop must be reported as incomplete, not silently look identical to a clean finish");
        assert.strictEqual(result.data.data.result.length, 50, "the real page-1 rows must still be returned, never discarded, even though the fetch was incomplete");
    });

    await test("fetchListings(): the sparse-fallback (untrustworthy-primary) path always reports complete=false", async () => {
        // Primary page returns 0 genuine matches for "testville" -> untrustworthy -> fallback branch.
        const fallbackPage1 = [matchedItem(1, "testville")];
        const fetchFn = async (url) => {
            const u = new URL(url);
            const page = Number(u.searchParams.get("p")) || 1;
            const hasCityFilter = u.searchParams.has("location_place_name");
            const items = hasCityFilter ? [] : (page === 1 ? fallbackPage1 : []);
            return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ message: "success", data: { result: items, meta: { count: items.length } } }) };
        };
        const { gateway } = freshModules(fetchFn);
        const result = await gateway.fetchListings({ city: "testville", page: 1, limit: 150 }, "LOW", "test23");
        assert.strictEqual(result.complete, false, "the fallback path only ever samples a bounded slice of the global catalog — never a complete city snapshot");
    });

    // ── persistResidences() status: "ok" vs "partial" ───────────────────────
    await requireMongo();
    const city = "zzz-milestone23-test-partial";
    await cleanupCity(city);
    try {
        await test("real Mongo: persistResidences() with complete=false records status \"partial\", never \"ok\"", async () => {
            const { index } = freshModules(async () => ({ ok: true, json: async () => ({}) }));
            const AccommodationIndexMeta = require(path.join(ROOT, "api", "_lib", "models", "AccommodationIndexMeta"));
            const mapped = [index.mapAmberItemToResidence(matchedItem(1, city), city)];
            await index.persistResidences(city, mapped, { complete: false });
            const meta = await AccommodationIndexMeta.findOne({ city }).lean();
            assert.strictEqual(meta.status, "partial");
            const AccommodationResidence = require(path.join(ROOT, "api", "_lib", "models", "AccommodationResidence"));
            const doc = await AccommodationResidence.findOne({ city, propertyId: "1" }).lean();
            assert.ok(doc, "the real row found must still be persisted even though the metadata honestly says partial");
        });

        await test("real Mongo: persistResidences() with complete=true (default, unchanged) still records status \"ok\"", async () => {
            const { index } = freshModules(async () => ({ ok: true, json: async () => ({}) }));
            const AccommodationIndexMeta = require(path.join(ROOT, "api", "_lib", "models", "AccommodationIndexMeta"));
            const mapped = [index.mapAmberItemToResidence(matchedItem(2, city), city)];
            await index.persistResidences(city, mapped); // no options -> complete defaults true, same as every pre-existing caller
            const meta = await AccommodationIndexMeta.findOne({ city }).lean();
            assert.strictEqual(meta.status, "ok", "the default (no options passed) must remain exactly the pre-existing behavior — zero regression for every unchanged caller");
        });

        // ── Part 19's exact requested regression ────────────────────────────
        await test("real Mongo: refreshCityIndex() with a mocked COMPLETE Amber response persists every real sourceId to AccommodationResidence", async () => {
            await cleanupCity(city);
            const sourceIds = ["101", "102", "103", "104", "105"];
            const items = sourceIds.map((id) => matchedItem(id, city));
            const { index } = freshModules(pageFetch({ [city]: { 1: items } }));
            const outcome = await index.refreshCityIndex(city, "LOW", "test23-core-regression");
            assert.strictEqual(outcome.refreshed, true);
            const AccommodationResidence = require(path.join(ROOT, "api", "_lib", "models", "AccommodationResidence"));
            const stored = await AccommodationResidence.find({ city }).lean();
            const storedIds = new Set(stored.map((d) => d.propertyId));
            for (const id of sourceIds) {
                assert.ok(storedIds.has(id), `sourceId ${id} was returned by Amber but is missing from AccommodationResidence after a successful complete refresh`);
            }
            const AccommodationIndexMeta = require(path.join(ROOT, "api", "_lib", "models", "AccommodationIndexMeta"));
            const meta = await AccommodationIndexMeta.findOne({ city }).lean();
            assert.strictEqual(meta.status, "ok", "a genuinely complete refresh must still be marked ok");
        });
    } finally {
        await cleanupCity(city);
    }

    // ── Westminster alias + the getAccommodationInventory bug fix ──────────
    await test("real Mongo: 'City of Westminster' resolves via the marketAreas.js alias to London's real inventory", async () => {
        const { service } = freshModules(async () => ({ ok: true, json: async () => ({}) }));
        const result = await service.getAccommodationInventory({ city: "City of Westminster", priority: "LOW", source: "test23" });
        assert.deepStrictEqual(result.location.marketCities, ["london"]);
        assert.ok(result.residences.length > 0, "must resolve to London's real, populated inventory, not an empty 'city of westminster' bucket");
        assert.ok(result.residences.every((r) => r.city === "london"), "canonical city field must remain 'london' — the alias is a query-time resolution, never a data rewrite");
    });

    await test("real Mongo: a plain single-city request (no alias, no market entry) is unaffected by the alias-resolution fix", async () => {
        const { service } = freshModules(async () => ({ ok: true, json: async () => ({}) }));
        const result = await service.getAccommodationInventory({ city: "Derby", priority: "LOW", source: "test23" });
        assert.deepStrictEqual(result.location.marketCities, ["derby"]);
        assert.ok(result.residences.every((r) => r.city === "derby"));
    });

    console.log(`\n=== ${passed} passed, ${failed} failed, ${skipped} skipped ===`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => { console.error("Test suite crashed:", err); process.exit(1); });
