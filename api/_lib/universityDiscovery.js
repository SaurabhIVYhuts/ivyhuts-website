// Tier 3 geographic discovery — OpenStreetMap Nominatim. This is the ONLY
// external geocoding provider in the University Housing discovery pipeline
// (see api/_lib/universityResolveService.js for the full escalation order).
//
// Absolute isolation from Amber: this file has no import of, and makes no
// call to, amberGateway.js / accommodationIndex.js / Amber's own upstream
// hostname. It has its own Redis rate-limit namespace ("university:discovery:nominatim:requests"),
// completely separate from Amber's own request-budget key/namespace.
//
// AI never supplies coordinates. This module is what actually determines
// latitude/longitude, always by calling Nominatim directly and validating
// its response — an AI-proposed candidate NAME (see universityAI.js) only
// ever changes what STRING this module searches Nominatim for, never what
// coordinates get returned.
"use strict";

const { reserveSlot, log } = require("./sharedStore");
const { similarity } = require("./universityFuzzyMatch");

const NOMINATIM_BASE_URL = "https://nominatim.openstreetmap.org/search";
// Nominatim's usage policy requires a descriptive User-Agent identifying the
// application (and ideally a contact) — an unset/generic one risks the
// requesting IP being blocked. Configurable so a real contact can be set in
// production without a code change.
const USER_AGENT = process.env.UNIVERSITY_DISCOVERY_USER_AGENT || "IVYHUTS-UniversityHousing/1.0 (https://ivyhuts.com)";
const NOMINATIM_RATE_KEY = "university:discovery:nominatim:requests"; // own namespace — never amber:*
const NOMINATIM_MIN_INTERVAL_MS = 1100; // Nominatim policy: max ~1 request/second
const NOMINATIM_TIMEOUT_MS = 8000;
const RATE_WAIT_RETRIES = 5;
const RATE_WAIT_STEP_MS = 350;

function hasValidCoords(lat, lng) {
    return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

// Institution allow-list, keyed by Nominatim's own category/type fields.
// Deliberately conservative — a residential address, a street, a shop, or a
// generic "place" match must NEVER be accepted as a university/school, no
// matter how well its name matches the query.
//
// Nominatim's `jsonv2` format names this field `category` (confirmed against
// the live API); some other Nominatim deployments/formats still call it
// `class` — classifyInstitutionType() below accepts either.
const ALLOWED_CLASS_TYPES = new Set([
    "amenity/university",
    "amenity/college",
    "amenity/school",
    "amenity/language_school",
    "building/university",
    "building/college",
    "office/educational_institution",
]);

function classifyInstitutionType(result) {
    const category = result.category || result.class;
    const key = `${category}/${result.type}`;
    if (!ALLOWED_CLASS_TYPES.has(key)) return null;
    if (result.type === "school" || result.type === "language_school") return "SCHOOL";
    return "UNIVERSITY";
}

// Minimum Nominatim `importance` score to trust a match at all — filters out
// low-confidence/obscure matches (Nominatim's importance is roughly a
// 0..1 scale derived from Wikipedia/OSM prominence signals). Chosen
// conservatively: real universities/colleges reliably score well above this.
const MIN_IMPORTANCE = 0.15;

// Diacritic-folds (café -> cafe, München's ü -> u) via Unicode NFD
// decomposition + stripping combining marks, and treats hyphens/underscores/
// slashes as WORD SEPARATORS rather than gluing the surrounding letters
// together — many real institution names are hyphenated compounds in their
// native spelling (e.g. German "Ludwig-Maximilians-Universität", French
// "Aix-Marseille") or hyphenated place names; naively stripping the hyphen
// without inserting a space would otherwise merge "Ludwig-Maximilians-
// Universität" into one unrecognizable glued token instead of three
// comparable words. Institution-agnostic — this is a generic string-
// normalization fix, not a special case for any one name.
function normalizeForCompare(str) {
    return String(str || "")
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "") // strip combining diacritical marks (U+0300-U+036F)
        .toLowerCase()
        .replace(/[-_/]+/g, " ")
        .replace(/[^\w\s]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

// Per-token match: exact, OR close enough by edit-distance similarity (the
// SAME similarity() used for Tier 1/2 fuzzy name matching in
// universityFuzzyMatch.js — reused, not reimplemented) to absorb minor
// spelling/language variants a geocoding provider's own indexed name may
// use that a plain English query wouldn't (e.g. "University" ~
// "Universität", "Maximilian" ~ "Maximilians" — both score comfortably
// above this threshold). Deliberately stricter than the 0.82 full-NAME
// fuzzy-match threshold elsewhere: a single short word has far less context
// to disambiguate, so genuinely different short words (e.g. "east"~"west"
// at 0.50, "leeds"~"leicester" at 0.33) must stay well clear of it.
const TOKEN_FUZZY_THRESHOLD = 0.72;
function tokensLookRelated(a, b) {
    return a === b || similarity(a, b) >= TOKEN_FUZZY_THRESHOLD;
}

// Token-overlap name-match check — not the same fuzzy-match module used for
// Tier 1/2 (that's about matching a QUERY to already-trusted records; this
// is about sanity-checking that Nominatim's result is actually related to
// what was searched, before ever trusting its coordinates). Per-token
// comparison is fuzzy (see tokensLookRelated above), but the REQUIRED
// overlap ratio (40% of the query's own meaningful tokens) is unchanged
// from before — a genuinely unrelated name can't cross that bar just
// because one or two of its words happen to resemble the query's by
// coincidence (see the "unrelated name" rejection regression test).
function nameLooksRelated(query, resultName) {
    const q = normalizeForCompare(query).split(" ").filter((w) => w.length > 2);
    const r = normalizeForCompare(resultName).split(" ").filter((w) => w.length > 2);
    if (q.length === 0 || r.length === 0) return false;
    let overlap = 0;
    for (const qw of q) {
        if (r.some((rw) => tokensLookRelated(qw, rw))) overlap++;
    }
    return overlap / q.length >= 0.4;
}

async function waitForRateSlot() {
    for (let attempt = 0; attempt < RATE_WAIT_RETRIES; attempt++) {
        // eslint-disable-next-line no-await-in-loop
        const allowed = await reserveSlot(NOMINATIM_RATE_KEY, NOMINATIM_MIN_INTERVAL_MS, 1);
        if (allowed) return true;
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, RATE_WAIT_STEP_MS));
    }
    return false;
}

// Raw Nominatim call, rate-limited to Nominatim's own usage policy. Returns
// the parsed JSON array, or throws on network/HTTP failure (caller decides
// what "unavailable" means).
async function fetchNominatim(query) {
    const gotSlot = await waitForRateSlot().catch(() => false);
    if (!gotSlot) {
        const err = new Error("Nominatim rate limit budget exhausted");
        err.code = "RATE_LIMITED";
        throw err;
    }

    const url = `${NOMINATIM_BASE_URL}?${new URLSearchParams({
        q: query,
        format: "jsonv2",
        addressdetails: "1",
        extratags: "1",
        namedetails: "1",
        limit: "5",
        "accept-language": "en",
    }).toString()}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), NOMINATIM_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
            signal: controller.signal,
        });
        if (!res.ok) {
            const err = new Error(`Nominatim returned ${res.status}`);
            err.code = "UPSTREAM_ERROR";
            throw err;
        }
        return await res.json();
    } finally {
        clearTimeout(timeout);
    }
}

function toValidatedRecord(query, result) {
    const type = classifyInstitutionType(result);
    if (!type) return null;
    const lat = Number(result.lat);
    const lon = Number(result.lon);
    if (!hasValidCoords(lat, lon)) return null;
    const importance = Number(result.importance) || 0;
    if (importance < MIN_IMPORTANCE) return null;
    const name = result.namedetails?.name || result.name || result.display_name.split(",")[0];
    // `query` here is deliberately whatever string the CALLER wants
    // relatedness judged against — normally the same string that was
    // actually sent to Nominatim, but searchNominatim() lets a caller pass a
    // separate, wider `relatednessQuery` when the search string itself was a
    // deterministically SIMPLIFIED variant of the user's real input (see
    // generateSimplifiedQueries() below) — this keeps validation exactly as
    // strict as before (always checked against the full original text) even
    // when the search string sent upstream was narrower.
    if (!nameLooksRelated(query, name) && !nameLooksRelated(query, result.display_name)) return null;

    const address = result.address || {};
    const city = address.city || address.town || address.village || address.municipality || address.county || null;
    const country = address.country || null;

    return {
        name: String(name).trim(),
        type,
        city: city ? String(city).trim() : null,
        country: country ? String(country).trim() : null,
        address: result.display_name || null,
        latitude: lat,
        longitude: lon,
        source: "nominatim",
        sourceId: `${result.osm_type || "unknown"}/${result.osm_id || "unknown"}`,
        importance,
    };
}

// query: free-text search string actually sent to Nominatim.
// relatednessQuery: (optional) the string every candidate result's name is
// judged against for relatedness — defaults to `query` itself. Only ever
// differs from `query` when the CALLER is trying a deterministically
// SIMPLIFIED variant of a user's real search text (see
// generateSimplifiedQueries()) — validation then still holds every result to
// the user's original, full text, never to the narrower string that was
// actually searched.
//
// Returns one of:
//   { status: "resolved", record }
//   { status: "ambiguous", candidates: [record, ...] }   (2+ genuinely distinct real places, no clear winner)
//   { status: "not_found" }                               (Nominatim reached, nothing validated)
//   { status: "unavailable", reason }                     (rate-limited / network / upstream failure)
// Never throws — every failure mode is represented in the return shape so
// the orchestrator can show a clear, non-technical state to the user.
async function searchNominatim(query, relatednessQuery) {
    const trimmed = String(query || "").trim();
    if (!trimmed) return { status: "not_found" };
    const relatedTo = String(relatednessQuery || trimmed).trim();

    let results;
    try {
        results = await fetchNominatim(trimmed);
    } catch (err) {
        log("university-discovery Nominatim call failed:", err.code || err.message);
        return { status: "unavailable", reason: err.code === "RATE_LIMITED" ? "rate_limited" : "upstream_error" };
    }

    if (!Array.isArray(results) || results.length === 0) return { status: "not_found" };

    const validated = results
        .map((r) => toValidatedRecord(relatedTo, r))
        .filter(Boolean)
        // Highest importance first — the basis for "clear winner" below.
        .sort((a, b) => b.importance - a.importance);

    if (validated.length === 0) return { status: "not_found" };
    if (validated.length === 1) return { status: "resolved", record: validated[0] };

    // Distinct-place check: if the top result is a genuinely dominant match
    // (materially higher importance than the runner-up, or the runner-up is
    // essentially the same place — same rounded coordinates, e.g. duplicate
    // OSM entries for one campus), treat it as resolved rather than forcing
    // the user through an unnecessary disambiguation step.
    const [top, second] = validated;
    const sameApproxLocation = Math.abs(top.latitude - second.latitude) < 0.002 && Math.abs(top.longitude - second.longitude) < 0.002;
    if (sameApproxLocation) return { status: "resolved", record: top };
    if (top.importance - second.importance >= 0.12) return { status: "resolved", record: top };

    return { status: "ambiguous", candidates: validated.slice(0, 4) };
}

// Generic, institution-agnostic query-widening strategy — NOT a per-
// university special case. Some legitimate institution descriptions include
// a qualifying word (a campus/site/building qualifier not part of the
// place's own indexed name/address in OpenStreetMap) that can make
// Nominatim's literal multi-token matching return nothing even though the
// institution itself is well-known and otherwise easy to find — the exact
// same query minus that single extra word resolves immediately. Rather than
// maintain a hand-picked list of "filler" words (which would itself be a
// kind of special-casing, and would need updating every time a new phrasing
// appears), this generates every single-word-removed variant of the
// ORIGINAL query and lets the caller try each one in turn. This is a pure,
// synchronous, zero-I/O function — it only produces candidate strings;
// searchNominatim() (with relatednessQuery always pinned back to the
// untouched original query, never a simplified one) is what actually
// validates any result that comes back.
//
// Bounded on both axes: skipped entirely for short queries (little to gain,
// real risk of an overly-generic single/two-word search matching the wrong
// place), and capped at MAX_SIMPLIFICATION_ATTEMPTS variants for a long
// query — this only ever runs on the already-slow "direct query found
// nothing" path, so a few extra rate-limited Nominatim calls there is an
// acceptable trade for not silently giving up.
const MIN_WORDS_FOR_SIMPLIFICATION = 3;
const MAX_SIMPLIFICATION_ATTEMPTS = 6;
function generateSimplifiedQueries(query) {
    const words = String(query || "").trim().split(/\s+/).filter(Boolean);
    if (words.length < MIN_WORDS_FOR_SIMPLIFICATION) return [];

    const variants = [];
    const seen = new Set();
    const positions = Math.min(words.length, MAX_SIMPLIFICATION_ATTEMPTS);
    for (let i = 0; i < positions; i++) {
        const variant = words.filter((_, idx) => idx !== i).join(" ");
        if (variant && !seen.has(variant)) {
            seen.add(variant);
            variants.push(variant);
        }
    }
    return variants;
}

module.exports = { searchNominatim, generateSimplifiedQueries, hasValidCoords, NOMINATIM_RATE_KEY };
