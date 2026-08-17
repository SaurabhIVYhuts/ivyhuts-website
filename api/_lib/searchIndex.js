// Global search entity layer — backs /api/search (api/search.js), which
// powers the homepage/find-rooms universal search bar's autocomplete.
//
// Sources, each queried the same way regardless of which entity type it
// represents:
//   - cities/countries : api/_lib/destinations.json (curated — name, flag,
//     description, hero image, used by the homepage/country-browse UI) MERGED
//     with the full-catalog crawl's real, comprehensive country/city coverage
//     (api/_lib/insightsMarket.js's lightweight `search:locationIndex:v1`
//     summary, maintained as part of that crawl's existing 5-minute cron —
//     see loadCrawlEntities() below) so a real Amber market IVYHUTS hasn't
//     hand-curated (e.g. Galway, Cork alongside the curated Dublin) is still
//     searchable/navigable, not just the curated shortlist.
//   - universities      : api/_lib/campusUniversities.json (curated —
//     canonical id, coordinates, hand-verified aliases, see
//     src/lib/campusUniversityResolver.js) MERGED with every REAL
//     university/college name extracted from the inventory itself (see
//     loadExtractedUniversities() below, and accommodationIndex.js's
//     getNearbyUniversities) — Amber's payload has no authoritative
//     "university" field, only free-text nearby-place names, but those are
//     real data the property itself reported, not fabricated. The curated
//     record always wins for a name both sources agree on (real coordinates,
//     verified aliases); an extracted-only match still becomes a searchable
//     entity, just without a canonical id — see searchUniversities' second
//     loop and searchNavigation.js's fallback for how it's still navigable.
//   - properties        : the AccommodationResidence Mongo mirror. Populated
//     two ways: opportunistically by every real listings/detail response the
//     site serves (api/amber.js's indexOnRead), AND — comprehensively — by
//     api/_lib/insightsMarket.js's existing resumable full-catalog crawl
//     (see persistCrawlItemsToSearchIndex there), which already pages
//     through Amber's ENTIRE catalog on its existing 5-minute cron for
//     market-intelligence purposes. Reusing that crawl's own already-fetched
//     pages to also populate this collection means a property that has NEVER
//     been opened by any user still becomes searchable, with zero additional
//     Amber traffic beyond what that crawl already generates. One full crawl
//     pass takes roughly an hour; until it completes (or after its ~26h
//     state TTL restarts it), coverage is "index-on-read plus whatever the
//     crawl has reached so far" rather than instantly complete.
//
// Ranking follows the product spec's stated priority: exact property > exact
// university > exact city > exact country > partial match of any type.
"use strict";

const { connectToDatabase, MongoNotConfiguredError } = require("./mongodb");
const AccommodationResidence = require("./models/AccommodationResidence");
const DESTINATIONS = require("./destinations.json");
const CAMPUS_UNIVERSITIES = require("./campusUniversities.json");
const { withTimeout } = require("./withTimeout");
const { log } = require("./sharedStore");
const { haversineKm, hasValidCoords } = require("./accommodationIndex");
const { loadLocationIndex } = require("./insightsMarket");

// connectToDatabase() uses a 10s serverSelectionTimeoutMS (see
// api/_lib/mongodb.js) — the right call for features that need Mongo to
// function, but property search here is best-effort on top of city/
// university/country matches that are always instant (pure in-memory).
// Bounding it hard means the autocomplete endpoint NEVER feels broken just
// because Mongo is slow, unreachable, or (in a fresh/local environment)
// simply not configured — it just quietly returns fewer property matches
// for that one request.
const PROPERTY_SEARCH_TIMEOUT_MS = 800;

// Extracted to its own file (rather than an inline literal, as this used to
// be) since api/_lib/insightsMarket.js now needs the exact same code<->full
// name mapping to build search-data.json's country aliases — a third
// hand-copied literal would be exactly the duplication this codebase's own
// "hand-synced twin" convention exists to avoid where a real shared module
// is possible (both files are already CommonJS in api/_lib, no ESM boundary
// blocking a plain shared require here).
const COUNTRY_FULL_NAMES = require("./countryFullNames.json");
function countryFullName(code) {
    return COUNTRY_FULL_NAMES[code] || code;
}

// The crawl's country buckets are keyed by Amber's own real full country
// name (e.g. "United Kingdom"), not the curated short code destinations.json
// uses ("UK") — needed so a crawl-derived country reuses the SAME `code`
// value the curated system already navigates with (?country=UK), instead of
// minting a second, incompatible identity for the same real country. Most
// curated codes already equal their full name (Canada -> "Canada"), so this
// reverse map only actually changes anything for the handful that don't
// (UK, USA, UAE).
const FULL_NAME_TO_CODE = Object.fromEntries(
    Object.entries(COUNTRY_FULL_NAMES).map(([code, full]) => [full, code])
);

const COUNTRIES = (() => {
    const byCode = new Map();
    for (const d of DESTINATIONS) {
        if (!byCode.has(d.country)) byCode.set(d.country, { code: d.country, cityCount: 0 });
        byCode.get(d.country).cityCount += 1;
    }
    return Array.from(byCode.values());
})();

// In-memory, per-warm-instance cache of the crawl's LIGHTWEIGHT country/city
// summary (api/_lib/insightsMarket.js's search:locationIndex:v1 — a few
// hundred name pairs, NOT the ~928KB full crawl-state blob) — refreshed at
// most every CRAWL_ENTITIES_TTL_MS, matching the crawl's own 5-minute
// advance cadence, so autocomplete never pays even the small Redis round-trip
// on every keystroke. Same "shadow cache" spirit as amberGateway.js's own
// module-level cache, just for a different value.
//
// IMPORTANT: this used to read the FULL crawl state directly (loadCrawlState,
// insightsMarket.js) on every cold cache miss — confirmed live to take
// ~1-1.5s to fetch+parse a ~928KB blob, well past the timeout below, so a
// cold request silently fell back to curated-only coverage even though the
// real (comprehensive) data existed. The fix was NOT to raise the timeout
// (that just makes a cold request slow instead of wrong) — it was to stop
// reading the large blob from the search path at all. insightsMarket.js now
// maintains a small, purpose-built summary as part of its OWN existing
// 5-minute cron cycle (see saveLocationIndex there); this only ever reads
// that small artifact, so even a genuinely cold cache is fast.
let crawlEntitiesCache = null;
let crawlEntitiesCacheAt = 0;
const CRAWL_ENTITIES_TTL_MS = 5 * 60 * 1000;
// Confirmed live: the ~27KB summary itself fetches in ~440ms — dominated by
// fixed Upstash REST round-trip latency, not payload size (the 34x smaller
// payload already cut this from the full blob's ~1-1.5s, which was the
// actual fix). 700ms leaves headroom for ordinary network jitter without
// papering over a real regression — if this value needs to keep climbing,
// that's a signal the payload/network path broke again, not something to
// silently tolerate by keeping pushing the number up.
const CRAWL_ENTITIES_TIMEOUT_MS = 700;

// Real, comprehensive country/city coverage derived from Amber's actual
// inventory — NOT the curated destinations.json shortlist. Best-effort: any
// failure (crawl never run yet, shared store unreachable) degrades to "no
// extra entities" (search still works from the curated list alone, same
// fallback philosophy as searchProperties()) but is always LOGGED, never
// silently absorbed — a location-index outage should be visible in server
// logs even though it must never break the user-facing response.
async function loadCrawlEntities() {
    if (crawlEntitiesCache && Date.now() - crawlEntitiesCacheAt < CRAWL_ENTITIES_TTL_MS) {
        return crawlEntitiesCache;
    }
    let result = { countries: [], cities: [] };
    try {
        const summary = await loadLocationIndex();
        if (summary) {
            const countries = summary.countries.map((c) => ({
                code: FULL_NAME_TO_CODE[c.name] || c.name,
                fullName: c.name,
                cityCount: c.cityCount,
            }));
            const cities = summary.cities.map((c) => ({
                name: c.name,
                country: FULL_NAME_TO_CODE[c.country] || c.country,
            }));
            result = { countries, cities };
        } else {
            log("[searchIndex] action=LOCATION_INDEX_MISSING — falling back to curated destinations.json only (the crawl hasn't completed a tick since this summary was introduced)");
        }
    } catch (err) {
        log(`[searchIndex] action=LOCATION_INDEX_LOAD_FAILED error=${err.message}`);
    }
    crawlEntitiesCache = result;
    crawlEntitiesCacheAt = Date.now();
    return result;
}

function normalize(str) {
    return String(str || "").toLowerCase().replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim();
}

// Small, deliberately bounded Levenshtein — only ever run on short tokens
// (city/country/university names, a handful of candidates), never on the
// Mongo-backed property search below (that uses a regex, not this).
function levenshtein(a, b) {
    if (a === b) return 0;
    const al = a.length, bl = b.length;
    if (al === 0) return bl;
    if (bl === 0) return al;
    let prev = Array.from({ length: bl + 1 }, (_, i) => i);
    for (let i = 1; i <= al; i++) {
        const cur = [i];
        for (let j = 1; j <= bl; j++) {
            cur[j] = a[i - 1] === b[j - 1]
                ? prev[j - 1]
                : 1 + Math.min(prev[j - 1], prev[j], cur[j - 1]);
        }
        prev = cur;
    }
    return prev[bl];
}

// rank: 0 exact, 1 prefix (whole-string OR a whole word inside it starts
// with the query — "venti" against "LST Venti House" must rank as a strong
// match, not get buried behind an unrelated mid-string substring hit),
// 2 substring, 3 typo-tolerant fuzzy, null = no match.
function matchRank(haystackNorm, qNorm) {
    if (!qNorm) return null;
    if (haystackNorm === qNorm) return 0;
    if (haystackNorm.startsWith(qNorm)) return 1;
    const tokens = haystackNorm.split(" ");
    // Word-boundary prefix ("venti" -> "LST Venti House") only counts for
    // queries of 4+ chars — below that a short token match is too weak a
    // signal (a 2-letter query like "uk" would otherwise spuriously rank
    // "University of Derby" strongly just because its alias "University of
    // Derby UK" ends in a token that happens to equal it).
    if (qNorm.length >= 4 && tokens.some((t) => t.startsWith(qNorm))) return 1;
    if (haystackNorm.includes(qNorm)) return 2;
    // Multi-word query, each word matched independently against SOME word in
    // the haystack, any order ("univ tor" -> "University of Toronto",
    // "toronto university" -> the same, reversed). Each query word must be
    // 2+ chars so this can't degenerate into a trivial single-letter match.
    const qWords = qNorm.split(" ").filter(Boolean);
    if (qWords.length > 1 && qWords.every((w) => w.length >= 2) && qWords.every((qw) => tokens.some((hw) => hw.startsWith(qw)))) {
        return 2;
    }
    if (qNorm.length < 4) return null; // too short for fuzzy tolerance — 3-letter queries get too many false positives (e.g. "lon" ~ "Lyon")
    const maxDist = qNorm.length > 5 ? 2 : 1;
    const fuzzy = tokens.some((t) => t.length >= 3 && levenshtein(t.slice(0, qNorm.length + maxDist), qNorm) <= maxDist);
    return fuzzy ? 3 : null;
}

// `extraCities`/`extraCountries` come from the real-inventory crawl (see
// loadCrawlEntities) — merged in ADDITIVELY, deduped against the curated
// destinations.json entries considered first, so a curated entry's richer
// display data always wins on conflict and only genuinely uncurated real
// markets/cities show up as the "extra" ones.
function searchCities(qNorm, limit, extraCities = []) {
    const out = [];
    const seen = new Set();
    const consider = (name, countryCode) => {
        const key = normalizeCityKey(name);
        if (seen.has(key)) return;
        const rank = matchRank(normalize(name), qNorm);
        if (rank == null) return;
        seen.add(key);
        out.push({ type: "city", id: name, label: name, sublabel: countryFullName(countryCode), value: { city: name, country: countryCode }, rank });
    };
    for (const d of DESTINATIONS) consider(d.name, d.country);
    for (const c of extraCities) consider(c.name, c.country);
    out.sort((a, b) => a.rank - b.rank);
    return out.slice(0, limit);
}

function searchCountries(qNorm, limit, extraCountries = []) {
    const out = [];
    const seen = new Set();
    const consider = (code, fullName, cityCount) => {
        if (seen.has(code)) return;
        const rank = Math.min(matchRank(normalize(fullName), qNorm) ?? 99, matchRank(normalize(code), qNorm) ?? 99);
        if (rank === 99) return;
        seen.add(code);
        out.push({ type: "country", id: code, label: fullName, sublabel: `${cityCount} ${cityCount === 1 ? "city" : "cities"}`, value: { country: code }, rank });
    };
    for (const c of COUNTRIES) consider(c.code, countryFullName(c.code), c.cityCount);
    for (const c of extraCountries) consider(c.code, c.fullName, c.cityCount);
    out.sort((a, b) => a.rank - b.rank);
    return out.slice(0, limit);
}

// A strong (exact/prefix) country match also surfaces a few of that
// country's cities — "can" should suggest Toronto/Vancouver, not just the
// literal word "Canada". Draws from both the curated destinations.json list
// AND the crawl's real cities for that country (`extraCities`), so e.g.
// "Ireland" surfaces Galway/Cork alongside the curated Dublin. Never
// displaces a genuine direct city-name match, only fills remaining room.
function citiesForCountries(countryMatches, existingCityNames, limit, extraCities = []) {
    const out = [];
    for (const c of countryMatches) {
        if (c.rank > 1) continue; // only a confident (exact/prefix) country match implies its cities
        const candidates = [
            ...DESTINATIONS.filter((d) => d.country === c.id).map((d) => ({ name: d.name, country: d.country })),
            ...extraCities.filter((e) => e.country === c.id),
        ];
        for (const d of candidates) {
            if (existingCityNames.has(d.name) || out.some((o) => o.id === d.name)) continue;
            out.push({ type: "city", id: d.name, label: d.name, sublabel: countryFullName(d.country), value: { city: d.name, country: d.country }, rank: 2 });
            if (out.length >= limit) return out;
        }
    }
    return out;
}

// Same normalization amberGateway.js's normalizeCityName uses — duplicated
// rather than imported (see this repo's existing convention for small
// primitives shared across the api/_lib boundary, e.g. haversineKm) so this
// city query matches how AccommodationResidence.city was actually stored.
function normalizeCityKey(city) {
    return String(city || "").trim().toLowerCase().replace(/\s+/g, " ");
}

// A strong university match also surfaces a few real properties near it —
// "birk" should suggest Birkbeck AND nearby properties, not just the
// institution itself. Priority (per product spec): explicit university
// association (not modeled anywhere in this codebase's data today, so never
// claimed) > real proximity (Haversine, only when BOTH the university and
// the property have real coordinates) > same city as a fallback for
// properties with no coordinates. Never fabricates a distance — a property
// without real coordinates simply carries no distance and sorts after every
// property that has one, exactly like PropertyListingPage's own
// distance-from-university sort (src/pages/PropertyListingPage.js). Runs
// over the FULL AccommodationResidence collection for that city, which since
// the full-catalog crawl started also indexing (see this file's header) is
// no longer limited to properties a user has actually opened. Best-effort
// like searchProperties itself: any Mongo failure just yields no extra
// suggestions, never breaks the response.
async function propertiesForUniversities(universityMatches, limit) {
    // Only curated matches (a real campusUniversities.json id) have the
    // verified coordinates/city this lookup needs — an extracted match's
    // own entity value (city + near) already IS its navigation target, no
    // separate preview lookup required.
    const strong = universityMatches.filter((u) => u.rank <= 1 && u.value?.universityId);
    if (!strong.length) return [];
    try {
        await connectToDatabase();
    } catch (err) {
        return [];
    }
    const out = [];
    const seenCities = new Set();
    const seenPropertyIds = new Set();
    for (const match of strong) {
        const uni = CAMPUS_UNIVERSITIES.find((c) => c.id === match.id);
        if (!uni?.city) continue;
        const cityKey = normalizeCityKey(uni.city);
        if (seenCities.has(cityKey)) continue;
        seenCities.add(cityKey);
        const uniHasCoords = hasValidCoords(uni.latitude, uni.longitude);
        try {
            // Over-fetch relative to `limit` so real distance — not whichever
            // order Mongo happened to return — decides which properties are
            // "closest" before the final slice. No `available` filter here —
            // search DISCOVERY is deliberately separate from booking
            // availability (a sold-out property is still real inventory,
            // useful for recognition/market intelligence per product spec);
            // the actual property listing/booking pages keep their own
            // existing availability rules untouched. `available` is carried
            // through on each result so a consumer CAN distinguish if it wants to.
            const docs = await AccommodationResidence.find({ city: cityKey }).limit(Math.min(limit * 6, 60)).lean();
            const withDistance = docs.map((d) => {
                const distanceKm = uniHasCoords && hasValidCoords(d.latitude, d.longitude)
                    ? Math.round(haversineKm(uni.latitude, uni.longitude, d.latitude, d.longitude) * 10) / 10
                    : null;
                return { d, distanceKm };
            });
            withDistance.sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity));
            for (const { d, distanceKm } of withDistance) {
                if (seenPropertyIds.has(d.propertyId)) continue;
                seenPropertyIds.add(d.propertyId);
                out.push({
                    type: "property", id: d.propertyId, slug: d.slug, label: d.propertyName,
                    sublabel: distanceKm != null ? `${distanceKm} km from ${uni.name}` : [d.city, d.country].filter(Boolean).join(", "),
                    value: { slug: d.slug, city: d.city },
                    image: d.image || null,
                    price: d.price?.amount != null ? { amount: d.price.amount, currency: d.price.currency, duration: d.priceDuration } : null,
                    available: d.available,
                    rank: 2,
                });
                if (out.length >= limit) break;
            }
        } catch (err) {
            // Best-effort — this university's city query failed; move on.
        }
        if (out.length >= limit) break;
    }
    return out.slice(0, limit);
}

// In-memory, per-warm-instance cache of every DISTINCT real university/
// college name extracted from the inventory (see accommodationIndex.js's
// getNearbyUniversities) — same TTL/refresh philosophy as loadCrawlEntities
// above (a $unwind aggregation over the whole collection is not something to
// re-run on every keystroke).
let extractedUniversitiesCache = null;
let extractedUniversitiesCacheAt = 0;
const EXTRACTED_UNIVERSITIES_TTL_MS = 5 * 60 * 1000;
const EXTRACTED_UNIVERSITIES_TIMEOUT_MS = 500;

// Every REAL university/college name actually present in the inventory —
// not just the ~26 hand-curated in campusUniversities.json. Each one
// carries a real city/country (from the property that reported it) so it's
// independently searchable/navigable (see searchUniversities' `curated:
// false` branch and searchNavigation.js's fallback for entities with no
// canonical universityId). Best-effort: any failure (Mongo down/not
// configured, or simply nothing indexed yet) degrades to "no extra
// universities" — the curated list alone still works, same fallback
// philosophy as every other Mongo-touching lookup in this file.
async function loadExtractedUniversities() {
    if (extractedUniversitiesCache && Date.now() - extractedUniversitiesCacheAt < EXTRACTED_UNIVERSITIES_TTL_MS) {
        return extractedUniversitiesCache;
    }
    let result = [];
    try {
        await connectToDatabase();
        const rows = await AccommodationResidence.aggregate([
            { $match: { nearbyUniversities: { $exists: true, $ne: [] } } },
            { $unwind: "$nearbyUniversities" },
            { $group: { _id: "$nearbyUniversities", city: { $first: "$city" }, country: { $first: "$country" } } },
        ]);
        result = rows.map((r) => ({ name: r._id, city: r.city, country: r.country }));
    } catch (err) {
        // Mongo not configured/unreachable, or nothing indexed yet — fall
        // through to the empty result already set above.
    }
    extractedUniversitiesCache = result;
    extractedUniversitiesCacheAt = Date.now();
    return result;
}

// `extraUniversities` (see loadExtractedUniversities) are real names pulled
// straight from Amber's own nearby-place data — merged in ADDITIVELY,
// deduped against the curated list so the SAME real institution (already
// hand-verified with a canonical id/coordinates/aliases) is never shown
// twice under two different identities.
function searchUniversities(qNorm, limit, extraUniversities = []) {
    const out = [];
    const seen = new Set();
    for (const u of CAMPUS_UNIVERSITIES) {
        const haystacks = [u.name, ...(u.aliases || [])].map(normalize);
        const rank = haystacks.reduce((best, h) => {
            const r = matchRank(h, qNorm);
            return r != null && r < best ? r : best;
        }, 99);
        seen.add(normalize(u.name));
        if (rank === 99) continue;
        out.push({
            type: "university", id: u.id, label: u.name,
            sublabel: [u.city, u.country].filter(Boolean).join(", "),
            value: { universityId: u.id }, rank,
        });
    }
    for (const u of extraUniversities) {
        const key = normalize(u.name);
        if (seen.has(key)) continue; // already represented by a curated, hand-verified record
        const rank = matchRank(key, qNorm);
        if (rank == null) continue;
        seen.add(key);
        out.push({
            type: "university", id: `extracted:${key}`, label: u.name,
            sublabel: [u.city, u.country].filter(Boolean).join(", "),
            // No canonical universityId to navigate with (this wasn't
            // hand-curated with coordinates/aliases) — navigates via the
            // SAME city + "University / Area" proximity filter
            // PropertyListingPage.js already implements, seeded with this
            // exact place name so it only shows properties actually near it.
            value: { city: u.city, near: u.name }, rank,
        });
    }
    out.sort((a, b) => a.rank - b.rank);
    return out.slice(0, limit);
}

// Regex substring match rather than $text — a $text search tokenizes on
// whole words with stemming, which misses exactly the "partial word" case
// the product spec calls out ("LST Vent" -> "LST Venti House"). The text
// index (AccommodationResidence's `search_text`) still exists for future use
// (e.g. a relevance-scored fallback), but for a name/city-prefix search a
// plain case-insensitive regex is what actually satisfies the spec. Fine at
// this collection's expected size (index-on-read growth, not a full crawl —
// see this file's header) since it isn't scanning Amber's full catalog.
// Wrapped in one top-level try/catch that swallows EVERY failure mode, not
// just MongoNotConfiguredError — property matching is best-effort on top of
// city/university/country matches that must always work regardless of
// Mongo's state. This is deliberately NOT relying on withTimeout (see this
// module's PROPERTY_SEARCH_TIMEOUT_MS caller) for that safety: a Promise
// race only protects against a SLOW/hanging promise — if the underlying
// promise instead rejects FAST (a real connection error: bad URI, auth
// failure, ECONNREFUSED — not just "slow"), Promise.race relays that
// rejection immediately, which previously took the entire /api/search
// response down with it (confirmed live: an exact "University College
// London" match failed to resolve because this function's Mongo error
// propagated all the way out instead of degrading to "no property matches").
async function searchProperties(query, limit) {
    try {
        return await searchPropertiesUnsafe(query, limit);
    } catch (err) {
        return [];
    }
}

async function searchPropertiesUnsafe(query, limit) {
    try {
        await connectToDatabase();
    } catch (err) {
        if (err instanceof MongoNotConfiguredError) return [];
        throw err;
    }
    const q = String(query || "").trim();
    if (!q) return [];
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(escaped, "i");
    // No `available` filter — a sold-out property is still real inventory
    // and should remain discoverable by search (product requirement: search
    // discovery is separate from booking availability). `available` is
    // carried through on each result so a consumer CAN distinguish if it wants to.
    const docs = await AccommodationResidence.find({ propertyName: regex })
        .limit(limit * 3) // over-fetch a little so exact/prefix matches can be ranked ahead of mid-string ones
        .lean();

    // Ranked with the SAME matchRank tiers cities/universities/countries use
    // (see this file's header) rather than a separate ad hoc scheme — a
    // property whose name merely contains the query mid-word (rank 2) must
    // never outrank an obvious city/university match shown alongside it.
    const qNorm = normalize(q);
    return docs
        .map((d) => {
            const rank = matchRank(normalize(d.propertyName), qNorm) ?? 2;
            return {
                type: "property", id: d.propertyId, slug: d.slug, label: d.propertyName,
                sublabel: [d.city, d.country].filter(Boolean).join(", "),
                value: { slug: d.slug, city: d.city },
                image: d.image || null,
                price: d.price?.amount != null ? { amount: d.price.amount, currency: d.price.currency, duration: d.priceDuration } : null,
                available: d.available,
                rank,
            };
        })
        .sort((a, b) => a.rank - b.rank)
        .slice(0, limit);
}

// Single "best" pick across every group, per the spec's stated priority:
// exact property > exact university > exact city > exact country > partial.
// Used when a caller (e.g. a raw text submit, or /properties?property=)
// needs one answer instead of a grouped dropdown.
const TYPE_PRIORITY = { property: 0, university: 1, city: 2, country: 3 };
function pickBest(groups) {
    let best = null;
    for (const type of Object.keys(groups)) {
        for (const item of groups[type]) {
            if (!best || item.rank < best.rank || (item.rank === best.rank && TYPE_PRIORITY[item.type] < TYPE_PRIORITY[best.type])) {
                best = item;
            }
        }
    }
    return best;
}

// "best" is only safe for a caller to navigate on BLINDLY (no explicit user
// selection — e.g. pressing Enter with nothing highlighted) when it isn't
// actually a coin flip between two different entities. An exact (rank 0)
// match is always confident even if something else also matched — an exact
// hit beats every ambiguity concern. Anything weaker is confident only if
// it's the UNIQUE top-ranked item across every group; if a rank-1 property
// match and a rank-1 university match are tied, the user must choose.
function isBestConfident(best, groups) {
    if (!best) return false;
    if (best.rank === 0) return true;
    let tiedCount = 0;
    for (const type of Object.keys(groups)) {
        for (const item of groups[type]) {
            if (item.rank === best.rank) tiedCount += 1;
        }
    }
    return tiedCount === 1;
}

async function searchEntities(query, limit = 6) {
    const qNorm = normalize(query);
    if (!qNorm) return { query: "", cities: [], universities: [], properties: [], countries: [], best: null, bestConfident: false };

    // Everything that needs Mongo/the shared store runs concurrently — the
    // extracted-universities aggregation now gates `universities` itself
    // (it needs comprehensive, not just curated, coverage — see the product
    // requirement this satisfies), so university-implied property lookups
    // are sequenced after it resolves rather than joining this same Promise.all.
    const [crawlEntities, extractedUniversities, nameMatchedProperties] = await Promise.all([
        withTimeout(loadCrawlEntities(), CRAWL_ENTITIES_TIMEOUT_MS, { countries: [], cities: [] }),
        withTimeout(loadExtractedUniversities(), EXTRACTED_UNIVERSITIES_TIMEOUT_MS, []),
        withTimeout(searchProperties(query, limit), PROPERTY_SEARCH_TIMEOUT_MS, []),
    ]);

    const universities = searchUniversities(qNorm, limit, extractedUniversities);
    const universityCityProperties = universities.some((u) => u.rank <= 1 && u.value?.universityId)
        ? await withTimeout(propertiesForUniversities(universities, limit), PROPERTY_SEARCH_TIMEOUT_MS, [])
        : [];

    const seenPropertyIds = new Set(nameMatchedProperties.map((p) => p.id));
    const extraProperties = universityCityProperties
        .filter((p) => !seenPropertyIds.has(p.id))
        .slice(0, Math.max(0, limit - nameMatchedProperties.length));
    const properties = [...nameMatchedProperties, ...extraProperties];

    const cities = searchCities(qNorm, limit, crawlEntities.cities);
    const countries = searchCountries(qNorm, limit, crawlEntities.countries);
    const finalCities = countries.some((c) => c.rank <= 1) && cities.length < limit
        ? [...cities, ...citiesForCountries(countries, new Set(cities.map((c) => c.id)), limit - cities.length, crawlEntities.cities)]
        : cities;

    const groups = { cities: finalCities, universities, properties, countries };
    const best = pickBest(groups);
    return { query, ...groups, best, bestConfident: isBestConfident(best, groups) };
}

module.exports = { searchEntities, normalize, matchRank, levenshtein };
