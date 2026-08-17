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
const { log } = require("./sharedStore");

// Fresh (<30min) and stale-but-usable (<24h) are behaviorally identical here
// — both just read Mongo with zero Amber attempts — so there is deliberately
// only one threshold in code. The 30min/24h split is a conceptual one (see
// the plan doc), not a code branch: anything under MAX_AGE_MS skips Amber.
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
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

// Raw Amber item -> index-row shape. Deliberately a small self-contained
// subset of src/services/amberMapper.js's logic, not an import — that file
// is an ES module for CRA's webpack pipeline; api/_lib is plain CommonJS
// with no build step (same reason cacheWarmer.js duplicates the UK-cities
// list instead of importing src/data/destinations.js).
function mapAmberItemToResidence(raw, normalizedCity) {
    const propertyId = raw?.id != null ? String(raw.id) : null;
    if (!propertyId || !raw?.name) return null;
    const pricing = raw.pricing || {};
    const priceAmount = toNumber(pricing.min_price ?? pricing.available_price ?? pricing.price);
    const priceDuration = normalizeDuration(pricing.duration);
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
            currency: currencySymbol(pricing.currency),
        },
        priceDuration,
        priceWeekly: computePriceWeekly(priceAmount, priceDuration),
        image: getPrimaryImage(raw),
        rating: getRating(raw),
        roomType: getRoomType(raw),
        distanceToCentreKm: getCityCentreDistanceKm(raw),
        nearbyUniversities: getNearbyUniversities(raw),
        available: raw.available !== false,
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
async function persistResidencesRaw(mapped) {
    await Promise.all(
        mapped.map((doc) =>
            AccommodationResidence.updateOne({ source: doc.source, propertyId: doc.propertyId }, { $set: doc }, { upsert: true }).catch((err) => {
                if (err && err.code === 11000) return; // benign concurrent-insert race — see comment above
                throw err;
            })
        )
    );
}

// Persists one refreshed SINGLE-CITY batch — ONLY called for the caller that
// observed cacheStatus:"MISS" (see refreshCityIndex). Also updates this
// city's AccommodationIndexMeta freshness row, which only makes sense when
// every doc in `mapped` really does belong to `normalizedCity` (true for
// every existing caller of this function — a per-city fetchListings result).
async function persistResidences(normalizedCity, mapped) {
    await persistResidencesRaw(mapped);
    await AccommodationIndexMeta.updateOne(
        { city: normalizedCity },
        { $set: { city: normalizedCity, lastRefreshedAt: new Date(), status: mapped.length ? "ok" : "empty", residenceCount: mapped.length } },
        { upsert: true }
    ).catch((err) => {
        if (err && err.code === 11000) return;
        throw err;
    });
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
        result = await fetchListings({ city: normalizedCity, page: 1, limit: 50 }, priority, source);
    } catch (err) {
        log(`[Planner] action=REFRESH_FAILED city=${normalizedCity} error=${err.message}`);
        try {
            await AccommodationIndexMeta.updateOne({ city: normalizedCity }, { $set: { city: normalizedCity, status: "error" } }, { upsert: true });
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
            await persistResidences(normalizedCity, mapped);
        } catch (err) {
            // A real (non-11000) Mongo failure here must not fail the request —
            // this caller still has good in-memory data to return.
            log(`[Planner] action=PERSIST_FAILED city=${normalizedCity} error=${err.message}`);
        }
    }

    return { residences: mapped, refreshed: true };
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
    const age = meta?.lastRefreshedAt ? now - new Date(meta.lastRefreshedAt).getTime() : Infinity;

    let residenceDocs;
    if (meta && age < MAX_AGE_MS) {
        // Fresh or stale-but-usable — read Mongo only, deliberately no Amber
        // attempt at all (mirrors amberGateway's own "serve stale now, let a
        // future truly-expired request do the one coordinated refresh").
        residenceDocs = await readMongoResidences(normalizedCity);
    } else {
        const { residences: refreshed } = await refreshCityIndex(normalizedCity, priority, source);
        residenceDocs = refreshed.length ? refreshed : await readMongoResidences(normalizedCity);
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
    const age = meta?.lastRefreshedAt ? now - new Date(meta.lastRefreshedAt).getTime() : Infinity;

    if (!meta || age >= MAX_AGE_MS) {
        // Never throws (see refreshCityIndex) — a failed/slow Amber refresh
        // just means this cycle's read below falls back to whatever was
        // already indexed from before, same degrade-to-known-data contract
        // as every other caller of this function.
        await refreshCityIndex(normalizedCity, priority, source);
    }

    const residenceDocs = await readAllMongoResidences(normalizedCity);
    if (!residenceDocs.length) return { status: "building", residences: [] };
    return { status: "ready", residences: residenceDocs };
}

module.exports = {
    getCityResidences,
    getCityListings,
    getOverrideResidences,
    rankResidences,
    mapAmberItemToResidence,
    parseDistanceKm,
    refreshCityIndex,
    haversineKm,
    hasValidCoords,
    attachRankingDistance,
    applyRadius,
    computePriceWeekly,
    computePriceMonthly,
    normalizeDuration,
    // Exported for api/amber.js's "index-on-read" hook (see api/_lib/searchIndex.js
    // header comment) — lets any successful Amber response opportunistically
    // upsert into AccommodationResidence without duplicating this upsert logic.
    persistResidences,
    // Exported for api/_lib/insightsMarket.js's full-catalog crawl — see
    // persistResidencesRaw's own header comment for why it needs the raw
    // (no single-city Meta write) form.
    persistResidencesRaw,
    extractResultArray,
};
