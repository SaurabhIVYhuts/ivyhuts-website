// Student Planner accommodation discovery — the ONLY file that connects the
// planner to real accommodation data. It never calls Amber directly: every
// path to Amber goes through fetchListings()/fetchAmber() (amberGateway.js),
// so the planner automatically shares the one real global rate budget/
// cooldown/lock — there is no separate planner quota anywhere in this file.
//
//   getCityResidences()
//     -> AccommodationIndexMeta fresh/usable?  -> read AccommodationResidence from Mongo, done (0 Amber calls)
//     -> missing/expired?                      -> refreshCityIndex() -> fetchListings() (existing gateway)
//
//   getOverrideResidences()  (a university's explicit accommodationOverride)
//     -> fetchAmber({type:"detail", slug})      -> the SAME gateway/cache/
//        budget path PropertyDetailPage.js already uses for a single
//        property — no new Amber call type, no Mongo index involved at all.
//
// See docs: the write race and freshness-bookkeeping rules below were found
// and fixed by an explicit design review before implementation — the
// comments on refreshCityIndex() and rankResidences() explain why each guard
// exists, not just what it does.
"use strict";

const { connectToDatabase, MongoNotConfiguredError } = require("./mongodb");
const AccommodationResidence = require("./models/AccommodationResidence");
const AccommodationIndexMeta = require("./models/AccommodationIndexMeta");
const { fetchListings, fetchAmber, normalizeCityName } = require("./amberGateway");
const { log, sharedGet, sharedSet, acquireLock, releaseLock } = require("./sharedStore");

// CONFIRMED LIVE (production 504 on ivyhuts.com/properties?city=New York):
// a never-before-indexed city used to force a full Amber refresh
// synchronously on EVERY request, and fetchListings' own pagination
// (amberGateway.js) can take 23-33s in the multi-page case — comfortably
// exceeding Vercel's own function ceiling (vercel.json's maxDuration:30 for
// api/city-listings.js), which then hard-kills the whole invocation
// (FUNCTION_INVOCATION_TIMEOUT, a 504 with no JSON body at all). Milestone 4
// (see IVYHUTS_MILESTONE_4_INVENTORY_REFRESH_REPORT.md) replaces the single
// "always wait up to REFRESH_TIMEOUT_MS" behavior with an explicit state
// model — see classifyCityState() below — so a request only EVER
// synchronously waits on a refresh in the one case where there is genuinely
// nothing else to show (see FIRST_LOOK_REFRESH_TIMEOUT_MS); every other case
// (stale-but-existing data, a refresh already in progress, a recently-failed
// refresh) returns immediately without waiting, and requests a background
// refresh instead (see requestBackgroundRefresh/drainRefreshQueue). This
// deliberately does NOT just raise the old blocking timeout — per the
// milestone brief, raising it further would still risk the same Vercel
// ceiling for any request unlucky enough to hit it, just less often.
//
// Fresh (<FRESH_AGE_MS) and stale-but-usable (<MAX_AGE_MS) used to be
// behaviorally identical (both just read Mongo with zero Amber attempts) —
// the 30min/24h split was described as "a conceptual one... not a code
// branch." Milestone 4 makes it a real branch: STALE now triggers a
// non-blocking background refresh request instead of no refresh at all,
// which is what closes the actual coverage gap (Milestone 2 measured 527/575
// cities with no AccommodationIndexMeta document at all) without making any
// single request pay for it.
const FRESH_AGE_MS = 30 * 60 * 1000;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

// How long a FAILED refresh attempt holds off the next attempt for the same
// city, so 100 concurrent (or rapid sequential) requests for a genuinely
// failing city don't each retry Amber. Long enough that a transient failure
// doesn't get hammered every few seconds; short enough to recover within a
// normal browsing session. Deliberately similar to, but distinct from,
// amberGateway.js's own DEFAULT_COOLDOWN_MS (5 min, Amber's own documented
// 429 halt) — this cooldown covers a NARROWER set of failures (a single
// city's refresh timing out, a Mongo write failing) that don't need Amber's
// full-halt semantics, just enough spacing to stop a request storm.
const REFRESH_FAILURE_COOLDOWN_MS = 10 * 60 * 1000;

// The city-level refresh lock's TTL (see attemptCityRefresh). Must
// comfortably outlive one full refresh attempt — refreshCityIndex()'s own
// fetchListings() call can take up to AMBER_FETCH_TIMEOUT_MS (25s,
// amberGateway.js) plus mapping/persist overhead. Mirrors amberGateway.js's
// own LOCK_TTL_MS = AMBER_FETCH_TIMEOUT_MS + margin reasoning at this layer.
const CITY_REFRESH_LOCK_TTL_MS = 35_000;

// How long a request is allowed to synchronously wait on a refresh when
// there is LITERALLY nothing else to show (no AccommodationResidence rows
// exist for this city at all) — the one case this milestone still allows to
// block, because returning "building" immediately when a fast Amber
// response was actually available would be a worse user experience than a
// short, bounded wait. Deliberately SHORTER than the old REFRESH_TIMEOUT_MS
// (15s) it replaces: Milestone 2 directly measured real single-page Amber
// latencies of 972ms-10,745ms (median ~7.2s) — 12s comfortably covers a
// single page (the common case, especially after the Milestone 3 pagination
// fix, which means most refreshes now need only 1 page) without approaching
// Vercel's 30s ceiling. A city that genuinely needs longer is queued for the
// next cache-warmer cron tick instead of making a visitor wait for it (see
// requestBackgroundRefresh).
const FIRST_LOOK_REFRESH_TIMEOUT_MS = 12_000;

// Milestone 6 fix (IVYHUTS_MILESTONE_6_INVENTORY_LOSS_REPORT.md, Phase 4):
// refreshCityIndex() previously called fetchListings() with limit:50 — the
// exact same value a live user search (University Housing's PAGE_LIMIT) uses
// — and amberGateway.js's own pagination loop, until this same milestone's
// fix, silently clamped ANY caller's target count to 50 regardless of what
// was requested. The combined effect, confirmed live in a deterministic
// reproduction: a SINGLE refresh attempt could never capture more than one
// Amber page (50 items) per city, no matter how much real inventory that
// city actually had — meaning a city with hundreds of real Amber properties
// (Barcelona: 177+ already indexed from historical accumulation) would only
// ever gain ~50 NEW items per (infrequent — at most once per
// REFRESH_FAILURE_COOLDOWN_MS/FRESH_AGE_MS cycle) refresh, converging toward
// completeness far slower than necessary.
//
// 150 (3 Amber pages) is a deliberate middle ground, not the
// FILTERED_PAGINATION_MAX_PAGES ceiling (12 pages/~600 items) amberGateway.js
// itself allows: consuming half the shared 6/min budget in one refresh
// attempt would reintroduce exactly the "one action starves every other
// user" problem Milestone 3 fixed for SEARCH — refreshes must not do the
// same thing just because they're background work. 3 pages is a 3x
// improvement in per-attempt capture over the previous 1-page cap while
// leaving the majority of the shared budget free for concurrent real user
// traffic, and it still obeys every existing protection unchanged (the
// per-page amber:lock, the shared AMBER_FETCH_TIMEOUT_MS deadline, the
// FILTERED_PAGINATION_MAX_PAGES safety cap, the rate budget itself).
const REFRESH_TARGET_COUNT = 150;

// Redis-backed, deduplicated (Set-shaped) queue of cities a real user
// request asked for while stale/missing — drained by the existing
// */5 * * * * Vercel Cron (api/warm-amber-cache.js -> cacheWarmer.js), never
// by a new worker/queue system. See requestBackgroundRefresh/
// drainRefreshQueue and IVYHUTS_MILESTONE_4_INVENTORY_REFRESH_REPORT.md's
// "Platform constraint" section for why this, not a new infrastructure
// component, is the correct mechanism here.
const REFRESH_QUEUE_KEY = "accommodation:refreshQueue";
const REFRESH_QUEUE_TTL_SECONDS = 7 * 24 * 60 * 60;
// Bounded so a very cold cache (many distinct missing cities in a short
// window) can never grow this into an unbounded structure — old entries
// are simply not added once full; a city that misses being queued this way
// gets queued again the next time it's requested.
const REFRESH_QUEUE_MAX_SIZE = 200;

const RESULT_LIMIT = 5;

const CURRENCY_SYMBOLS = { pound: "£", gbp: "£", dollar: "$", usd: "$", euro: "€", eur: "€" };

function toNumber(v) {
    if (v == null) return null;
    const n = typeof v === "number" ? v : Number(String(v).replace(/[^0-9.-]/g, ""));
    return Number.isFinite(n) ? n : null;
}

function currencySymbol(raw) {
    if (!raw) return null;
    const key = String(raw).trim().toLowerCase();
    return CURRENCY_SYMBOLS[key] || raw;
}

function titleCase(str) {
    if (!str) return null;
    return String(str).replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim().replace(/\b\w/g, (c) => c.toUpperCase());
}

// Amber reports distance as a free-text string (e.g. "0.5 km", "800 m") —
// same field ListingCard.js already surfaces via amberMapper's getDistances().
// Converts to a plain km number; null if unparseable.
function parseDistanceKm(distanceStr) {
    if (typeof distanceStr !== "string") return null;
    const m = distanceStr.match(/([\d.]+)\s*(km|mi|m)\b/i);
    if (!m) return null;
    const value = Number(m[1]);
    if (!Number.isFinite(value)) return null;
    const unit = m[2].toLowerCase();
    if (unit === "km") return value;
    if (unit === "mi") return value * 1.60934;
    return value / 1000; // meters
}

function getCityCentreDistanceKm(raw) {
    const list = Array.isArray(raw?.meta?.distances) ? raw.meta.distances : [];
    const entry = list.find((d) => d && /city cent(re|er)/i.test(d.place || ""));
    return entry ? parseDistanceKm(entry.distance) : null;
}

// Same free-text heuristic src/pages/PropertyListingPage.js's own
// "University / Area" proximity filter already trusts (its UNIVERSITY_RE) —
// duplicated rather than imported (CommonJS/ESM boundary, see this file's
// header). Extracts REAL nearby-place names Amber already reported for this
// exact property, never a fabricated or curated name. This is what lets the
// global search index (api/_lib/searchIndex.js) grow to cover every real
// university/college actually present in the inventory, not just the
// hand-curated campusUniversities.json shortlist — coverage grows the same
// way property coverage does, from real Amber responses (index-on-read AND
// the full-catalog crawl), with zero new Amber calls of its own.
const NEARBY_UNIVERSITY_RE = /university|college/i;
const MAX_NEARBY_UNIVERSITIES_PER_RESIDENCE = 5;
function getNearbyUniversities(raw) {
    const list = Array.isArray(raw?.meta?.distances) ? raw.meta.distances : [];
    const names = list
        .map((d) => (d && typeof d.place === "string" ? d.place.trim() : null))
        .filter((place) => place && NEARBY_UNIVERSITY_RE.test(place) && !/city cent(re|er)/i.test(place));
    return Array.from(new Set(names)).slice(0, MAX_NEARBY_UNIVERSITIES_PER_RESIDENCE);
}

function getPrimaryImage(raw) {
    if (typeof raw.image_featured_link === "string" && raw.image_featured_link.trim()) return raw.image_featured_link;
    if (raw.meta && typeof raw.meta.featured_image_path === "string" && raw.meta.featured_image_path.trim()) return raw.meta.featured_image_path;
    if (Array.isArray(raw.images) && raw.images.length) {
        const first = raw.images[0];
        if (first) return (typeof first === "string" ? first : first.path || first.url) || null;
    }
    return null;
}

function getRating(raw) {
    const rating = raw?.meta?.review_summary?.rating;
    if (!rating || typeof rating !== "object") return null;
    const values = Object.values(rating).filter((v) => typeof v === "number");
    if (!values.length) return null;
    return Math.round((values.reduce((s, v) => s + v, 0) / values.length) * 10) / 10;
}

function getRoomType(raw) {
    const unitTypes = Array.isArray(raw?.meta?.unit_types) ? raw.meta.unit_types : [];
    const first = unitTypes.find((t) => t && !/^\d/.test(t));
    return titleCase(first) || null;
}

// The four extractors below mirror src/services/amberMapper.js's
// getAmenities/getBadges/getRooms/getSocialProof/getDistances — same
// duplication rationale as this file's header comment already gives for
// mapAmberItemToResidence as a whole (api/_lib is plain CommonJS, that file
// is an ES module for CRA's build). Added so the general property browse/
// search page's cards (api/city-listings.js) can show the same amenity
// chips, badges, room count and nearby-place lines the live-Amber-sourced
// cards already do — the original narrow shape here was deliberately built
// only for the Planner's compact card, which never needed them.
const AMENITY_STORE_LIMIT = 12;
function getAmenitiesList(raw) {
    const out = [];
    const seen = new Set();
    const add = (name) => {
        const clean = (name || "").trim();
        if (!clean) return;
        const key = clean.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
        if (seen.has(key)) return;
        seen.add(key);
        out.push(clean);
    };
    if (Array.isArray(raw.features)) {
        for (const category of raw.features) {
            if (!category || !Array.isArray(category.values)) continue;
            for (const v of category.values) if (v && v.name) add(v.name);
        }
    }
    if (Array.isArray(raw.tags)) {
        for (const t of raw.tags) {
            if (typeof t !== "string" || t === "not_available") continue;
            add(titleCase(t));
        }
    }
    return out.slice(0, AMENITY_STORE_LIMIT);
}

function truthy(v) {
    return v === true || v === "true" || v === 1 || v === "1";
}

function getBadgesInfo(raw) {
    const cro = raw.meta?.cro_tags || {};
    const badges = [];
    if (truthy(cro.is_student_choice)) badges.push("Student's Choice");
    if (truthy(cro.is_amber_exclusive)) badges.push("Exclusive");
    if (truthy(cro.is_property_of_the_day)) badges.push("Property of the Day");
    if (truthy(cro.is_filling_fast_v2) || truthy(cro.is_fast_filling)) badges.push("Filling Fast");
    if (truthy(cro.is_immediate_move_in)) badges.push("Immediate Move-in");
    if (truthy(cro.is_breakfast_included)) badges.push("Breakfast Included");
    if (truthy(cro.is_budget_friendly)) badges.push("Budget Friendly");

    const hasDiscount = truthy(cro.has_discounts);
    const offerText = cro.amber_sale && typeof cro.amber_sale.offer === "string" ? cro.amber_sale.offer : null;
    if (hasDiscount) badges.push("Offer Available");

    const billsIncluded =
        (Array.isArray(raw.features) && raw.features.some((f) => f && f.type === "bills_included")) ||
        (Array.isArray(raw.tags) && raw.tags.some((t) => typeof t === "string" && t.toLowerCase().includes("bills_included")));
    if (billsIncluded) badges.push("Bills Included");

    const dualOccupancy = Array.isArray(raw.tags) && raw.tags.includes("dual_occupancy");
    if (dualOccupancy) badges.push("Dual Occupancy");

    return { badges, offerText, billsIncluded };
}

function getRoomsSummary(raw) {
    const children = Array.isArray(raw.children) ? raw.children : [];
    const unitTypes = new Set();
    const addType = (t) => {
        if (!t || /^\d/.test(t)) return; // skip cryptic bedroom-count codes like "1b", "3b"
        unitTypes.add(titleCase(t));
    };
    (raw.meta?.unit_types || []).forEach(addType);
    children.forEach((c) => addType(c?.meta?.unit_type));
    return {
        count: toNumber(raw.children_count) ?? children.length,
        types: Array.from(unitTypes).slice(0, 4),
    };
}

function getNearbyPlacesList(raw, limit = 4) {
    const list = Array.isArray(raw?.meta?.distances) ? raw.meta.distances : [];
    const cityCentre = list.find((d) => d && /city cent(re|er)/i.test(d.place || ""));
    const nearby = list.filter((d) => d && d !== cityCentre && d.place && d.distance);
    return nearby.slice(0, limit).map((d) => ({ place: d.place, distance: d.distance }));
}

function getSocialShortlisted(raw) {
    const facts = Array.isArray(raw?.meta?.facts) ? raw.meta.facts : [];
    const entry = facts.find((f) => f && f.name === "shortlisted_in_30days");
    return entry?.value || null;
}

const WEEKS_PER_MONTH = 52 / 12;

// Mirrors the transform src/services/amberMapper.js's getPrice() already
// uses ("weekly" -> "week" etc.) — but note this strips ANY "-ly" suffix,
// including real UK student-housing "termly" pricing -> "term", which
// computePriceWeekly below deliberately does NOT convert (no reliable
// weeks-per-term constant exists) rather than silently mis-ranking it.
function normalizeDuration(raw) {
    if (!raw) return null;
    const cleaned = String(raw).trim().toLowerCase().replace(/ly$/, "");
    return cleaned || null;
}

// Weekly-equivalent price for budget-fit ranking — null (never a guessed
// "week") for anything not confidently week/month, matching this codebase's
// existing philosophy (see rankResidences) of redistributing ranking weight
// for an unusable factor rather than assuming a value.
function computePriceWeekly(amount, duration) {
    if (!Number.isFinite(amount)) return null;
    if (duration === "week") return amount;
    if (duration === "month") return amount / WEEKS_PER_MONTH;
    return null;
}

function extractResultArray(json) {
    return Array.isArray(json?.data?.result) ? json.data.result : [];
}

// Cheapest AVAILABLE tenancy — backend CommonJS twin of
// src/services/amberMapper.js's selectCheapestAvailableTenancy() (same
// rule: amount+currency+duration always read off the SAME tenancy record,
// never mixed with a different room's own aggregate). Not imported (see
// mapAmberItemToResidence's own comment on why this file duplicates rather
// than imports the frontend mapper).
function selectCheapestAvailableTenancy(tenancies) {
    // price > 0, not just Number.isFinite — a zero/negative "price" is a
    // data artifact, never a real chargeable rate (item 14).
    const available = (Array.isArray(tenancies) ? tenancies : [])
        .filter((t) => t && t.available === true && Number.isFinite(toNumber(t.pricing?.price)) && toNumber(t.pricing.price) > 0);
    if (!available.length) return null;
    return available.reduce((best, t) => (toNumber(t.pricing.price) < toNumber(best.pricing.price) ? t : best));
}

// A room is available if any of its real tenancies are — never just the
// room's own raw flag alone. Same rule as amberMapper.js's isRoomAvailable
// (confirmed live: a real Manchester room had its own `available:false`
// while one of its tenancies was genuinely `available:true` at a real,
// lower price — the tenancy-level truth is what's authoritative).
function isChildRoomAvailable(child, tenancies) {
    if (tenancies.length > 0) return tenancies.some((t) => t && t.available === true);
    return child.available === true;
}

// Backend CommonJS twin of amberMapper.js's dedupeRoomChildren() — same
// rule, same two confirmed-live motivating cases (see that function's own
// header for the full phantom-room / availability-mismatch writeup): a
// same-named duplicate that's genuinely available is never discarded in
// favor of a same-named duplicate that isn't, and a tenancy-less phantom
// with a bogus price is never preferred over a real, tenancy-bearing entry.
// Applied here specifically so a phantom (if ever marked available:true at
// the room level) can never win this file's own cheapest-candidate scan
// across raw.children.
function dedupeRoomChildren(children) {
    const list = Array.isArray(children) ? children.filter(Boolean) : [];
    const groups = new Map();
    for (const child of list) {
        const key = String(child.name || "").trim().toLowerCase();
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(child);
    }
    const hasTenancies = (child) => Array.isArray(child.children) && child.children.length > 0;
    const result = [];
    for (const group of groups.values()) {
        if (group.length === 1) { result.push(group[0]); continue; }
        const available = group.filter((c) => isChildRoomAvailable(c, Array.isArray(c.children) ? c.children : []));
        if (available.length > 0) {
            const availableWithTenancies = available.filter(hasTenancies);
            result.push(...(availableWithTenancies.length ? availableWithTenancies : available));
        } else {
            const withTenancies = group.filter(hasTenancies);
            result.push(...(withTenancies.length ? withTenancies : [group[0]]));
        }
    }
    return result;
}

// ── Milestone 5 (IVYHUTS_MILESTONE_5_INVENTORY_COMPLETENESS_REPORT.md):
// canonical availability resolver — a named, documented, PURELY ADDITIVE
// classification layered on top of the room/tenancy walk deriveResidencePricing
// already performs, not a new decision and not wired into that function's own
// `available` boolean (see this file's own report for why: deriveResidencePricing's
// room-based branch also gates on whether a genuinely available room's PRICE
// could be determined, a subtlety this resolver deliberately does not
// replicate, to avoid any behavior change to the persisted field without
// evidence such a change is needed). Exported for testing/observability and
// for any future caller that wants the finer-grained tri-state rather than
// the boolean AccommodationResidence.available field.
//
//   AVAILABLE — real room/tenancy data confirms at least one bookable room,
//               OR no room data exists but the property's own top-level flag
//               explicitly says available:true.
//   SOLD_OUT  — real room/tenancy data confirms every room is unavailable,
//               OR no room data exists but the property's own top-level flag
//               explicitly says available:false.
//   UNKNOWN   — no room/tenancy data AND no explicit top-level flag either
//               way. NEVER inferred as sold out — Amber simply didn't say.
function resolvePropertyAvailability(raw) {
    const children = dedupeRoomChildren(raw?.children);
    if (children.length) {
        const anyAvailable = children.some((child) => {
            const tenancies = Array.isArray(child.children) ? child.children : [];
            return isChildRoomAvailable(child, tenancies);
        });
        return anyAvailable ? "AVAILABLE" : "SOLD_OUT";
    }
    if (raw?.available === false) return "SOLD_OUT";
    if (raw?.available === true) return "AVAILABLE";
    return "UNKNOWN";
}

// THE property-level pricing/availability decision for the Planner's own
// cached index — mirrors src/services/amberMapper.js's deriveDisplayPricing
// (same business rule: derive from real room/tenancy data when present,
// preferring availability-aware tenancy pricing over Amber's own coarse
// aggregate `pricing.min_price`, which is NOT availability-aware and can
// equal a sold-out room's price — see that file's own header for the real
// live example this was found against). Falls back to the top-level
// aggregate (preferring min_available_price over min_price) only when no
// room/tenancy breakdown exists at all. Returns real source values only —
// `amount`/`currency`/`duration` always come from the SAME selected
// record, never a fabricated/derived composite.
function deriveResidencePricing(raw) {
    const children = dedupeRoomChildren(raw?.children);
    if (children.length) {
        const candidates = [];
        for (const child of children) {
            const tenancies = Array.isArray(child.children) ? child.children : [];
            if (!isChildRoomAvailable(child, tenancies)) continue;

            const cheapestTenancy = selectCheapestAvailableTenancy(tenancies);
            const roomPricing = child.pricing || {};
            const candidate = cheapestTenancy
                ? {
                    amount: toNumber(cheapestTenancy.pricing.price),
                    currency: currencySymbol(cheapestTenancy.pricing.currency) || currencySymbol(roomPricing.currency),
                    duration: normalizeDuration(cheapestTenancy.pricing.duration) || normalizeDuration(roomPricing.duration),
                    source: "tenancy",
                }
                : { amount: toNumber(roomPricing.min_price ?? roomPricing.price), currency: currencySymbol(roomPricing.currency), duration: normalizeDuration(roomPricing.duration), source: "room" };
            // amount > 0, not just Number.isFinite — never fabricate/select
            // a zero or negative "price" (item 14).
            if (!Number.isFinite(candidate.amount) || candidate.amount <= 0) continue;
            candidates.push(candidate);
        }
        if (!candidates.length) return { amount: null, currency: null, duration: null, available: false };

        // Prefer tenancy-backed candidates over a bare room-aggregate price
        // (source: "room" — a room with ZERO real tenancies, so nothing to
        // actually enquire/book against) whenever any tenancy-backed
        // candidate exists at all — mirrors src/services/amberMapper.js's
        // selectCheapestAvailableRoomType fix. Confirmed live: Halsmere
        // Studios, London had "Diamond Studio Plus" listed 3 times, all
        // available:true, all £100/week, all with zero tenancies (a phantom
        // duplicate — see dedupeRoomChildren's own header) — the OLD
        // amount-only comparison here let £100 win over the real £410
        // tenancy-backed rooms, which is exactly what this index then
        // served to every visitor of the city-listings/search page until
        // the next re-index, even after the SAME bug was already fixed in
        // the live-Amber path (amberMapper.js) — this file is a separate
        // CommonJS twin, not shared code, so that earlier fix never reached
        // this indexer. Only falls back to room-aggregate candidates when
        // NONE of the property's rooms have tenancy data at all.
        const tenancyBacked = candidates.filter((c) => c.source === "tenancy");
        const pool = tenancyBacked.length > 0 ? tenancyBacked : candidates;

        let best = null;
        for (const candidate of pool) {
            if (!best) { best = candidate; continue; }
            const candidateWeekly = computePriceWeekly(candidate.amount, candidate.duration);
            const bestWeekly = computePriceWeekly(best.amount, best.duration);
            if (candidateWeekly != null && bestWeekly != null) { if (candidateWeekly < bestWeekly) best = candidate; }
            else if (candidateWeekly != null && bestWeekly == null) { best = candidate; }
            else if (candidateWeekly == null && bestWeekly == null && candidate.amount < best.amount) { best = candidate; }
        }
        return { amount: best.amount, currency: best.currency, duration: best.duration, available: true };
    }

    // No room-type breakdown at all — only positive evidence (the
    // property's own top-level `available` flag being explicitly false)
    // marks it unavailable; otherwise fall back to the aggregate, same
    // fallback-field priority as the frontend fix.
    if (raw?.available === false) return { amount: null, currency: null, duration: null, available: false };
    const pricing = raw?.pricing || {};
    const amount = toNumber(pricing.min_available_price ?? pricing.available_price ?? pricing.min_price ?? pricing.price);
    return {
        amount: Number.isFinite(amount) && amount > 0 ? amount : null,
        currency: currencySymbol(pricing.currency),
        duration: normalizeDuration(pricing.duration),
        available: true,
    };
}

// Raw Amber item -> index-row shape. Deliberately a small self-contained
// subset of src/services/amberMapper.js's logic, not an import — that file
// is an ES module for CRA's webpack pipeline; api/_lib is plain CommonJS
// with no build step (same reason cacheWarmer.js duplicates the UK-cities
// list instead of importing src/data/destinations.js).
//
// Milestone 5 (IVYHUTS_MILESTONE_5_INVENTORY_COMPLETENESS_REPORT.md, Phase
// 5/6): explicit, categorized rejection logging — recommended twice before
// (Milestone 1's audit §25, Milestone 2's "NEXT FIXES" table, P1) and never
// implemented until now. Zero behavior change: the two rejection conditions
// themselves are exactly what they were before — this only makes a silent
// discard visible, with a stable machine-readable `reason` code, so a real
// production rejection rate can finally be measured going forward. Milestone
// 2 measured 0/165 rejections on live data; this milestone's own fresh
// sample (scripts/measure-milestone-5-reconciliation.js, Barcelona/Sheffield/
// Leeds) measured 0/116 more — 0/281 combined — so this logging exists to
// keep watching, not because a live rejection has actually been observed.
function mapAmberItemToResidence(raw, normalizedCity) {
    const propertyId = raw?.id != null ? String(raw.id) : null;
    if (!propertyId) {
        log(`[Index] action=RESIDENCE_REJECTED reason=MISSING_SOURCE_ID city=${normalizedCity} name=${JSON.stringify(raw?.name || null)}`);
        return null;
    }
    if (!raw?.name) {
        log(`[Index] action=RESIDENCE_REJECTED reason=MISSING_NAME city=${normalizedCity} propertyId=${propertyId}`);
        return null;
    }
    const derived = deriveResidencePricing(raw);
    const priceAmount = derived.amount;
    const priceDuration = derived.duration;
    const { badges, offerText, billsIncluded } = getBadgesInfo(raw);
    const rooms = getRoomsSummary(raw);
    return {
        source: "amber",
        propertyId,
        slug: raw.canonical_name || null,
        propertyName: raw.name,
        city: normalizedCity,
        country: raw.location?.country?.long_name || null,
        latitude: typeof raw.location_coordinates?.lat === "number" ? raw.location_coordinates.lat : null,
        longitude: typeof raw.location_coordinates?.lng === "number" ? raw.location_coordinates.lng : null,
        price: {
            amount: priceAmount,
            currency: derived.currency || currencySymbol(raw.pricing?.currency),
        },
        priceDuration,
        priceWeekly: computePriceWeekly(priceAmount, priceDuration),
        image: getPrimaryImage(raw),
        rating: getRating(raw),
        roomType: getRoomType(raw),
        distanceToCentreKm: getCityCentreDistanceKm(raw),
        nearbyUniversities: getNearbyUniversities(raw),
        // Derived from real room/tenancy availability when that data
        // exists (see deriveResidencePricing/isChildRoomAvailable above) —
        // NOT just the property's own coarse top-level flag, which can
        // disagree with tenancy-level truth in either direction.
        available: derived.available,
        amenities: getAmenitiesList(raw),
        badges,
        offerText,
        billsIncluded,
        roomsCount: rooms.count,
        roomTypes: rooms.types,
        nearbyPlaces: getNearbyPlacesList(raw),
        socialShortlisted: getSocialShortlisted(raw),
    };
}

// Just the upsert loop, no AccommodationIndexMeta bookkeeping — split out of
// persistResidences() so a caller whose batch spans MANY cities in one go
// (api/_lib/insightsMarket.js's full-catalog crawl, which pages through
// every city at once rather than one at a time) can persist residences
// without writing a nonsensical single-city Meta row for a mixed-city batch.
// Concurrent first-inserts of the same not-yet-existing document under a
// unique index can still legitimately race (a fetch that outlives the
// gateway's own lock TTL is a pre-existing, rare edge case shared by every
// Amber consumer) — E11000 from that race is swallowed as benign rather than
// surfaced as a failure.
// Milestone 8 fix (IVYHUTS_MILESTONE_8_REFRESH_LIFECYCLE_REPORT.md, Part 3):
// was Promise.all over N independent updateOne calls — genuinely capable of
// "ambiguous partial persistence" (a late failure rejects the whole
// Promise.all while earlier, already-resolved writes had already landed,
// with no way for the caller to know how many succeeded) and N separate
// round-trips for what's conceptually one batch.
//
// Full ACID multi-document transactions were considered and rejected as
// disproportionate here: this collection's write volume per refresh is small
// (≤ REFRESH_TARGET_COUNT=150 documents), each write is an independent
// upsert-by-identity with no cross-document invariant to protect, and
// wrapping 150 independent upserts in a transaction would add real
// performance/session overhead for zero correctness benefit — nothing here
// requires "all or nothing," only "know exactly what happened."
// `bulkWrite(ops, {ordered:false})` is the right middle ground: one round
// trip, every op attempted independently (a bad doc never blocks the good
// ones, same best-effort semantics as before), and — unlike the old
// Promise.all — a STRUCTURED result the caller can inspect: `attempted`/
// `inserted`/`updated`/`failed`/`errors` rather than a single opaque
// exception. Never a silent "partial success reported as full success" — the
// return value always reflects exactly what was verified to happen.
async function persistResidencesRaw(mapped) {
    if (!mapped.length) return { attempted: 0, inserted: 0, updated: 0, failed: 0, errors: [] };
    const ops = mapped.map((doc) => ({
        updateOne: { filter: { source: doc.source, propertyId: doc.propertyId }, update: { $set: doc }, upsert: true },
    }));
    try {
        const result = await AccommodationResidence.bulkWrite(ops, { ordered: false });
        // Mongoose (confirmed live, not assumed) reports PER-DOCUMENT
        // validation/cast failures inline here — `ordered:false` bulkWrite
        // does NOT throw for these, it succeeds with a positional
        // `result.mongoose.results` array (null = that op's own write
        // succeeded; an error object = that specific op failed validation
        // and was never sent to MongoDB at all). This is Mongoose's own
        // client-side guard layer, distinct from a real MongoDB write error.
        const perOpResults = result?.mongoose?.results || [];
        const failures = [];
        perOpResults.forEach((r, i) => {
            if (r) {
                failures.push({ propertyId: mapped[i]?.propertyId || null, message: String(r.message || r).slice(0, 300) });
                log(`[Index] action=PERSIST_VALIDATION_FAILED propertyId=${mapped[i]?.propertyId} error=${String(r.message || r).slice(0, 200)}`);
            }
        });
        return {
            attempted: mapped.length,
            inserted: result.upsertedCount || 0,
            updated: result.modifiedCount || 0,
            failed: failures.length,
            errors: failures,
        };
    } catch (err) {
        // A genuine driver-level failure (connection loss, a real non-11000
        // write error) — bulkWrite's own per-op independence means ops that
        // already succeeded before the throw are NOT rolled back. Documented
        // explicitly, not hidden: partial persistence remains possible here
        // (same pre-existing contract this function always had), just now
        // reported with an accurate count via `err.result` instead of an
        // opaque single exception swallowing everything.
        const writeErrors = Array.isArray(err.writeErrors) ? err.writeErrors : [];
        const realErrors = writeErrors.filter((e) => e.code !== 11000); // 11000 = benign concurrent-insert race, same precedent this function always followed
        if (realErrors.length) log(`[Index] action=PERSIST_BULK_WRITE_ERRORS count=${realErrors.length} sample=${String(realErrors[0]?.errmsg || "").slice(0, 200)}`);
        const r = err.result || {};
        return {
            attempted: mapped.length,
            inserted: r.nUpserted ?? r.upsertedCount ?? 0,
            updated: r.nModified ?? r.modifiedCount ?? 0,
            failed: realErrors.length,
            errors: realErrors.map((e) => ({ propertyId: mapped[e.index]?.propertyId || null, message: String(e.errmsg || e.message || "").slice(0, 300) })),
        };
    }
}

// Persists one refreshed SINGLE-CITY batch — ONLY called for the caller that
// observed cacheStatus:"MISS" (see refreshCityIndex). Also updates this
// city's AccommodationIndexMeta freshness row, which only makes sense when
// every doc in `mapped` really does belong to `normalizedCity` (true for
// every existing caller of this function — a per-city fetchListings result).
// Milestone 8 fix (Part 3/4): now inspects persistResidencesRaw()'s
// structured result instead of assuming a resolved promise means everything
// persisted. `residenceCount` reflects what was actually VERIFIED persisted
// (insert+update), never merely attempted — and a batch with any real
// failures is never reported as a clean "ok" (Part 3's own instruction: "do
// not pretend a partial refresh succeeded").
// `complete` (default true, for every pre-existing caller — this milestone's
// fix, not a behavior change for anyone who doesn't pass it) distinguishes a
// genuinely-finished Amber pagination run from one that stopped early due to
// a deadline/budget/page-cap (amberGateway.js's fetchListings, `complete`
// field). CONFIRMED LIVE this milestone: a refresh can hit PAGINATE_FAILED
// mid-loop and still return a normal-looking success — nothing downstream
// previously distinguished "captured this city's whole real inventory" from
// "captured 2 of an unknown-but-larger number of pages," so a truncated
// refresh could get marked exactly as fresh/trustworthy as a complete one.
//
// The fix does NOT discard or withhold the real, verified rows a partial
// fetch DID find — this project's own established rule (see e.g. the
// sparse-fallback loop's "never discard what's already real" contract) is
// that real data is always persisted. It only changes what the *metadata*
// claims: an incomplete run is recorded as `status: "partial"`, never "ok",
// so classifyCityState()/any future consumer can tell the difference rather
// than trusting a silently-truncated snapshot as equivalently complete.
async function persistResidences(normalizedCity, mapped, { complete = true } = {}) {
    const result = await persistResidencesRaw(mapped);
    const successCount = result.inserted + result.updated;
    const baseSet = { city: normalizedCity, lastRefreshedAt: new Date(), residenceCount: successCount };
    if (result.failed > 0) {
        // A partial failure still made real, verified progress (successCount
        // items genuinely persisted) — consecutiveFailures is deliberately
        // NOT incremented here the way a fully-failed refreshCityIndex()
        // attempt increments it elsewhere; that counter exists to cool down
        // a city that can make NO progress at all, not one that mostly
        // succeeded. The failure itself is still recorded, honestly, in
        // status/lastError — never silently absorbed into a clean "ok".
        await AccommodationIndexMeta.updateOne(
            { city: normalizedCity },
            { $set: { ...baseSet, status: "error", lastError: `${result.failed}/${mapped.length} properties failed to persist (see PERSIST_VALIDATION_FAILED/PERSIST_BULK_WRITE_ERRORS logs)`, lastErrorAt: new Date() } },
            { upsert: true }
        );
        return result;
    }
    await AccommodationIndexMeta.updateOne(
        { city: normalizedCity },
        {
            // A real success clears the failure trail in the SAME atomic
            // update as the success fields — Milestone 4's
            // classifyCityState()/cooldown logic reads consecutiveFailures,
            // never a permanent blacklist, so this must reset on any
            // genuine success, with no window where a concurrent reader
            // could observe success fields written but the failure trail not
            // yet cleared. `status: "partial"` (not "ok") when the Amber
            // pagination itself didn't finish — the real rows it DID find are
            // still fully persisted above, only the metadata's own claim of
            // completeness is honest about what actually happened.
            $set: { ...baseSet, status: !successCount ? "empty" : complete ? "ok" : "partial", consecutiveFailures: 0 },
            $unset: { lastError: "", lastErrorAt: "" },
        },
        { upsert: true }
    ).catch((err) => {
        if (err && err.code === 11000) return;
        throw err;
    });
    return result;
}

// The only function that may call Amber (via fetchListings — the existing,
// already-locked/budgeted/deduped gateway entry point). Never throws: any
// failure degrades to { residences: [], refreshed: false } and the caller
// falls back to whatever's already in Mongo (possibly nothing).
//
// Returns the mapped residences IN-MEMORY regardless of whether this call
// was the lock winner or a waiter — a waiter that got real fresh data back
// from fetchListings() must not throw it away and re-read Mongo, which may
// not have the winner's write yet (separate serverless invocation, no
// ordering guarantee). Only Mongo PERSISTENCE is gated on cacheStatus
// "MISS" (the one call that actually hit Amber and owns writing this
// refresh epoch's data) — the response is not.
async function refreshCityIndex(normalizedCity, priority, source) {
    let result;
    try {
        result = await fetchListings({ city: normalizedCity, page: 1, limit: REFRESH_TARGET_COUNT }, priority, source);
    } catch (err) {
        log(`[Planner] action=REFRESH_FAILED city=${normalizedCity} error=${err.message}`);
        try {
            await AccommodationIndexMeta.updateOne(
                { city: normalizedCity },
                {
                    $set: { city: normalizedCity, status: "error", lastErrorAt: new Date(), lastError: String(err.message || err).slice(0, 500) },
                    $inc: { consecutiveFailures: 1 },
                },
                { upsert: true }
            );
        } catch (_) { /* best-effort only — do not let a Meta write failure mask the real error */ }
        return { residences: [], refreshed: false };
    }

    const items = extractResultArray(result.data);
    const mapped = items.map((item) => mapAmberItemToResidence(item, normalizedCity)).filter(Boolean);

    // Only the caller that actually hit Amber (cacheStatus "MISS") persists —
    // see persistResidences' comment. Every other caller (HIT/STALE/
    // HIT_AFTER_WAIT/etc.) still gets the same mapped data back to rank and
    // return to its own user, it just doesn't also write it.
    if (result.cacheStatus === "MISS") {
        try {
            // result.complete (amberGateway.js's fetchListings) distinguishes
            // a genuinely-finished pagination run from one that stopped early
            // due to a deadline/budget/page-cap — see persistResidences' own
            // comment for why this must never be silently absorbed into "ok".
            await persistResidences(normalizedCity, mapped, { complete: result.complete !== false });
        } catch (err) {
            // A real (non-11000) Mongo failure here must not fail the request —
            // this caller still has good in-memory data to return.
            log(`[Planner] action=PERSIST_FAILED city=${normalizedCity} error=${err.message}`);
        }
    }

    return { residences: mapped, refreshed: true };
}

// ── Milestone 4: inventory freshness state model ────────────────────────
// Turns "is this city's index missing/stale" into one explicit, named
// decision instead of re-deriving ad hoc age math inline at each call site.
// REFRESHING is intentionally NOT one of these states: whether a refresh is
// currently in progress is discovered at attempt time via the Redis lock
// itself (attemptCityRefresh), never trusted from Mongo's own possibly-stale
// bookkeeping — Mongo writes are not on that lock's critical path, so a
// persisted "in progress" flag could easily read stale.
//
//   MISSING          no AccommodationIndexMeta document exists at all.
//   FRESH            metadata exists and is younger than FRESH_AGE_MS — read
//                     Mongo only, request no refresh at all.
//   STALE            metadata exists, older than FRESH_AGE_MS but younger
//                     than MAX_AGE_MS — still usable, but a background
//                     refresh should be requested.
//   FAILED_COOLDOWN  the most recent attempt failed within
//                     REFRESH_FAILURE_COOLDOWN_MS — do not attempt again yet.
//   EXPIRED          metadata is missing entirely, or older than MAX_AGE_MS,
//                     or the failure cooldown has elapsed — eligible for a
//                     fresh attempt.
function classifyCityState(meta, now = Date.now()) {
    if (!meta) return "MISSING";
    const lastAttemptedMs = meta.lastAttemptedAt ? new Date(meta.lastAttemptedAt).getTime() : null;
    if (meta.status === "error" && lastAttemptedMs != null && now - lastAttemptedMs < REFRESH_FAILURE_COOLDOWN_MS) {
        return "FAILED_COOLDOWN";
    }
    const age = meta.lastRefreshedAt ? now - new Date(meta.lastRefreshedAt).getTime() : Infinity;
    if (age < FRESH_AGE_MS) return "FRESH";
    if (age < MAX_AGE_MS) return "STALE";
    return "EXPIRED";
}

// Best-effort only — NEVER allowed to fail or slow down the caller's own
// response (every call site awaits this, but its own body never throws).
// Adds `city` to a small, bounded, deduplicated (Set-shaped) Redis-backed
// queue that the EXISTING */5 * * * * Vercel Cron (api/warm-amber-cache.js
// -> cacheWarmer.js's runCacheWarmer(), unchanged trigger mechanism) drains
// a small batch of on every tick — see IVYHUTS_MILESTONE_4_INVENTORY_REFRESH_REPORT.md's
// "Platform constraint" section for why an existing cron, not a new queue/
// worker system, is the right mechanism given what's actually deployed here.
//
// Reuses sharedGet/sharedSet (the plain value primitives already in
// sharedStore.js) rather than adding a new Redis command type (e.g. SADD) to
// that shared file — a small TOCTOU race on concurrent enqueue is possible
// (worst case: two concurrent writers both read the same pre-add array and
// each write their own single-city addition, so one write's city is lost)
// which is an acceptable tradeoff for a best-effort, self-healing queue: a
// city that misses being queued this way simply gets queued again the next
// time any user requests it.
async function requestBackgroundRefresh(city) {
    try {
        const current = await sharedGet(REFRESH_QUEUE_KEY);
        const set = new Set(Array.isArray(current) ? current : []);
        if (set.has(city)) return;
        if (set.size >= REFRESH_QUEUE_MAX_SIZE) {
            log(`[Index] action=REFRESH_QUEUE_FULL city=${city} size=${set.size}`);
            return;
        }
        set.add(city);
        await sharedSet(REFRESH_QUEUE_KEY, Array.from(set), REFRESH_QUEUE_TTL_SECONDS);
        log(`[Index] action=REFRESH_QUEUED city=${city} queueSize=${set.size}`);
    } catch (err) {
        // Never let a queueing failure affect the request that triggered
        // this — the city simply isn't queued this time.
        log(`[Index] action=REFRESH_QUEUE_FAILED city=${city} error=${err.message}`);
    }
}

// Removes and returns up to `maxCities` queued cities (FIFO-ish — array
// order, not a priority queue; good enough for best-effort backfill). Called
// only by cacheWarmer.js's existing cron-triggered runCacheWarmer(), never
// from a user-facing request path. Cities are removed from the queue BEFORE
// being attempted so a slow/failed attempt in one cron tick can't cause an
// overlapping tick to redundantly re-drain the same entry — attemptCityRefresh's
// own Redis lock is still the real duplicate-refresh guard; this is only
// queue bookkeeping.
async function drainRefreshQueue(maxCities) {
    let queued;
    try {
        queued = await sharedGet(REFRESH_QUEUE_KEY);
    } catch (err) {
        log(`[Index] action=REFRESH_QUEUE_DRAIN_FAILED error=${err.message}`);
        return [];
    }
    if (!Array.isArray(queued) || !queued.length) return [];
    const batch = queued.slice(0, maxCities);
    const remaining = queued.slice(maxCities);
    try {
        await sharedSet(REFRESH_QUEUE_KEY, remaining, REFRESH_QUEUE_TTL_SECONDS);
    } catch (err) {
        // If the shrunk queue can't be persisted, worst case the same batch
        // is drained again next tick — attemptCityRefresh's lock and
        // classifyCityState's cooldown both make that a harmless no-op for
        // any city that doesn't actually need re-attempting.
        log(`[Index] action=REFRESH_QUEUE_SHRINK_FAILED error=${err.message}`);
    }
    return batch;
}

// The one function that may acquire the CITY-level refresh lock and call
// refreshCityIndex(). Distinct from amberGateway.js's own
// amber:lock:<cacheKey> (which protects a single Amber page fetch) — this
// lock protects the WHOLE refresh operation (fetch + normalize + persist +
// metadata update), so concurrent callers for the same city never even reach
// fetchAmber's own per-page lock in the first place. Never throws: every
// failure mode (lock unavailable, Amber error, Mongo error — all already
// handled inside refreshCityIndex/persistResidences) resolves to a quiet
// return, matching this file's existing "never crash the request" philosophy
// throughout.
//
// `timeoutMs`, when given, bounds ONLY how long THIS CALLER's own returned
// promise waits before resolving — it has NO effect on the underlying
// operation's lifecycle (the lock, the Mongo persist, the Meta update), which
// `work` below owns unconditionally via its own `.finally()`. A timed-out
// caller gets `refreshStatus: "RUNNING"` plus the operation's `operationId`
// and must treat existing Mongo data (if any) as authoritative; it must never
// be interpreted as "the refresh failed" for cooldown purposes — the real
// operation keeps running and will record its own true SUCCEEDED/FAILED
// outcome independently, whether or not this particular caller is still
// listening.
//
// Milestone 8 fix (IVYHUTS_MILESTONE_8_REFRESH_LIFECYCLE_REPORT.md): Milestone
// 7 directly reproduced a real bug here — the OLD implementation released
// the refresh lock in a `finally` gated on `withTimeout(work, timeoutMs,
// fallback)` resolving, which happens at the TIMEOUT boundary if `work`
// (refreshCityIndex, including its Mongo persist) hadn't finished yet, not
// when the real work actually completed. That let the lock free up while a
// real refresh was still running in the background — a second concurrent
// caller could then acquire the lock and start an OVERLAPPING refresh for
// the same city, defeating the "one refresh at a time" guarantee this
// function exists to provide.
//
// Fix: the lock's lifetime is now owned ENTIRELY by `work` itself (released
// in `work`'s own `.finally()`), never by whether any particular caller is
// still waiting for it. `timeoutMs`, if given, only bounds how long THIS
// CALL's own returned promise waits before resolving — it no longer has any
// effect on the lock or on Meta. A caller that times out gets back
// `refreshStatus: "RUNNING"` (not a value indistinguishable from failure) and
// the operation's `operationId`, so it can tell the difference between
// "genuinely failed" and "still going, ask again later" — this is the
// explicit state machine requirement (QUEUED/RUNNING/SUCCEEDED/FAILED/
// CANCELLED — CANCELLED is reserved for a future caller-driven abort, never
// produced by this function today, since nothing currently cancels an
// in-flight refresh).
async function attemptCityRefresh(normalizedCity, priority, source, { timeoutMs } = {}) {
    const lockKey = `accommodation:refreshlock:${normalizedCity}`;
    let lockToken;
    try {
        lockToken = await acquireLock(lockKey, CITY_REFRESH_LOCK_TTL_MS);
    } catch (err) {
        log(`[Index] action=REFRESH_LOCK_UNAVAILABLE city=${normalizedCity} error=${err.message}`);
        return { attempted: false, refreshed: false, residences: [], reason: "lock_unavailable" };
    }
    if (!lockToken) {
        // Another request (or cron tick) is already refreshing this exact
        // city — this is the "100 concurrent Manchester requests -> ONE
        // refresh" guarantee. Never poll/wait here: the caller already has
        // its own stale-but-usable (or "building") response ready either way.
        // Best-effort lookup of the in-progress operation's identity, purely
        // for caller-side observability — never trusted for correctness (see
        // this function's own header and the schema field's own comment).
        let existingMeta = null;
        try {
            await connectToDatabase();
            existingMeta = await AccommodationIndexMeta.findOne({ city: normalizedCity }).select("operationId refreshStatus").lean();
        } catch (_) { /* best-effort only */ }
        log(`[Index] action=REFRESH_SKIPPED_ALREADY_IN_PROGRESS city=${normalizedCity}`);
        return {
            attempted: false, refreshed: false, residences: [], reason: "already_in_progress",
            operationId: existingMeta?.operationId || null,
            refreshStatus: existingMeta?.refreshStatus || "RUNNING",
        };
    }

    const operationId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const startedAt = Date.now();

    try {
        await connectToDatabase();
        await AccommodationIndexMeta.updateOne(
            { city: normalizedCity },
            { $set: { city: normalizedCity, operationId, refreshStatus: "RUNNING", refreshStartedAt: new Date(), lastAttemptedAt: new Date() } },
            { upsert: true }
        );
    } catch (err) {
        if (!(err instanceof MongoNotConfiguredError)) log(`[Index] action=REFRESH_ATTEMPT_STAMP_FAILED city=${normalizedCity} error=${err.message}`);
        // Best-effort stamp only — never blocks the actual refresh attempt below.
    }

    // The REAL operation. Its own completion — success or failure — always
    // records the true outcome and always releases the lock, entirely
    // independent of whether the code below is still awaiting it or has
    // already returned a RUNNING status to its own caller.
    const work = (async () => {
        try {
            const outcome = await refreshCityIndex(normalizedCity, priority, source);
            const durationMs = Date.now() - startedAt;
            try {
                await AccommodationIndexMeta.updateOne(
                    { city: normalizedCity, operationId },
                    { $set: { refreshStatus: outcome.refreshed ? "SUCCEEDED" : "FAILED", refreshCompletedAt: new Date() } }
                );
            } catch (_) { /* best-effort only — the lock release below is the real guarantee */ }
            log(`[Index] action=REFRESH_OPERATION_DONE city=${normalizedCity} operationId=${operationId} refreshed=${outcome.refreshed} residences=${outcome.residences.length} durationMs=${durationMs}`);
            return outcome;
        } catch (err) {
            try {
                await AccommodationIndexMeta.updateOne({ city: normalizedCity, operationId }, { $set: { refreshStatus: "FAILED", refreshCompletedAt: new Date() } });
            } catch (_) { /* best-effort only */ }
            throw err;
        } finally {
            await releaseLock(lockKey, lockToken);
        }
    })();
    // Never let an unawaited rejection become an unhandled promise rejection
    // just because a timeout below moves on before `work` settles.
    work.catch(() => {});

    if (!timeoutMs) {
        const outcome = await work;
        return { attempted: true, operationId, ...outcome };
    }

    const TIMED_OUT = Symbol("attemptCityRefresh_timeout");
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs); });
    const raceResult = await Promise.race([work, timeout]).finally(() => clearTimeout(timer));
    if (raceResult === TIMED_OUT) {
        log(`[Index] action=REFRESH_CALLER_TIMEOUT city=${normalizedCity} operationId=${operationId} timeoutMs=${timeoutMs}`);
        return { attempted: true, operationId, refreshed: false, residences: [], refreshStatus: "RUNNING" };
    }
    return { attempted: true, operationId, ...raceResult };
}

function readMongoResidences(normalizedCity) {
    return AccommodationResidence.find({ city: normalizedCity, available: true }).lean();
}

// Unlike readMongoResidences (Planner-only: available residences it might
// recommend), the general browse/search page shows BOTH available and
// sold-out properties (sold-out ones marked via `available`, same as the
// live Amber pipeline it's replacing already did) — a student browsing a
// city expects to see the whole picture, not just what's currently bookable.
function readAllMongoResidences(normalizedCity) {
    return AccommodationResidence.find({ city: normalizedCity }).lean();
}

function hasValidCoords(lat, lng) {
    return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

// Plain local Haversine (no library, no external API) — straight-line km
// between two lat/lng points.
function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371; // Earth's mean radius, km
    const toRad = (deg) => (deg * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Attaches `rankingDistanceKm` to a fresh copy of each doc — the single
// field rankResidences/assignBadges/toOutputShape read for "the distance to
// use for ranking", so its SOURCE is decided once, here, rather than
// implicitly by whichever raw field happens to be populated (a prior design
// pass had a bug where leaving stale distanceToCentreKm values in place for
// docs a distance step didn't touch made the whole geo upgrade a silent
// no-op — this function is written specifically to avoid that class of bug
// by always producing an explicit value, including explicit null).
//
// When a university with real coordinates is resolved: true Haversine
// distance for residences that ALSO have real coordinates; null for
// residences that don't (never falls back to the city-centre proxy for only
// SOME residences — mixing a true geographic distance with a city-centre-
// relative one within the same ranked list would be misleading).
//
// When no university is resolved at all: every residence uses its own
// Amber-reported distanceToCentreKm (Milestone 2 behavior, unchanged).
function attachRankingDistance(docs, university) {
    const universityHasCoords = !!university && hasValidCoords(university.latitude, university.longitude);
    return docs.map((d) => {
        let rankingDistanceKm = null;
        if (universityHasCoords) {
            if (hasValidCoords(d.latitude, d.longitude)) {
                rankingDistanceKm = haversineKm(university.latitude, university.longitude, d.latitude, d.longitude);
            }
        } else if (Number.isFinite(d.distanceToCentreKm)) {
            rankingDistanceKm = d.distanceToCentreKm;
        }
        return { ...d, rankingDistanceKm };
    });
}

const RADIUS_TIERS_KM = [5, 10, 15];
const MIN_RADIUS_RESULTS = 3;

// Tiered radius selection with a real result floor. Only applies when a
// university was resolved (radius is meaningless without a real reference
// point); otherwise every candidate stays in play (Milestone 2 behavior).
//
// Fix for a bug an earlier design review caught: a hard 15km ceiling with
// "return whatever's inside, even if 0" is NOT a floor — a city where most
// residences lack coordinates, or a genuinely large metro area, could
// legitimately return zero results, a regression from Milestone 2 always
// showing up to 5. Instead, if the widest tier still has fewer than
// MIN_RADIUS_RESULTS, the remaining candidates (farther than 15km, or with
// no distance at all) are appended as fallback pool — rankResidences'
// existing weight-redistribution already scores a null-distance doc fairly
// on its other factors, so this never fabricates a distance, just widens
// the CANDIDATE POOL. This is a pure in-memory re-filter of data already
// fetched once; it must never trigger another call into refreshCityIndex —
// "not enough results within radius" is a ranking-time condition, not a
// data-freshness one.
function applyRadius(docs, universityResolved) {
    if (!universityResolved) return docs;
    const withDistance = docs.filter((d) => Number.isFinite(d.rankingDistanceKm));
    const withoutDistance = docs.filter((d) => !Number.isFinite(d.rankingDistanceKm));

    for (const radius of RADIUS_TIERS_KM) {
        const tier = withDistance.filter((d) => d.rankingDistanceKm <= radius);
        if (tier.length >= MIN_RADIUS_RESULTS) return tier;
    }

    // Every tier came up short — return everything as a candidate pool;
    // ranking + the caller's top-N slice picks the best of what exists.
    return [...withDistance, ...withoutDistance];
}

// Deterministic, local ranking — no Amber, no LLM. distance 30% / budget 30%
// / rating 20% / preference 20%, with every factor guarded against the
// messy-real-data cases a design review caught: a single malformed distance
// string must not poison Math.min for the whole city; a tied/singleton
// distance set must not divide by zero; an unclamped budget score must not
// go negative; and if literally nothing is usable, everyone gets a neutral
// score instead of an arbitrary NaN-driven winner.
function rankResidences(docs, { budget, accommodationPreference }) {
    const hasBudget = Number(budget) > 0;
    const hasPreference = !!(accommodationPreference && String(accommodationPreference).trim());

    const finiteDistances = docs.map((d) => d.rankingDistanceKm).filter(Number.isFinite);
    const hasDistance = finiteDistances.length > 0;
    const minD = hasDistance ? Math.min(...finiteDistances) : null;
    const maxD = hasDistance ? Math.max(...finiteDistances) : null;

    const scored = docs.map((d) => {
        let distanceScore = null;
        if (hasDistance && Number.isFinite(d.rankingDistanceKm)) {
            distanceScore = maxD === minD ? 1 : 1 - (d.rankingDistanceKm - minD) / (maxD - minD);
        }
        const ratingScore = Number.isFinite(d.rating) ? Math.max(0, Math.min(1, d.rating / 5)) : null;
        // Prefer the normalized weekly-equivalent price for budget-fit
        // comparison (so a monthly-priced property isn't compared as a raw
        // number against a weekly budget); falls back to the raw amount when
        // priceWeekly is unavailable — also what keeps hand-built test
        // fixtures that only set price.amount (no priceWeekly) still
        // exercising real budget-clamping logic instead of silently no-op-ing.
        const effectivePrice = Number.isFinite(d.priceWeekly) ? d.priceWeekly : d.price?.amount;
        const budgetScore = hasBudget && Number.isFinite(effectivePrice)
            ? Math.max(0, 1 - Math.abs(effectivePrice - budget) / budget)
            : null;
        const preferenceScore = hasPreference
            ? (d.roomType && d.roomType.toLowerCase().includes(String(accommodationPreference).toLowerCase()) ? 1 : 0)
            : null;

        const weights = {
            distance: distanceScore != null ? 0.3 : 0,
            budget: budgetScore != null ? 0.3 : 0,
            rating: ratingScore != null ? 0.2 : 0,
            preference: preferenceScore != null ? 0.2 : 0,
        };
        const totalWeight = weights.distance + weights.budget + weights.rating + weights.preference;

        const matchScore = totalWeight === 0
            ? 50 // pathological: nothing usable at all — neutral, not an arbitrary winner
            : Math.round(100 * (
                (distanceScore ?? 0) * (weights.distance / totalWeight) +
                (budgetScore ?? 0) * (weights.budget / totalWeight) +
                (ratingScore ?? 0) * (weights.rating / totalWeight) +
                (preferenceScore ?? 0) * (weights.preference / totalWeight)
            ));

        return { doc: d, matchScore, totalWeight };
    });

    scored.sort((a, b) => b.matchScore - a.matchScore);
    // Data-dependent badges (Closest/Best Value) are only meaningful when the
    // underlying data actually varies — skip them entirely in the pathological
    // case where every candidate had zero usable weight, rather than badge an
    // arbitrary element.
    const skipDataBadges = scored.every((s) => s.totalWeight === 0);
    return assignBadges(scored, skipDataBadges);
}

function assignBadges(scored, skipDataBadges) {
    let closestIdx = -1;
    let bestValueIdx = -1;
    if (!skipDataBadges) {
        let bestDistance = Infinity;
        let bestPrice = Infinity;
        scored.forEach((s, i) => {
            const km = s.doc.rankingDistanceKm;
            if (Number.isFinite(km) && km < bestDistance) { bestDistance = km; closestIdx = i; }
            const amount = Number.isFinite(s.doc.priceWeekly) ? s.doc.priceWeekly : s.doc.price?.amount;
            if (Number.isFinite(amount) && amount < bestPrice) { bestPrice = amount; bestValueIdx = i; }
        });
    }
    const fillerBadges = ["Great Location", "Top Rated"];
    let fillerIdx = 0;

    return scored.map((s, i) => {
        let badge;
        if (i === 0) badge = "Best Overall"; // already sorted by matchScore desc
        else if (i === closestIdx) badge = "Closest";
        else if (i === bestValueIdx) badge = "Best Value";
        else badge = fillerBadges[fillerIdx++ % fillerBadges.length];
        return toOutputShape(s.doc, s.matchScore, badge);
    });
}

// Weekly-equivalent -> monthly-equivalent. Deliberately reuses priceWeekly
// (already null-safe: null for anything not confidently week/month, see
// computePriceWeekly) rather than re-deriving from price.amount/duration a
// second time — one normalization decision, not two that could disagree.
function computePriceMonthly(priceWeekly) {
    return Number.isFinite(priceWeekly) ? Math.round(priceWeekly * WEEKS_PER_MONTH) : null;
}

// Maps a Mongo residence doc (+ computed matchScore/badge) into the EXACT
// field shape Milestone 1's mock generator established, so ResidenceCard.js/
// RecommendedResidences.js/CompareResidencesTable.js need zero prop changes.
// Milestone 4 additive fields (latitude/longitude/priceMonthly) are new keys
// only — nothing existing was renamed or removed, so no consumer needs
// updating just because these were added.
function toOutputShape(doc, matchScore, badge) {
    const rawDistance = Number.isFinite(doc.rankingDistanceKm) ? doc.rankingDistanceKm : null;
    const distanceKm = rawDistance != null ? Math.round(rawDistance * 10) / 10 : null;
    // Never fabricate a marker location: only surface lat/lng when both are
    // real, finite, in-range numbers (same guard the ranking path already
    // uses via hasValidCoords) — otherwise explicit null, which the map
    // component (Milestone 4) treats as "no geographic marker for this one".
    const hasCoords = hasValidCoords(doc.latitude, doc.longitude);
    return {
        id: doc.propertyId,
        name: doc.propertyName,
        slug: doc.slug,
        image: doc.image,
        // Original amount + its REAL billing period — never silently
        // relabeled to "week" for display, even though ranking internally
        // compares a normalized weekly-equivalent (priceWeekly).
        price: { amount: doc.price?.amount ?? null, currency: doc.price?.currency ?? null, duration: doc.priceDuration || "week" },
        // Weekly/monthly-equivalents for budget-fit comparison (item 16) and
        // the Living Cost layer (item 13) — both null, never guessed, when
        // the underlying duration is unrecognized (see computePriceWeekly).
        priceWeekly: Number.isFinite(doc.priceWeekly) ? Math.round(doc.priceWeekly) : null,
        priceMonthly: computePriceMonthly(doc.priceWeekly),
        distanceKm,
        walkingMinutes: distanceKm != null ? Math.round(distanceKm * 12) : null,
        rating: { overall: doc.rating ?? null },
        roomType: doc.roomType,
        latitude: hasCoords ? doc.latitude : null,
        longitude: hasCoords ? doc.longitude : null,
        matchScore,
        badge,
    };
}

// A university's `accommodationOverride` (see universities.json /
// universityResolver.js) restricts that university's accommodation results
// to one or more SPECIFIC, already-known IVYHUTS properties by Amber slug —
// an explicit business rule, never a ranked/competitive search. Each slug is
// fetched via fetchAmber's existing type:"detail" (canonical_name) path —
// the exact same mechanism PropertyDetailPage.js already uses, so this
// shares that page's own cache entry (amber:detail:<slug>) and introduces
// zero new Amber call types or Mongo writes. Never throws: a property that
// fails to fetch is simply dropped, same "never crash the request"
// philosophy as getCityResidences below; if every slug fails, the result
// degrades to the same { status: "building", residences: [] } shape.
async function getOverrideResidences(slugs, { city, university, priority = "MEDIUM", source = "student-planner-override" } = {}) {
    const normalizedCity = normalizeCityName(city);
    const fetched = await Promise.all(slugs.map(async (slug) => {
        try {
            const result = await fetchAmber({ type: "detail", params: { slug }, priority, source });
            const item = extractResultArray(result.data)[0];
            return item ? mapAmberItemToResidence(item, normalizedCity) : null;
        } catch (err) {
            log(`[Planner] action=OVERRIDE_FETCH_FAILED slug=${slug} error=${err.message}`);
            return null;
        }
    }));
    const docs = fetched.filter(Boolean);
    if (!docs.length) return { status: "building", residences: [] };

    // Real distance when both the university and the property have real
    // coordinates (same rule attachRankingDistance already enforces for the
    // ordinary city-search path) — never fabricated.
    const withDistance = attachRankingDistance(docs, university);
    // No competitive ranking against other candidates — this is a fixed,
    // explicit list the business has already decided on, not a search
    // result, so rankResidences() is deliberately not used here.
    const residences = withDistance.map((doc) => toOutputShape(doc, 100, "IVYHUTS Recommended"));
    return { status: "ready", residences };
}

// The planner's one entry point. Never throws — every failure mode
// (Mongo not configured, Amber unavailable, city never indexed) degrades to
// { status: "building", residences: [] } rather than a crash.
// `university`, when provided, is `{ latitude, longitude }` for a resolved
// university — resolution itself happens in api/student-planner.js (this
// file stays purely "take coordinates in, rank," with zero knowledge of
// universities.json, so a broken/missing university dataset can only ever
// degrade request handling there, never this Amber-facing logic). Absent
// (every Milestone 2 caller/test) -> zero new lines execute beyond one
// falsy check; the already-verified city-only path is untouched.
async function getCityResidences(city, { budget, accommodationPreference, priority = "MEDIUM", source = "student-planner", university = null } = {}) {
    const normalizedCity = normalizeCityName(city);
    if (!normalizedCity) return { status: "building", residences: [] };

    try {
        await connectToDatabase();
    } catch (err) {
        if (err instanceof MongoNotConfiguredError) return { status: "building", residences: [] };
        throw err;
    }

    const meta = await AccommodationIndexMeta.findOne({ city: normalizedCity }).lean();
    const now = Date.now();
    const state = classifyCityState(meta, now);

    // Read Mongo FIRST, unconditionally — this is what lets every state
    // below answer "do we already have something to show" without a second
    // round-trip, and is what makes "stale data > empty data" (this
    // milestone's core policy) the natural default rather than something
    // each branch has to remember to do.
    let residenceDocs = await readMongoResidences(normalizedCity);
    const hasExistingData = residenceDocs.length > 0;

    if (state === "FRESH") {
        // Nothing further to do — Mongo is trusted as-is, zero Amber attempt.
    } else if (state === "STALE" || state === "FAILED_COOLDOWN") {
        // Serve what's already there immediately; request a background
        // refresh instead of making this request wait on one. FAILED_COOLDOWN
        // still queues (never blocks) — the cooldown only suppresses the
        // SYNCHRONOUS retry-every-request behavior this milestone removes,
        // it does not stop the background cron from eventually trying again
        // once its own attemptCityRefresh sees the cooldown has elapsed.
        requestBackgroundRefresh(normalizedCity);
    } else if (hasExistingData) {
        // MISSING/EXPIRED, but Mongo already has something — same policy as
        // STALE: stale-but-real data beats an empty/slow response.
        requestBackgroundRefresh(normalizedCity);
    } else {
        // The one case worth a bounded, request-blocking attempt: there is
        // LITERALLY nothing else to show this user. See
        // FIRST_LOOK_REFRESH_TIMEOUT_MS's own comment for why this is
        // shorter than the old always-block timeout it replaces, and why a
        // timeout here still queues a background attempt as a safety net.
        const outcome = await attemptCityRefresh(normalizedCity, priority, source, { timeoutMs: FIRST_LOOK_REFRESH_TIMEOUT_MS });
        residenceDocs = outcome.residences.length ? outcome.residences : await readMongoResidences(normalizedCity);
        if (!outcome.refreshed) requestBackgroundRefresh(normalizedCity);
    }

    if (!residenceDocs.length) return { status: "building", residences: [] };

    const universityResolved = !!university && hasValidCoords(university.latitude, university.longitude);
    const withDistance = attachRankingDistance(residenceDocs, university);
    const candidates = applyRadius(withDistance, universityResolved);

    const ranked = rankResidences(candidates, { budget, accommodationPreference }).slice(0, RESULT_LIMIT);
    return { status: "ready", residences: ranked };
}

// The general property browse/search page's entry point (api/city-listings.js)
// — same Mongo-first shape as getCityResidences above, but returns the WHOLE
// known city inventory instead of a ranked top-RESULT_LIMIT recommendation
// (there's no resolved university/budget to rank against on a plain city
// browse, and hiding all but 5 properties would defeat the point).
//
// This is what actually fixes a city like London only ever showing whatever
// Amber's own location filter + one page's worth of live pagination could
// return (confirmed live: 38, capped by Amber's own filter recognizing only
// that many — see amberGateway.js's fetchListings comment) despite Amber
// genuinely having 200+ London properties: refreshCityIndex()'s persistence
// is an upsert (see persistResidences), so it can only ADD to / update what's
// already indexed, never shrink it. Reading Mongo again AFTER a refresh
// therefore reflects the UNION of everything this city has ever had indexed
// — from this refresh, from every earlier real page view (index-on-read, see
// api/amber.js), and from the independent full-catalog crawl
// (api/_lib/insightsMarket.js) — not just whatever this one, budget-limited
// live call happened to find.
async function getCityListings(city, { priority = "MEDIUM", source = "listings-page" } = {}) {
    const normalizedCity = normalizeCityName(city);
    if (!normalizedCity) return { status: "building", residences: [] };

    try {
        await connectToDatabase();
    } catch (err) {
        if (err instanceof MongoNotConfiguredError) return { status: "building", residences: [] };
        throw err;
    }

    const meta = await AccommodationIndexMeta.findOne({ city: normalizedCity }).lean();
    const now = Date.now();
    const state = classifyCityState(meta, now);

    let residenceDocs = await readAllMongoResidences(normalizedCity);
    const hasExistingData = residenceDocs.length > 0;

    if (state === "FRESH") {
        // Nothing further to do.
    } else if (state === "STALE" || state === "FAILED_COOLDOWN") {
        // Existing data (if any) is already loaded above — request a
        // background refresh instead of blocking this response on one.
        requestBackgroundRefresh(normalizedCity);
    } else if (hasExistingData) {
        // MISSING/EXPIRED, but Mongo already has rows for this city — stale
        // data beats an empty/slow response (this milestone's core policy).
        requestBackgroundRefresh(normalizedCity);
    } else {
        // Nothing else to show — the one case worth a bounded,
        // request-blocking attempt. getCityListings returns the raw Mongo
        // mirror shape (not refreshCityIndex's in-memory mapped shape), so
        // it re-reads Mongo after the attempt rather than reusing
        // outcome.residences directly, matching this function's pre-existing
        // "always re-read Mongo after a refresh attempt" contract.
        const outcome = await attemptCityRefresh(normalizedCity, priority, source, { timeoutMs: FIRST_LOOK_REFRESH_TIMEOUT_MS });
        if (!outcome.refreshed) requestBackgroundRefresh(normalizedCity);
        residenceDocs = await readAllMongoResidences(normalizedCity);
    }

    if (!residenceDocs.length) return { status: "building", residences: [] };
    return { status: "ready", residences: residenceDocs };
}

// Milestone 11 (IVYHUTS_MILESTONE_11_FIND_ROOM_CANONICAL_MIGRATION_REPORT.md,
// Part 6/7): canonical, MULTI-CITY read for Find Room's `?country=` browse —
// replaces getPropertiesForCountry()'s old live-Amber per-city fan-out
// (up to COUNTRY_SEARCH_MAX_CITIES=6 real Amber calls per click) with ONE
// Mongo query across every requested city.
//
// Deliberately takes a CITY NAME LIST, not a country string. Real production
// data (checked directly, not assumed) shows AccommodationResidence.country
// stores Amber's own long-form names ("United Kingdom", "United States")
// while the frontend's curated DESTINATIONS dataset uses short codes ("UK") —
// matching on `country` would need a new normalization/alias table (exactly
// the "do not introduce duplicate country matching logic" trap Part 18 warns
// about). Matching on `city` instead needs NO new mapping at all: city names
// are already consistently normalized everywhere in this system
// (normalizeCityName, used identically by every other read path), and
// DESTINATIONS.js is already the one authoritative country->cities list the
// frontend uses to decide which cities to ask for — this function trusts
// that existing list rather than re-deriving or duplicating it.
//
// Deliberately READ-ONLY — never triggers a refresh for any city, per Part
// 7's explicit instruction ("do not silently supplement every request with
// live Amber... the refresh pipeline is responsible for completeness").
// Whatever a city already has indexed is returned as-is; a city with
// nothing indexed yet simply contributes zero rows to the combined result,
// exactly like Find Room's own single-city path already does before its
// first refresh completes.
async function getCitiesListings(cityNames) {
    const normalizedCities = Array.from(new Set((Array.isArray(cityNames) ? cityNames : []).map(normalizeCityName).filter(Boolean)));
    if (!normalizedCities.length) return { status: "building", residences: [] };

    try {
        await connectToDatabase();
    } catch (err) {
        if (err instanceof MongoNotConfiguredError) return { status: "building", residences: [] };
        throw err;
    }

    const residenceDocs = await AccommodationResidence.find({ city: { $in: normalizedCities } }).lean();
    if (!residenceDocs.length) return { status: "building", residences: [] };
    return { status: "ready", residences: residenceDocs };
}

module.exports = {
    getCityResidences,
    getCitiesListings,
    getCityListings,
    getOverrideResidences,
    rankResidences,
    mapAmberItemToResidence,
    resolvePropertyAvailability,
    parseDistanceKm,
    refreshCityIndex,
    haversineKm,
    hasValidCoords,
    attachRankingDistance,
    applyRadius,
    computePriceWeekly,
    computePriceMonthly,
    normalizeDuration,
    deriveResidencePricing,
    selectCheapestAvailableTenancy,
    isChildRoomAvailable,
    // Exported for api/amber.js's "index-on-read" hook (see api/_lib/searchIndex.js
    // header comment) — lets any successful Amber response opportunistically
    // upsert into AccommodationResidence without duplicating this upsert logic.
    persistResidences,
    // Exported for api/_lib/insightsMarket.js's full-catalog crawl — see
    // persistResidencesRaw's own header comment for why it needs the raw
    // (no single-city Meta write) form.
    persistResidencesRaw,
    extractResultArray,
    // Milestone 4 (inventory refresh reliability) — exported for
    // cacheWarmer.js's queue-draining step and for
    // scripts/verify-milestone-4-inventory-refresh.js. See
    // IVYHUTS_MILESTONE_4_INVENTORY_REFRESH_REPORT.md for the full design.
    classifyCityState,
    requestBackgroundRefresh,
    drainRefreshQueue,
    attemptCityRefresh,
    FRESH_AGE_MS,
    MAX_AGE_MS,
    REFRESH_FAILURE_COOLDOWN_MS,
    FIRST_LOOK_REFRESH_TIMEOUT_MS,
    REFRESH_TARGET_COUNT,
    REFRESH_QUEUE_KEY,
};
