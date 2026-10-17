#!/usr/bin/env node
// Verifies api/_lib/inventoryStats.js — the single shared source behind the
// homepage hero's Total Inventory / Sold Out / Remaining cards
// (/api/amber?type=inventorystats).
//
//   TEST 1  fresh Redis aggregate -> served as-is, ZERO Amber requests
//   TEST 2  cache miss -> exactly two count-only (limit=1) LOW-priority
//           gateway requests; total === soldOut + remaining
//   TEST 3  a count the gateway could not supply (budget exhausted) is never
//           turned into 0 -> stale aggregate, or ready:false with no numbers
//   TEST 4  gateway throws -> stale aggregate served, or ready:false
//
// SAFETY: never calls the real Amber API or Redis. amberGateway and
// sharedStore are replaced in require.cache with in-process stubs BEFORE
// inventoryStats.js is loaded. Same plain-node `assert` + `test()` runner
// convention as the other scripts/verify-*.js files.
"use strict";

const assert = require("assert");
const path = require("path");

const LIB = path.join(__dirname, "..", "api", "_lib");
let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  PASS  ${name}`);
    } catch (err) {
        failed++;
        console.log(`  FAIL  ${name}\n        ${err.stack || err.message}`);
    }
}

// ── Stubs ────────────────────────────────────────────────────────────────
const store = new Map();
const amberCalls = [];
let amberImpl = async () => ({ data: null });

function stub(file, exports) {
    const id = require.resolve(path.join(LIB, file));
    require.cache[id] = { id, filename: id, loaded: true, exports };
}
stub("amberGateway.js", {
    fetchAmber: async (opts) => {
        amberCalls.push(opts);
        return amberImpl(opts);
    },
});
stub("sharedStore.js", {
    sharedGet: async (key) => (store.has(key) ? store.get(key) : null),
    sharedSet: async (key, value) => { store.set(key, value); },
    log: () => {},
});

const { getInventoryStats } = require(path.join(LIB, "inventoryStats.js"));
const KEY = "amber:invstats:aggregate";

function countResponse(count) {
    return { data: { data: { meta: { count } } } };
}
function reset() {
    store.clear();
    amberCalls.length = 0;
    amberImpl = async () => ({ data: null });
}

(async () => {
    console.log("verify-inventory-stats");

    await test("TEST 1 fresh cached aggregate is served without any Amber request", async () => {
        reset();
        store.set(KEY, { total: 10, soldOut: 4, remaining: 6, computedAt: Date.now() });
        const r = await getInventoryStats();
        assert.deepStrictEqual(r, { ready: true, total: 10, soldOut: 4, remaining: 6, stale: false });
        assert.strictEqual(amberCalls.length, 0);
    });

    await test("TEST 2 cache miss -> two count-only LOW requests; total = soldOut + remaining", async () => {
        reset();
        amberImpl = async ({ params }) => countResponse(params.available ? 3221 : 1060);
        const r = await getInventoryStats();
        assert.deepStrictEqual(r, { ready: true, total: 4281, soldOut: 1060, remaining: 3221, stale: false });
        assert.strictEqual(r.total, r.soldOut + r.remaining);
        assert.strictEqual(amberCalls.length, 2);
        for (const c of amberCalls) {
            assert.strictEqual(c.type, "listings");
            assert.strictEqual(c.priority, "LOW");
            assert.strictEqual(c.params.limit, 1);
            assert.strictEqual(c.params.page, 1);
        }
        assert.deepStrictEqual(amberCalls.map((c) => c.params.available).sort(), [false, true]);
        // Persisted for every other visitor (and /api/insights/snapshot).
        assert.strictEqual(store.get(KEY).total, 4281);

        // A second call inside the freshness window reuses it — no new requests.
        await getInventoryStats();
        assert.strictEqual(amberCalls.length, 2);
    });

    await test("TEST 3 an unavailable count is never reported as 0", async () => {
        reset();
        amberImpl = async ({ params }) => (params.available ? countResponse(3221) : { data: null });
        const none = await getInventoryStats();
        assert.deepStrictEqual(none, { ready: false });

        reset();
        store.set(KEY, { total: 9, soldOut: 3, remaining: 6, computedAt: Date.now() - 10 * 60 * 1000 });
        amberImpl = async () => ({ data: null });
        const stale = await getInventoryStats();
        assert.deepStrictEqual(stale, { ready: true, total: 9, soldOut: 3, remaining: 6, stale: true });
    });

    await test("TEST 4 gateway failure degrades to stale aggregate or ready:false, never throws", async () => {
        reset();
        amberImpl = async () => { throw new Error("Amber cooldown"); };
        assert.deepStrictEqual(await getInventoryStats(), { ready: false });

        store.set(KEY, { total: 9, soldOut: 3, remaining: 6, computedAt: Date.now() - 10 * 60 * 1000 });
        assert.deepStrictEqual(await getInventoryStats(), { ready: true, total: 9, soldOut: 3, remaining: 6, stale: true });
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
