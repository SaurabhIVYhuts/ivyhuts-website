// Student Planner Living Cost layer (Milestone 4). Completely independent of
// Amber/amberGateway.js: this file makes zero network calls and has zero
// imports from accommodationIndex.js or amberGateway.js — it only reads a
// curated, in-repo dataset. The only place Amber-derived data enters a
// livingExpenses result is the ACCOMMODATION figure the caller
// (api/student-planner.js) passes in, already computed by
// accommodationIndex.js's own price-duration normalization
// (residence.priceMonthly) — this module never re-derives or guesses it.
//
// No live cost-of-living API is connected. This repo has no existing cost
// dataset (checked before writing this file), and a genuinely reliable,
// free, commercially-usable-at-scale, per-city cost-of-living API for a
// small UK-first student housing product is not an obvious win over a small
// transparent curated table for a first milestone — so the values below are
// EXPLICITLY labeled `source: "internal-estimate"` (see CURATED_CITY_COSTS
// below), not presented as official statistics. Swapping this module's
// internals for a live provider later requires no change to its callers —
// getLivingExpenses()'s signature/return shape is the only contract that
// matters.
"use strict";

// Monthly, in the city's local currency, per full-time student — broad,
// deliberately round planning figures (not a precise survey), refreshed by
// hand. Every entry documents where its ballpark comes from and when it was
// last reviewed, so this is checkable/updatable, not a black box.
const SOURCE = "internal-estimate";
const SOURCE_UPDATED_AT = "2026-08-11";

const CURRENCY_BY_COUNTRY = {
    "united kingdom": "£",
    canada: "CA$",
    australia: "A$",
};

// Keyed by amberGateway's normalizeCityName() output, so the same
// normalization the rest of the planner already uses also decides which row
// this reads — no second, diverging notion of "same city".
const CURATED_CITY_COSTS = {
    // United Kingdom — the app's real Amber-backed markets (same 12 cities
    // as cacheWarmer.js's WARM_TARGET_CITIES). London is priced meaningfully
    // higher than the rest, matching widely-known UK student cost guidance;
    // every other UK city sits in a fairly tight band.
    london: { foodMonthly: 350, transportMonthly: 150, utilitiesMonthly: 90, personalMonthly: 150, otherMonthly: 60 },
    manchester: { foodMonthly: 260, transportMonthly: 70, utilitiesMonthly: 70, personalMonthly: 120, otherMonthly: 45 },
    birmingham: { foodMonthly: 250, transportMonthly: 65, utilitiesMonthly: 70, personalMonthly: 115, otherMonthly: 45 },
    coventry: { foodMonthly: 240, transportMonthly: 55, utilitiesMonthly: 65, personalMonthly: 110, otherMonthly: 40 },
    leeds: { foodMonthly: 250, transportMonthly: 60, utilitiesMonthly: 68, personalMonthly: 115, otherMonthly: 42 },
    liverpool: { foodMonthly: 235, transportMonthly: 55, utilitiesMonthly: 65, personalMonthly: 105, otherMonthly: 40 },
    sheffield: { foodMonthly: 230, transportMonthly: 50, utilitiesMonthly: 62, personalMonthly: 100, otherMonthly: 38 },
    glasgow: { foodMonthly: 245, transportMonthly: 65, utilitiesMonthly: 70, personalMonthly: 110, otherMonthly: 42 },
    nottingham: { foodMonthly: 240, transportMonthly: 55, utilitiesMonthly: 65, personalMonthly: 108, otherMonthly: 40 },
    "newcastle upon tyne": { foodMonthly: 230, transportMonthly: 55, utilitiesMonthly: 62, personalMonthly: 100, otherMonthly: 38 },
    leicester: { foodMonthly: 235, transportMonthly: 52, utilitiesMonthly: 63, personalMonthly: 105, otherMonthly: 38 },
    exeter: { foodMonthly: 250, transportMonthly: 60, utilitiesMonthly: 68, personalMonthly: 115, otherMonthly: 42 },
    // Canada / Australia — the non-UK cities present in src/data/universities.json.
    // Amber has no inventory in these markets (UK-only), so accommodation
    // for these will typically be null/estimate-free here; food/transport/
    // utilities/personal/other still give the student a usable planning
    // figure independent of residence data.
    toronto: { foodMonthly: 420, transportMonthly: 156, utilitiesMonthly: 100, personalMonthly: 180, otherMonthly: 70 },
    vancouver: { foodMonthly: 430, transportMonthly: 130, utilitiesMonthly: 95, personalMonthly: 180, otherMonthly: 70 },
    ottawa: { foodMonthly: 380, transportMonthly: 120, utilitiesMonthly: 90, personalMonthly: 160, otherMonthly: 60 },
    sydney: { foodMonthly: 500, transportMonthly: 150, utilitiesMonthly: 120, personalMonthly: 200, otherMonthly: 80 },
};

// Generic fallback when the city isn't one of the curated rows above —
// still country-aware (currency + a country-level ballpark), never a guess
// at a specific city's real cost of living. `matched: false` on the
// returned row tells the caller/UI this is the broader fallback, not a
// city-specific figure.
const COUNTRY_FALLBACK = {
    "united kingdom": { foodMonthly: 245, transportMonthly: 60, utilitiesMonthly: 68, personalMonthly: 110, otherMonthly: 42 },
    canada: { foodMonthly: 400, transportMonthly: 130, utilitiesMonthly: 95, personalMonthly: 170, otherMonthly: 65 },
    australia: { foodMonthly: 460, transportMonthly: 140, utilitiesMonthly: 110, personalMonthly: 190, otherMonthly: 75 },
};
const WORLD_FALLBACK = { foodMonthly: 300, transportMonthly: 80, utilitiesMonthly: 80, personalMonthly: 130, otherMonthly: 50 };

function normalizeKey(str) {
    return String(str || "").trim().toLowerCase().replace(/\s+/g, " ");
}

// Read-only lookup — no network, no Amber, no Mongo. Always returns a usable
// row (curated city match, else country fallback, else world fallback) so
// callers never have to special-case "no data at all"; `matched` tells the
// UI/report which tier was used.
function getCityLivingCost(city, country) {
    const cityKey = normalizeKey(city);
    const countryKey = normalizeKey(country);
    const currency = CURRENCY_BY_COUNTRY[countryKey] || "£";

    const cityRow = CURATED_CITY_COSTS[cityKey];
    if (cityRow) {
        return { city: city || null, country: country || null, currency, ...cityRow, source: SOURCE, sourceUpdatedAt: SOURCE_UPDATED_AT, matched: true };
    }
    const countryRow = COUNTRY_FALLBACK[countryKey];
    const row = countryRow || WORLD_FALLBACK;
    return { city: city || null, country: country || null, currency, ...row, source: SOURCE, sourceUpdatedAt: SOURCE_UPDATED_AT, matched: false };
}

// Planning-estimate multipliers, applied to the total, not per-category —
// the curated dataset isn't granular enough to vary food/transport/etc.
// independently per scenario, and pretending otherwise would overstate its
// precision. Fixed constants -> deterministic output for the same inputs
// (see scripts/verify-planner-accommodation-index.js's COST tests).
const SCENARIO_MULTIPLIERS = { budget: 0.85, average: 1, comfortable: 1.2 };

function roundOrNull(n) {
    return Number.isFinite(n) ? Math.round(n) : null;
}

/**
 * The Living Cost layer's one entry point.
 * @param {{city: string, country: string, accommodationMonthly: number|null}} args
 *   `accommodationMonthly` — already-normalized monthly accommodation cost
 *   from the recommended residence (accommodationIndex.js's
 *   priceMonthly), or null when no residence/normalizable price is
 *   available. Never fabricated here — see the comment on `accommodation`
 *   below for what happens when it's null.
 * @param {{amount: number, period: "weekly"}|null} [budget] — the student's
 *   supplied accommodation budget, for the budget-fit comparison (item 16).
 *   Purely pass-through/labeling here; the actual per-residence fit check
 *   lives with the residences themselves (they carry priceWeekly already).
 */
function getLivingExpenses({ city, country, accommodationMonthly = null }) {
    const cost = getCityLivingCost(city, country);
    const { currency, foodMonthly, transportMonthly, utilitiesMonthly, personalMonthly, otherMonthly, source, sourceUpdatedAt, matched } = cost;

    const knownNonAccommodation = foodMonthly + transportMonthly + utilitiesMonthly + personalMonthly + otherMonthly;
    const accommodation = Number.isFinite(accommodationMonthly) ? Math.round(accommodationMonthly) : null;

    // A total that silently omitted accommodation (its largest single line)
    // would be misleading, not just incomplete — so the total/annual/
    // scenarios stay honestly null until a real, normalizable accommodation
    // figure is available, exactly like this codebase's existing "null,
    // never guessed" rule for unrecognized price durations.
    const totalMonthly = accommodation != null ? accommodation + knownNonAccommodation : null;
    const totalAnnual = totalMonthly != null ? totalMonthly * 12 : null;

    const scenarios = totalMonthly != null
        ? {
            budget: roundOrNull(totalMonthly * SCENARIO_MULTIPLIERS.budget),
            average: roundOrNull(totalMonthly * SCENARIO_MULTIPLIERS.average),
            comfortable: roundOrNull(totalMonthly * SCENARIO_MULTIPLIERS.comfortable),
        }
        : null;

    return {
        currency,
        accommodation,
        food: foodMonthly,
        transport: transportMonthly,
        utilities: utilitiesMonthly,
        personal: personalMonthly,
        other: otherMonthly,
        totalMonthly,
        totalAnnual,
        scenarios,
        meta: { source, sourceUpdatedAt, cityMatched: matched, note: "Estimated planning figures, not official statistics." },
    };
}

module.exports = { getLivingExpenses, getCityLivingCost, CURATED_CITY_COSTS, SCENARIO_MULTIPLIERS };
