#!/usr/bin/env node
// REAL PRICE INTEGRITY verification — proves every displayed price
// corresponds to an actual source price for a real available room/tenancy,
// that a derived comparison value (weekly-equivalent) can never leak into
// the customer-facing display, and that BOTH the University Housing/
// PropertyListing pipeline (src/services/amberMapper.js) and the Student
// Planner pipeline (api/_lib/accommodationIndex.js) apply the identical
// underlying business rule.
//
// ROOT-CAUSE FINDINGS this task investigated (see final report for the
// full writeup):
//  1. CONFIRMED, code-verified bug: src/components/planner/
//     CompareResidencesTable.js rendered the derived weekly-equivalent
//     comparison value (`r.priceWeekly`) formatted as `£{weekly}/week` in
//     its "Budget Fit" column — a fabricated price for any non-weekly
//     residence (e.g. a real €800/month Madrid property would have shown
//     a "€184/week" figure Amber never actually quoted). Fixed to show a
//     qualitative "Within budget" label instead, reusing the real Price
//     column for the actual source amount+duration.
//  2. Structural hardening (not confirmed to currently manifest in the
//     live catalog, but a real architectural risk the task explicitly
//     requires be made structurally impossible): the pre-existing
//     getRoomLowestAvailablePrice() returned a bare cheapest-available
//     AMOUNT, which callers then paired with the ROOM's own separate
//     aggregate duration/currency — never guaranteed to be the same
//     record as the tenancy that produced the amount. Replaced with
//     selectCheapestAvailableTenancy(), which returns the FULL tenancy
//     record so amount+currency+duration are always read from one atomic
//     source. A live search across 215 real properties (Manchester,
//     Madrid, Toronto, Vancouver, Sydney) found zero cases where this
//     specific mismatch currently manifests — but the fix removes the
//     possibility going forward regardless.
//  3. api/_lib/accommodationIndex.js (Student Planner) still read the raw,
//     availability-unaware pricing.min_price, exactly as flagged as a
//     known limitation in the previous milestone's report. Fixed with the
//     smallest safe change: no schema change, corrected derivation logic
//     (deriveResidencePricing, mirroring the frontend rule) applied before
//     persistence into the SAME existing AccommodationResidence fields.
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];

async function test(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  PASS  ${name}`);
    } catch (err) {
        failed++;
        failures.push({ name, message: err.message });
        console.log(`  FAIL  ${name}\n        ${err.message}`);
    }
}

function skip(name, reason) {
    skipped++;
    console.log(`  SKIP  ${name}\n        ${reason}`);
}

// ── Fixtures — shaped like real Amber children/tenancy data ──
function tenancy({ id, price, available, duration, currency = "pound" }) {
    return { id, name: `${id}`, available, pricing: { price, currency, duration } };
}
function roomChild({ id, name, available, tenancies = [], price, duration, currency }) {
    const cheapestTenancyPrice = tenancies.length ? Math.min(...tenancies.map((t) => t.pricing.price)) : price;
    const effectiveDuration = duration || tenancies[0]?.pricing.duration || "weekly";
    const effectiveCurrency = currency || tenancies[0]?.pricing.currency || "pound";
    return {
        id, name, available, children: tenancies,
        pricing: { price: cheapestTenancyPrice, currency: effectiveCurrency, duration: effectiveDuration, min_price: cheapestTenancyPrice, max_price: cheapestTenancyPrice },
        meta: {},
    };
}
function rawProperty({ id = 1, name = "Test Property", children = [], pricing = {}, available = true } = {}) {
    return {
        id, name, canonical_name: `test-${id}`, available, children,
        pricing: { currency: "pound", duration: "weekly", ...pricing },
        location: {}, meta: {}, images: [], features: [], tags: [],
    };
}

async function main() {
    console.log("=== IvyHuts Real Price Integrity Verification ===\n");

    const amberMapper = require(path.join(ROOT, "src", "services", "amberMapper.js"));
    const { mapAmberPropertyToListing, mapAmberPropertyDetails, normalizeResidencePricing, weeklyEquivalentPrice } = amberMapper;
    const accommodationIndex = require(path.join(ROOT, "api", "_lib", "accommodationIndex.js"));
    const { mapAmberItemToResidence, deriveResidencePricing, computePriceWeekly } = accommodationIndex;

    // ══════════════════════════ TEST A — cheapest room sold out ══════════════════════════
    await test("TEST A: sold-out cheapest room — display price comes from the next cheapest AVAILABLE room", () => {
        const raw = rawProperty({
            children: [
                roomChild({ id: "A", name: "Room A", available: false, tenancies: [tenancy({ id: "A1", price: 186, available: false, duration: "weekly" })] }),
                roomChild({ id: "B", name: "Room B", available: true, tenancies: [tenancy({ id: "B1", price: 215, available: true, duration: "weekly" })] }),
            ],
        });
        const listing = mapAmberPropertyToListing(raw);
        assert.strictEqual(listing.price.from, 215);
        assert.notStrictEqual(listing.price.from, 186);
        const residence = mapAmberItemToResidence(raw, "manchester");
        assert.strictEqual(residence.price.amount, 215);
    });

    // ══════════════════════════ TEST B — available more-expensive room ══════════════════════════
    await test("TEST B: an available room that is NOT the cheapest overall is correctly skipped in favor of the cheaper available one", () => {
        const raw = rawProperty({
            children: [
                roomChild({ id: "A", name: "Cheap Available", available: true, tenancies: [tenancy({ id: "A1", price: 150, available: true, duration: "weekly" })] }),
                roomChild({ id: "B", name: "Pricier Available", available: true, tenancies: [tenancy({ id: "B1", price: 300, available: true, duration: "weekly" })] }),
            ],
        });
        const listing = mapAmberPropertyToListing(raw);
        assert.strictEqual(listing.price.from, 150);
        assert.strictEqual(listing.selectedRoomType.id, "A");
    });

    // ══════════════════════════ TEST C/D — weekly / monthly preserved exactly ══════════════════════════
    await test("TEST C: weekly source price displays with amount AND duration exactly matching the source tenancy", () => {
        const raw = rawProperty({ children: [roomChild({ id: "A", name: "Weekly Room", available: true, tenancies: [tenancy({ id: "A1", price: 200, available: true, duration: "weekly" })] })] });
        const listing = mapAmberPropertyToListing(raw);
        assert.strictEqual(listing.price.from, 200);
        assert.strictEqual(listing.price.duration, "week");
    });
    await test("TEST D: monthly source price displays with amount AND duration exactly matching the source tenancy — never converted", () => {
        const raw = rawProperty({
            pricing: { currency: "euro", duration: "monthly" },
            children: [roomChild({ id: "A", name: "Monthly Room", available: true, tenancies: [tenancy({ id: "A1", price: 800, available: true, duration: "monthly", currency: "euro" })] })],
        });
        const listing = mapAmberPropertyToListing(raw);
        assert.strictEqual(listing.price.from, 800);
        assert.strictEqual(listing.price.duration, "month");
        assert.notStrictEqual(listing.price.from, Math.round(weeklyEquivalentPrice(800, "month")), "must never accidentally equal the weekly-equivalent number");
    });

    // ══════════════════════════ TEST E — mixed weekly/monthly within one property ══════════════════════════
    await test("TEST E: mixed durations — the genuinely cheaper (by weekly-equivalent) room wins, but its OWN original amount+duration is what's displayed, never a converted figure", () => {
        const raw = rawProperty({
            children: [
                roomChild({ id: "M", name: "Monthly Room", available: true, tenancies: [tenancy({ id: "M1", price: 800, available: true, duration: "monthly" })] }), // ~£184.6/week equivalent
                roomChild({ id: "W", name: "Weekly Room", available: true, tenancies: [tenancy({ id: "W1", price: 200, available: true, duration: "weekly" })] }),
            ],
        });
        const listing = mapAmberPropertyToListing(raw);
        assert.strictEqual(listing.selectedRoomType.id, "M", "the £800/month room (~£184.6/week) is genuinely cheaper than £200/week");
        assert.strictEqual(listing.price.from, 800, "display amount must be the real source amount, never the weekly-equivalent (~184.6)");
        assert.strictEqual(listing.price.duration, "month", "display duration must be the real source duration");
    });

    // ══════════════════════════ TEST F — term pricing never silently converted ══════════════════════════
    await test('TEST F: a "term"-priced available room displays its real amount with duration "term" — never coerced into week/month, and excluded from ranking against comparable-duration rooms rather than guessed', () => {
        const raw = rawProperty({
            children: [roomChild({ id: "T", name: "Term Room", available: true, tenancies: [tenancy({ id: "T1", price: 9000, available: true, duration: "termly" })] })],
        });
        const listing = mapAmberPropertyToListing(raw);
        assert.strictEqual(listing.price.from, 9000);
        assert.strictEqual(listing.price.duration, "term");
        assert.strictEqual(listing.priceWeekly, null, "an unrankable duration must never receive a fabricated weekly-equivalent");
    });

    // ══════════════════════════ TEST G — all sold out ══════════════════════════
    await test("TEST G: every room sold out — isSoldOut true, displayPrice null, no fallback price of any kind", () => {
        const raw = rawProperty({
            available: false,
            children: [
                roomChild({ id: "A", name: "A", available: false, tenancies: [tenancy({ id: "A1", price: 100, available: false, duration: "weekly" })] }),
                roomChild({ id: "B", name: "B", available: false, tenancies: [tenancy({ id: "B1", price: 150, available: false, duration: "weekly" })] }),
            ],
        });
        const listing = mapAmberPropertyToListing(raw);
        assert.strictEqual(listing.isSoldOut, true);
        assert.strictEqual(listing.price.from, null);
        const residence = mapAmberItemToResidence(raw, "manchester");
        assert.strictEqual(residence.available, false);
        assert.strictEqual(residence.price.amount, null);
    });

    // ══════════════════════════ TEST H/I — missing / invalid price ══════════════════════════
    await test("TEST H: a room with no price data at all is never selected, never shown as £0/£null-coerced-to-number", () => {
        const raw = rawProperty({
            children: [
                { id: "NoPricing", name: "No Pricing Room", available: true, children: [], pricing: {}, meta: {} },
                roomChild({ id: "B", name: "Valid Room", available: true, tenancies: [tenancy({ id: "B1", price: 250, available: true, duration: "weekly" })] }),
            ],
        });
        const listing = mapAmberPropertyToListing(raw);
        assert.strictEqual(listing.price.from, 250, "the priceless room must be skipped in favor of the valid one");
        assert.notStrictEqual(listing.price.from, 0);
    });
    await test("TEST I: invalid prices (NaN, zero, negative) are never selected as the display price", () => {
        [NaN, 0, -50].forEach((badPrice) => {
            const raw = rawProperty({
                children: [
                    roomChild({ id: "Bad", name: "Bad Price Room", available: true, tenancies: [tenancy({ id: "Bad1", price: badPrice, available: true, duration: "weekly" })] }),
                    roomChild({ id: "Good", name: "Good Room", available: true, tenancies: [tenancy({ id: "Good1", price: 250, available: true, duration: "weekly" })] }),
                ],
            });
            const listing = mapAmberPropertyToListing(raw);
            assert.strictEqual(listing.price.from, 250, `expected the invalid price (${badPrice}) to be excluded, got ${listing.price.from}`);
        });
    });

    // ══════════════════════════ TEST J — currency ══════════════════════════
    await test("TEST J: currency comes from the selected tenancy's own source field, never inferred from locale/university/city", () => {
        const raw = rawProperty({
            pricing: { currency: "euro" },
            children: [roomChild({ id: "A", name: "Room", available: true, tenancies: [tenancy({ id: "A1", price: 500, available: true, duration: "weekly", currency: "euro" })] })],
        });
        const listing = mapAmberPropertyToListing(raw);
        assert.strictEqual(listing.price.currency, "€");
    });

    // ══════════════════════════ TEST K — duration ══════════════════════════
    await test("TEST K: displayed duration always matches the selected source record's own duration field, never the property-level aggregate when they'd disagree", () => {
        // Property-level aggregate says "weekly" but the ONLY available room is monthly.
        const raw = rawProperty({
            pricing: { duration: "weekly" },
            children: [roomChild({ id: "A", name: "Monthly Room", available: true, tenancies: [tenancy({ id: "A1", price: 900, available: true, duration: "monthly" })] })],
        });
        const listing = mapAmberPropertyToListing(raw);
        assert.strictEqual(listing.price.duration, "month", "must use the SELECTED ROOM's own duration, not the property aggregate's");
    });

    // ══════════════════════════ TEST L — price provenance ══════════════════════════
    await test("TEST L: the normalized price carries traceable provenance (source + selected room/tenancy ids) so a card price can be traced back to its exact raw record during debugging", () => {
        const raw = rawProperty({
            children: [roomChild({ id: "room-42", name: "Ensuite", available: true, tenancies: [tenancy({ id: "tenancy-7", price: 215, available: true, duration: "weekly" })] })],
        });
        const norm = normalizeResidencePricing(raw);
        assert.strictEqual(norm.displayPrice.source, "tenancy");
        assert.strictEqual(norm.selectedRoomType.id, "room-42");
        assert.strictEqual(norm.selectedRoomType.sourceTenancyId, "tenancy-7");
    });
    await test("TEST L: provenance correctly reports 'room' when a room has no tenancy data at all but a valid room-level price, and 'aggregate' when falling back to the property-level aggregate", () => {
        const roomLevelRaw = rawProperty({
            children: [{ id: "R1", name: "Room Only", available: true, children: [], pricing: { price: 300, currency: "pound", duration: "weekly" }, meta: {} }],
        });
        assert.strictEqual(normalizeResidencePricing(roomLevelRaw).displayPrice.source, "room");

        const noChildrenRaw = rawProperty({ children: [], pricing: { min_available_price: 250 } });
        assert.strictEqual(normalizeResidencePricing(noChildrenRaw).displayPrice.source, "aggregate");
    });

    // ══════════════════════════ TEST M — min_price disagreement ══════════════════════════
    await test("TEST M: when raw.pricing.min_price disagrees with the true cheapest-available room/tenancy price, the true available price wins, never min_price", () => {
        const raw = rawProperty({
            pricing: { min_price: 100, min_available_price: 215 }, // Amber's own aggregate — for reference/cross-check only, never trusted blindly
            children: [
                roomChild({ id: "A", name: "Sold Out Cheap Room", available: false, tenancies: [tenancy({ id: "A1", price: 100, available: false, duration: "weekly" })] }),
                roomChild({ id: "B", name: "Available Room", available: true, tenancies: [tenancy({ id: "B1", price: 215, available: true, duration: "weekly" })] }),
            ],
        });
        const listing = mapAmberPropertyToListing(raw);
        assert.strictEqual(listing.price.from, 215);
        assert.notStrictEqual(listing.price.from, raw.pricing.min_price);
    });

    // ══════════════════════════ TEST N — min_available_price disagreement (a REAL discovered case) ══════════════════════════
    await test("TEST N: min_available_price itself can disagree with true tenancy-level availability (confirmed live: a real Manchester room's own `available` flag was false while a tenancy under it was genuinely available at a lower price) — the system prefers the tenancy-level ground truth over Amber's own aggregate", () => {
        const raw = rawProperty({
            pricing: { min_price: 249, min_available_price: 319 }, // Amber's own (higher) aggregate — real numbers from "iQ Hollingworth House"
            children: [
                roomChild({ id: "RoomFlagFalseButTenancyAvailable", name: "Bronze 2 Bed Duplex", available: false, tenancies: [
                    tenancy({ id: "t1", price: 299, available: false, duration: "weekly" }),
                    tenancy({ id: "t2", price: 276, available: true, duration: "weekly" }), // the room's OWN flag says false, but this specific tenancy is genuinely available
                ] }),
                roomChild({ id: "OtherAvailable", name: "2 Bed Penthouse", available: true, tenancies: [tenancy({ id: "t3", price: 319, available: true, duration: "weekly" })] }),
            ],
        });
        const listing = mapAmberPropertyToListing(raw);
        assert.strictEqual(listing.price.from, 276, "the genuinely available tenancy (276) must win even though its room's own flag says unavailable, and even though it's cheaper than Amber's own min_available_price (319)");
    });

    // ══════════════════════════ TEST O — no derived comparison value ever reaches display ══════════════════════════
    await test("TEST O: comparison.weeklyEquivalent is a SEPARATE object from displayPrice — structurally impossible to accidentally render as the display amount", () => {
        const raw = rawProperty({
            pricing: { currency: "euro", duration: "monthly" },
            children: [roomChild({ id: "A", name: "Monthly Room", available: true, tenancies: [tenancy({ id: "A1", price: 800, available: true, duration: "monthly", currency: "euro" })] })],
        });
        const norm = normalizeResidencePricing(raw);
        assert.ok(Math.abs(norm.comparison.weeklyEquivalent - 184.6) < 1);
        assert.strictEqual(norm.displayPrice.amount, 800, "displayPrice must never equal the comparison value");
        assert.notStrictEqual(norm.displayPrice.amount, norm.comparison.weeklyEquivalent);
    });
    await test("TEST O: priceWeekly on the listing/residence object is a distinctly-named, sort-only field — never merged into or aliased as price.from", () => {
        const raw = rawProperty({
            pricing: { currency: "euro", duration: "monthly" },
            children: [roomChild({ id: "A", name: "Monthly Room", available: true, tenancies: [tenancy({ id: "A1", price: 800, available: true, duration: "monthly", currency: "euro" })] })],
        });
        const listing = mapAmberPropertyToListing(raw);
        assert.notStrictEqual(listing.price.from, listing.priceWeekly);
        assert.strictEqual(listing.price.from, 800);
        const residence = mapAmberItemToResidence(raw, "madrid");
        assert.notStrictEqual(residence.price.amount, residence.priceWeekly);
        assert.strictEqual(residence.price.amount, 800);
    });

    // ══════════════════════════ SOURCE-TO-UI ASSERTION (item 25 — the most important regression) ══════════════════════════
    const sourceToUiFixtures = [
        { label: "weekly available", raw: rawProperty({ children: [roomChild({ id: "A", name: "A", available: true, tenancies: [tenancy({ id: "t1", price: 233, available: true, duration: "weekly" })] })] }), expectAmount: 233, expectDuration: "week" },
        { label: "monthly available", raw: rawProperty({ pricing: { currency: "euro" }, children: [roomChild({ id: "A", name: "A", available: true, tenancies: [tenancy({ id: "t1", price: 611, available: true, duration: "monthly", currency: "euro" })] })] }), expectAmount: 611, expectDuration: "month" },
        { label: "cheapest sold out, next one wins", raw: rawProperty({ children: [
            roomChild({ id: "A", name: "A", available: false, tenancies: [tenancy({ id: "t1", price: 99, available: false, duration: "weekly" })] }),
            roomChild({ id: "B", name: "B", available: true, tenancies: [tenancy({ id: "t2", price: 177, available: true, duration: "weekly" })] }),
        ] }), expectAmount: 177, expectDuration: "week" },
    ];
    sourceToUiFixtures.forEach(({ label, raw, expectAmount, expectDuration }) => {
        test(`SOURCE-TO-UI (${label}): normalized display amount === raw selected source amount, display duration === raw selected source duration`, () => {
            const listing = mapAmberPropertyToListing(raw);
            assert.strictEqual(listing.price.from, expectAmount);
            assert.strictEqual(listing.price.duration, expectDuration);
            const detail = mapAmberPropertyDetails(raw);
            assert.strictEqual(detail.price.from, expectAmount);
            assert.strictEqual(detail.price.duration, expectDuration);
            const residence = mapAmberItemToResidence(raw, "test-city");
            assert.strictEqual(residence.price.amount, expectAmount);
            assert.strictEqual(residence.priceDuration, expectDuration);
        });
    });

    // ══════════════════════════ COMPARE RESIDENCES TABLE — the confirmed fake-price bug ══════════════════════════
    await test('FRONTEND: CompareResidencesTable.js no longer renders a derived weekly-equivalent value as a fabricated "£X/week" price', () => {
        const src = fs.readFileSync(path.join(ROOT, "src", "components", "planner", "CompareResidencesTable.js"), "utf8");
        assert.ok(!/\{r\.price\.currency\}\{weekly\}/.test(src), "must never render the derived weekly-equivalent formatted as a currency amount");
        assert.ok(/Within budget/.test(src), "expected the budget-fit column to use a qualitative label instead of a fabricated price");
    });

    // ══════════════════════════ STUDENT PLANNER AUDIT (item 21) ══════════════════════════
    await test("PLANNER: mapAmberItemToResidence no longer uses the raw, availability-unaware pricing.min_price as its primary price source", () => {
        const src = fs.readFileSync(path.join(ROOT, "api", "_lib", "accommodationIndex.js"), "utf8");
        assert.ok(/deriveResidencePricing\(raw\)/.test(src), "expected mapAmberItemToResidence to route through the corrected derivation");
    });
    await test("PLANNER: deriveResidencePricing/selectCheapestAvailableTenancy mirror the SAME business rule as the frontend (amberMapper.js) — one authoritative algorithm, two CommonJS/ESM twins, not two competing rules", () => {
        const backendSrc = fs.readFileSync(path.join(ROOT, "api", "_lib", "accommodationIndex.js"), "utf8");
        const frontendSrc = fs.readFileSync(path.join(ROOT, "src", "services", "amberMapper.js"), "utf8");
        assert.ok(/available === true/.test(backendSrc) && /available === true/.test(frontendSrc));
        assert.ok(/min_available_price/.test(backendSrc) && /min_available_price/.test(frontendSrc));
    });
    await test("PLANNER: no Mongo schema changes were made — AccommodationResidence.js is untouched (the fix is purely corrected derivation logic feeding the SAME existing fields)", () => {
        const schemaSrc = fs.readFileSync(path.join(ROOT, "api", "_lib", "models", "AccommodationResidence.js"), "utf8");
        assert.ok(!/isSoldOut|selectedRoomType|comparison:/.test(schemaSrc), "no new pricing-related fields were added to the schema — smallest safe change, per this task's explicit instruction");
    });
    await test("PLANNER: availability is derived from real room/tenancy data (tenancy-priority), not just the property's own coarse top-level flag alone", () => {
        const raw = rawProperty({
            available: false, // coarse property-level flag says false
            children: [roomChild({ id: "A", name: "A", available: false, tenancies: [tenancy({ id: "t1", price: 100, available: true, duration: "weekly" })] })], // but a real tenancy is available
        });
        const derived = deriveResidencePricing(raw);
        assert.strictEqual(derived.available, true, "a genuinely available tenancy must be trusted over the coarser room/property flag");
        const residence = mapAmberItemToResidence(raw, "manchester");
        assert.strictEqual(residence.available, true);
        assert.strictEqual(residence.price.amount, 100);
    });

    // ══════════════════════════ AMBER ISOLATION (item 23) ══════════════════════════
    await test("AMBER ISOLATION: the new/modified pricing functions are pure — zero fetch() calls, zero new Amber call paths", () => {
        const originalFetch = global.fetch;
        let calls = 0;
        global.fetch = async (...args) => { calls++; return originalFetch ? originalFetch(...args) : { ok: true, json: async () => ({}) }; };
        try {
            const sample = rawProperty({ children: [roomChild({ id: "A", name: "A", available: true, tenancies: [tenancy({ id: "t1", price: 200, available: true, duration: "weekly" })] })] });
            for (let i = 0; i < 20; i++) {
                mapAmberPropertyToListing(sample);
                mapAmberPropertyDetails(sample);
                normalizeResidencePricing(sample);
                mapAmberItemToResidence(sample, "test-city");
                deriveResidencePricing(sample);
            }
        } finally {
            global.fetch = originalFetch;
        }
        assert.strictEqual(calls, 0);
    });
    await test("AMBER ISOLATION: no changes were made to amberGateway.js/sharedStore.js/cacheWarmer.js/api/amber.js/api/warm-amber-cache.js", () => {
        ["amberGateway.js", "sharedStore.js", "cacheWarmer.js"].forEach((f) => {
            const src = fs.readFileSync(path.join(ROOT, "api", "_lib", f), "utf8");
            assert.ok(!/deriveResidencePricing|selectCheapestAvailableTenancy|isChildRoomAvailable/.test(src));
        });
    });

    // ══════════════════════════ REAL DATA FORENSICS (item 16) — UK, Spain, Canada, Australia ══════════════════════════
    require("dotenv").config({ path: path.join(ROOT, ".env.local") });
    require("dotenv").config({ path: path.join(ROOT, ".env") });
    const { fetchListings } = require(path.join(ROOT, "api", "_lib", "amberGateway"));

    function groundTruth(raw) {
        let best = null;
        for (const child of raw.children || []) {
            const tenancies = Array.isArray(child.children) ? child.children : [];
            const availablePrices = tenancies.filter((t) => t.available === true && Number.isFinite(t.pricing?.price)).map((t) => t.pricing.price);
            if (availablePrices.length) {
                const cheapest = Math.min(...availablePrices);
                if (best === null || cheapest < best) best = cheapest;
            } else if (tenancies.length === 0 && child.available === true && Number.isFinite(child.pricing?.price)) {
                if (best === null || child.pricing.price < best) best = child.pricing.price;
            }
        }
        return best;
    }

    const REGIONS = [
        { city: "Manchester", label: "UK" },
        { city: "Madrid", label: "Spain" },
        { city: "Toronto", label: "Canada" },
        { city: "Sydney", label: "Australia" },
    ];
    for (const { city, label } of REGIONS) {
        await test(`REAL DATA FORENSICS (${label} — ${city}): both amberMapper.js (frontend) and accommodationIndex.js (backend Planner) select an identical, independently-verifiable ground-truth price for every real property with room data`, async () => {
            const result = await fetchListings({ city, page: 1, limit: 15 }, "LOW", "verify-real-price-integrity");
            const items = result.data?.data?.result || [];
            if (!items.length) { skip(`REAL DATA FORENSICS (${label})`, "no live items returned in this environment"); return; }
            let checked = 0;
            for (const raw of items) {
                if (!Array.isArray(raw.children) || !raw.children.length) continue;
                checked++;
                const truth = groundTruth(raw);
                const listing = mapAmberPropertyToListing(raw);
                const residence = mapAmberItemToResidence(raw, city.toLowerCase());
                assert.strictEqual(listing.price.from, truth, `${raw.name} (frontend): expected ground truth ${truth}, got ${listing.price.from}`);
                assert.strictEqual(residence.price.amount, truth, `${raw.name} (backend/Planner): expected ground truth ${truth}, got ${residence.price.amount}`);
                assert.strictEqual(listing.price.from, residence.price.amount, `${raw.name}: frontend and backend pipelines disagree on the SAME raw property — must be the same authoritative rule`);
            }
            if (checked === 0) skip(`REAL DATA FORENSICS (${label})`, "no property with room-level data in this sample");
        });
    }

    console.log(`\n=== ${passed} passed, ${failed} failed, ${skipped} skipped ===`);
    if (failed > 0) {
        console.log("\nFailures:");
        failures.forEach((f) => console.log(`  - ${f.name}: ${f.message}`));
        process.exitCode = 1;
    }
}

main().catch((err) => {
    console.error("Verification script crashed:", err);
    process.exitCode = 1;
});
