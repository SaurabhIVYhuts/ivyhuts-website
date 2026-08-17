// Orchestrator for /api/universities/resolve — the single entry point that
// escalates a free-text university/school search through every tier:
//
//   Tier 1  curated campusUniversities.json (exact/alias match, zero I/O)
//   Tier 2  MongoDB UniversityIndex (previously-discovered institutions)
//   local   fuzzy match against Tier 1 + Tier 2 names (misspelling recovery)
//   Tier 3  AI-assisted candidate-name interpretation (escalation only,
//           NEVER authoritative for coordinates) -> Nominatim geocoding
//           (the only source of truth for coordinates) -> validate ->
//           persist into Tier 2 for every future identical search
//
// ── The one constraint this whole file exists to protect ──
// Nothing here ever calls Amber, imports amberGateway.js/accommodationIndex.js,
// or knows Amber's credentials/URLs. The output of every tier is exactly the
// same shape as a campusUniversities.json record ({id, name, type, city,
// country, address, latitude, longitude}) — the caller (api/universities/resolve.js)
// hands that straight to the EXISTING, unmodified accommodation pipeline
// (getProperties(university.city) client-side, mirroring the pattern
// UniversityHousingPage.js already uses for Tier 1 universities). Discovery
// never fetches, caches, or returns accommodation/price/availability data
// itself.
"use strict";

const { resolveCampusUniversity, CAMPUS_UNIVERSITIES, normalize } = require("./campusUniversityResolver");
const { fuzzyMatchCampusUniversity } = require("./universityFuzzyMatch");
const { interpretUniversityQuery } = require("./universityAI");
const { searchNominatim, generateSimplifiedQueries, hasValidCoords } = require("./universityDiscovery");
const { sharedGet, sharedSet, acquireLock, releaseLock, log } = require("./sharedStore");
const { connectToDatabase, MongoNotConfiguredError } = require("./mongodb");
const UniversityIndex = require("./models/UniversityIndex");

const MAX_QUERY_LENGTH = 120; // cap for a plain-text institution name/query. The <input>'s own maxLength is now
// MAX_URL_LENGTH (see api/_lib/googleMapsParser.js) instead, since it must also fit a full pasted Google Maps
// URL — resolve.js applies THIS shorter limit only on the non-URL (plain-text search) branch.
const NEGATIVE_CACHE_TTL_SECONDS = 24 * 60 * 60; // 24h — long enough to spare repeat Nominatim calls for a genuinely bogus query, short enough that a real (but rare/obscure) institution isn't locked out for good on a transient miss
const LOCK_TTL_MS = 15_000;
const LOCK_WAIT_RETRIES = 10;
const LOCK_WAIT_STEP_MS = 500;

function toPublicUniversityShape(record) {
    return {
        id: record.canonicalId || record.id,
        name: record.name,
        type: record.type === "SCHOOL" ? "SCHOOL" : "UNIVERSITY",
        city: record.city || null,
        country: record.country || null,
        address: record.address || null,
        latitude: record.latitude,
        longitude: record.longitude,
        // Surfaced so the UI can (optionally) show a light "discovered via
        // AI-assisted search, not yet manually curated" indicator — never
        // used to gate whether the record is usable.
        verified: Boolean(record.verified),
        discovered: record.source === "nominatim" || Boolean(record.canonicalId && record.source),
    };
}

// ── Tier 2 ──
async function resolveTier2(normalizedKey) {
    try {
        await connectToDatabase();
    } catch (err) {
        if (!(err instanceof MongoNotConfiguredError)) log("university-resolve Tier 2 unavailable:", err.message);
        return null; // Mongo not configured/unreachable — degrade gracefully, Tier 3 still runs
    }
    try {
        const doc = await UniversityIndex.findOne({
            searchable: true,
            $or: [{ normalizedName: normalizedKey }, { normalizedAliases: normalizedKey }],
        }).lean();
        return doc || null;
    } catch (err) {
        log("university-resolve Tier 2 query failed:", err.message);
        return null;
    }
}

// ── local fuzzy match (Tier 1 + a bounded slice of Tier 2) ──
async function resolveTierFuzzy(query) {
    const candidates = CAMPUS_UNIVERSITIES.map((u) => ({
        record: toPublicUniversityShape(u),
        names: [u.name, ...(u.aliases || [])].map(normalize),
    }));
    try {
        await connectToDatabase();
        const docs = await UniversityIndex.find({ searchable: true }).limit(500).lean();
        for (const d of docs) {
            candidates.push({ record: toPublicUniversityShape(d), names: [d.name, ...(d.aliases || [])].map(normalize) });
        }
    } catch {
        // Mongo unavailable — fuzzy match still runs against Tier 1 alone.
    }
    return fuzzyMatchCampusUniversity(query, candidates);
}

// Used whenever a validated record must be returned to the CURRENT request
// even though persistence (Mongo) failed/was unavailable — the request still
// needs a usable, non-empty id (e.g. so the frontend's setSearchParams({
// university: uni.id }) doesn't set the literal string "undefined"). This id
// won't be findable again via resolveUniversityById once this request ends
// (nothing was actually persisted), which is the correct, honest behavior
// for a degraded-Mongo request — not a defect to work around further.
function ensureCanonicalId(record) {
    return record.canonicalId || record.id || `${slugify(record.name)}-${Math.random().toString(36).slice(2, 8)}`;
}

function slugify(name) {
    return (
        String(name)
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/(^-+|-+$)/g, "")
            .slice(0, 80) || "university"
    );
}

// Persists a Nominatim-validated (or, for a user-confirmed disambiguation
// pick, previously Nominatim-validated) record into Tier 2 so every future
// identical search resolves from Mongo instead of re-discovering. Never
// marks a discovered record verified=true — see UniversityIndex.js's schema
// comment for why. Returns the stored plain object, or null if Mongo isn't
// available (the CALLER's current request still succeeds either way — only
// caching for next time is skipped).
async function persistUniversityRecord(record, originalQuery) {
    try {
        await connectToDatabase();
    } catch {
        return null;
    }

    const normalizedName = normalize(record.name);
    const normalizedAliases = Array.from(new Set([normalize(originalQuery)].filter(Boolean)));

    try {
        let doc = await UniversityIndex.findOne({ normalizedName }).exec();
        if (doc) {
            let changed = false;
            for (const alias of normalizedAliases) {
                if (!doc.normalizedAliases.includes(alias)) {
                    doc.normalizedAliases.push(alias);
                    changed = true;
                }
            }
            if (changed) await doc.save();
            return doc.toObject();
        }

        doc = await UniversityIndex.create({
            canonicalId: `${slugify(record.name)}-${Math.random().toString(36).slice(2, 8)}`,
            name: record.name,
            normalizedName,
            aliases: [],
            normalizedAliases,
            type: record.type === "SCHOOL" ? "SCHOOL" : "UNIVERSITY",
            city: record.city || null,
            country: record.country || null,
            address: record.address || null,
            latitude: record.latitude,
            longitude: record.longitude,
            source: "nominatim",
            sourceId: record.sourceId || null,
            verified: false,
            searchable: true,
            lastVerifiedAt: new Date(),
        });
        return doc.toObject();
    } catch (err) {
        // A duplicate-key race (two concurrent discoveries for the same
        // normalizedName slipping past the lock) or any other write failure
        // must not fail the request — the record was already validated and
        // is returned to the caller regardless of whether it got cached.
        log("university-resolve persist failed (request still succeeds):", err.message);
        return null;
    }
}

// Strict re-validation of a client-supplied "confirmed candidate" (the exact
// object the user picked from an earlier ambiguous-result response) before
// ever persisting or trusting it. This is the one place client input
// influences a coordinate value, so every field is bounds/shape-checked —
// no re-trusting Nominatim's own validation from the earlier response,
// since that response round-tripped through the browser.
function validateConfirmedCandidate(candidate) {
    if (!candidate || typeof candidate !== "object") return null;
    const name = typeof candidate.name === "string" ? candidate.name.trim().slice(0, 200) : "";
    const lat = Number(candidate.latitude);
    const lng = Number(candidate.longitude);
    if (!name || !hasValidCoords(lat, lng)) return null;
    return {
        name,
        type: candidate.type === "SCHOOL" ? "SCHOOL" : "UNIVERSITY",
        city: typeof candidate.city === "string" ? candidate.city.trim().slice(0, 120) || null : null,
        country: typeof candidate.country === "string" ? candidate.country.trim().slice(0, 120) || null : null,
        address: typeof candidate.address === "string" ? candidate.address.trim().slice(0, 400) || null : null,
        latitude: lat,
        longitude: lng,
        source: "nominatim",
        sourceId: typeof candidate.sourceId === "string" ? candidate.sourceId.slice(0, 100) : null,
    };
}

// ── Tier 3: AI-assisted interpretation (escalation only) -> Nominatim (source of truth) ──
async function resolveTier3(query, normalizedKey) {
    const negativeKey = `university:discovery:negative:${normalizedKey}`;
    const cachedNegative = await sharedGet(negativeKey).catch(() => undefined);
    if (cachedNegative) return { status: "not_found" };

    const lockKey = `university:discovery:lock:${normalizedKey}`;
    let token = await acquireLock(lockKey, LOCK_TTL_MS).catch(() => null);

    if (!token) {
        // Another concurrent request is already discovering this exact
        // query (this is the "100 users search the same university at once"
        // case, item 12) — wait for it to finish and read its result from
        // Tier 2 / the negative cache instead of duplicating the Nominatim
        // call. Bounded wait: if the winner never finishes in time, fall
        // through and attempt discovery ourselves rather than hanging.
        for (let i = 0; i < LOCK_WAIT_RETRIES; i++) {
            // eslint-disable-next-line no-await-in-loop
            await new Promise((r) => setTimeout(r, LOCK_WAIT_STEP_MS));
            // eslint-disable-next-line no-await-in-loop
            const doc = await resolveTier2(normalizedKey);
            if (doc) return { status: "resolved", record: toPublicUniversityShape(doc) };
            // eslint-disable-next-line no-await-in-loop
            const neg = await sharedGet(negativeKey).catch(() => undefined);
            if (neg) return { status: "not_found" };
            // eslint-disable-next-line no-await-in-loop
            token = await acquireLock(lockKey, LOCK_TTL_MS).catch(() => null);
            if (token) break;
        }
    }

    try {
        let nomResult = await searchNominatim(query);

        // Deterministic query simplification — still "external discovery",
        // never AI — tried BEFORE any AI escalation. See
        // generateSimplifiedQueries()'s own header in universityDiscovery.js
        // for why this exists and why it's generic (institution-agnostic),
        // not a per-university special case. Every variant is still
        // validated by nameLooksRelated() against the ORIGINAL, untouched
        // `query` (via searchNominatim's relatednessQuery param) — a
        // simplified search string only ever WIDENS what Nominatim is asked,
        // never loosens what counts as a genuine match.
        if (nomResult.status === "not_found") {
            for (const simplified of generateSimplifiedQueries(query)) {
                // eslint-disable-next-line no-await-in-loop
                const simplifiedResult = await searchNominatim(simplified, query);
                if (simplifiedResult.status === "resolved" || simplifiedResult.status === "ambiguous") {
                    nomResult = simplifiedResult;
                    break;
                }
                // not_found/unavailable for this variant — keep trying the
                // rest; an unavailable simplified attempt doesn't override
                // the original not_found (a later variant may still resolve).
            }
        }

        // AI is called ONLY as an escalation — the direct query (and any
        // deterministic simplification above) already reached Nominatim; AI
        // only gets involved if none of that produced a usable result
        // (not_found/unavailable). It is never called for a query that
        // already resolved or was already ambiguous directly.
        if (nomResult.status === "not_found" || nomResult.status === "unavailable") {
            const aiCandidate = await interpretUniversityQuery(query);
            if (aiCandidate && aiCandidate.isLikelyRealInstitution && aiCandidate.candidateName) {
                const aiQuery = [aiCandidate.candidateName, aiCandidate.cityHint, aiCandidate.countryHint].filter(Boolean).join(", ");
                const aiResult = await searchNominatim(aiQuery);
                if (aiResult.status === "resolved" || aiResult.status === "ambiguous") {
                    nomResult = aiResult;
                } else if (nomResult.status === "unavailable" && aiResult.status === "not_found") {
                    nomResult = aiResult; // AI-refined query at least reached Nominatim even though it found nothing — prefer the more informative outcome
                }
            }
        }

        if (nomResult.status === "resolved") {
            const stored = await persistUniversityRecord(nomResult.record, query);
            const withId = stored || { ...nomResult.record, canonicalId: ensureCanonicalId(nomResult.record) };
            return { status: "resolved", record: toPublicUniversityShape(withId) };
        }
        if (nomResult.status === "ambiguous") {
            return {
                status: "ambiguous",
                // Ambiguous candidates are intentionally NOT persisted (see
                // header comment) — each gets a request-scoped id so the
                // frontend can render/key the list; confirming one re-sends
                // the full candidate object (not just this id) to
                // resolveUniversity({confirmedCandidate}), which is what
                // actually persists it with its own freshly-minted id.
                candidates: nomResult.candidates.map((c) => toPublicUniversityShape({ ...c, canonicalId: ensureCanonicalId(c) })),
            };
        }
        if (nomResult.status === "unavailable") {
            return { status: "unavailable", reason: nomResult.reason };
        }

        await sharedSet(negativeKey, { queriedAt: Date.now() }, NEGATIVE_CACHE_TTL_SECONDS).catch(() => {});
        return { status: "not_found" };
    } finally {
        if (token) await releaseLock(lockKey, token).catch(() => {});
    }
}

// Main entry point. `opts.confirmedCandidate`: when the user picked one
// option from an earlier "ambiguous" response, the frontend resends that
// exact candidate object here instead of the free-text query — this
// resolves and persists it directly without spending a second discovery
// round (Nominatim was already called once to produce the candidate list).
async function resolveUniversity(rawQuery, opts = {}) {
    if (opts.confirmedCandidate) {
        const validated = validateConfirmedCandidate(opts.confirmedCandidate);
        if (!validated) return { status: "not_found" };
        const stored = await persistUniversityRecord(validated, rawQuery || validated.name);
        const withId = stored || { ...validated, canonicalId: ensureCanonicalId(validated) };
        return { status: "resolved", record: toPublicUniversityShape(withId) };
    }

    const query = String(rawQuery || "").trim().slice(0, MAX_QUERY_LENGTH);
    if (!query) return { status: "not_found" };

    // Tier 1 — zero I/O, always tried first.
    const tier1 = resolveCampusUniversity(query);
    if (tier1) return { status: "resolved", record: toPublicUniversityShape(tier1) };

    const normalizedKey = normalize(query);

    // Tier 2 — previously-discovered, Mongo-cached.
    const tier2 = await resolveTier2(normalizedKey);
    if (tier2) return { status: "resolved", record: toPublicUniversityShape(tier2) };

    // Local fuzzy match — catches misspellings against Tier 1 + Tier 2
    // WITHOUT spending an AI call or an external geocoding request.
    const fuzzy = await resolveTierFuzzy(query).catch(() => null);
    if (fuzzy) return { status: "resolved", record: fuzzy };

    // Tier 3 — AI-assisted interpretation (escalation only) -> Nominatim
    // (source of truth) -> validate -> persist.
    return resolveTier3(query, normalizedKey);
}

// ── Google Maps candidate resolution ──
// Entry point for a parsed Google Maps URL (see api/universities/resolve.js's
// GET handler and src/lib/googleMapsParser.js / api/_lib/googleMapsParser.js
// for how a pasted URL becomes {name, latitude, longitude} in the first
// place). This is deliberately NOT a second resolver — every candidate here
// is resolved through the EXACT SAME resolveUniversity(name) call as a
// normal text search (Tier 1 -> Tier 2 -> local fuzzy -> Tier 3
// AI-escalated Nominatim), with one added layer: the Google Maps candidate's
// own coordinates (real, but user-supplied and therefore untrusted on their
// own) are cross-checked against the resolver's already independently
// verified coordinates via plain Haversine distance — never via AI, never
// via a second geocoding call.
//
// "close enough to trust the resolved record as-is" radius — generous
// enough that a legitimate satellite campus/building a few km from an
// institution's primary Tier 1/Nominatim point still passes (a campus may
// differ from the institution's primary coordinate by several kilometers),
// tight enough that two genuinely different institutions (e.g. two
// same-named universities on different continents) are never merged.
const GOOGLE_MAPS_PROXIMITY_KM = 50;

function haversineKmLocal(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const toRad = (deg) => (deg * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// candidate: { name: string|null, latitude: number|null, longitude: number|null }
// — already parsed by googleMapsParser.js, but re-validated here defensively
// (never trust a client-computed shape, same discipline as
// validateConfirmedCandidate above). Returns the same status shapes as
// resolveUniversity(): resolved / ambiguous / not_found / unavailable — a
// not_found here carries reason "no_institution_name" when there was no
// name to resolve by at all, letting the caller show a distinct message.
async function resolveGoogleMapsCandidate(candidate) {
    const latitude = Number(candidate && candidate.latitude);
    const longitude = Number(candidate && candidate.longitude);
    const hasCoords = hasValidCoords(latitude, longitude) && !(latitude === 0 && longitude === 0);
    const name = typeof (candidate && candidate.name) === "string" ? candidate.name.trim().slice(0, MAX_QUERY_LENGTH) : "";

    if (!name) {
        // No institution name to resolve by — this module never
        // reverse-geocodes a bare coordinate, so coordinates alone can never
        // produce a university on their own (the pasted URL's coordinates
        // are a candidate signal, never authoritative by themselves).
        return { status: "not_found", reason: "no_institution_name" };
    }

    const nameResult = await resolveUniversity(name);

    if (nameResult.status === "resolved") {
        if (!hasCoords) return nameResult; // no coordinate cross-check possible — trust the name resolution alone, same as an ordinary text search
        const distanceKm = haversineKmLocal(nameResult.record.latitude, nameResult.record.longitude, latitude, longitude);
        if (distanceKm <= GOOGLE_MAPS_PROXIMITY_KM) return nameResult; // Google Maps candidate corroborates the trusted record

        // The name resolved confidently, but the pasted location disagrees
        // materially with the trusted record — could be a legitimate
        // satellite campus (preserve it, don't force the generic
        // headquarters point) or a genuine mismatch. Never silently pick
        // one: surface both through the SAME "ambiguous" shape/UI the
        // ordinary Nominatim-ambiguous path already uses, so the user's
        // explicit pick is what actually gets trusted/persisted (via the
        // existing, unmodified validateConfirmedCandidate()).
        const mapsCandidateRecord = {
            canonicalId: ensureCanonicalId({ name }),
            name,
            type: nameResult.record.type,
            city: nameResult.record.city,
            country: nameResult.record.country,
            address: null,
            latitude,
            longitude,
        };
        return { status: "ambiguous", candidates: [nameResult.record, toPublicUniversityShape(mapsCandidateRecord)] };
    }

    if (nameResult.status === "ambiguous" && hasCoords) {
        // Deterministic disambiguation signal — Haversine distance, never
        // AI — picks the candidate whose already-Nominatim-validated
        // coordinates are closest to the pasted Google Maps location.
        let closest = null;
        let closestKm = Infinity;
        for (const c of nameResult.candidates) {
            if (!hasValidCoords(c.latitude, c.longitude)) continue;
            const d = haversineKmLocal(c.latitude, c.longitude, latitude, longitude);
            if (d < closestKm) {
                closestKm = d;
                closest = c;
            }
        }
        if (closest && closestKm <= GOOGLE_MAPS_PROXIMITY_KM) return { status: "resolved", record: closest };
        return nameResult; // still genuinely ambiguous — let the user pick
    }

    return nameResult; // not_found / unavailable / ambiguous-without-coords passes through unchanged
}

// Resolves a previously-known canonical id back to its full record — used
// when the housing page loads a shareable ?university=<id> URL. Checks
// Tier 1 (static, zero I/O) first, then Tier 2 (Mongo) for a
// previously-discovered id. Never touches Tier 3 — an id is only ever
// something this system itself produced (Tier 1's static ids or a Tier 2
// canonicalId minted by persistUniversityRecord), so there is nothing to
// "discover" here, only to look up.
async function resolveUniversityById(id) {
    if (!id || typeof id !== "string") return null;
    const trimmed = id.trim().slice(0, 120);
    if (!trimmed) return null;

    const tier1 = CAMPUS_UNIVERSITIES.find((u) => u.id === trimmed);
    if (tier1) return toPublicUniversityShape(tier1);

    try {
        await connectToDatabase();
    } catch {
        return null;
    }
    try {
        const doc = await UniversityIndex.findOne({ canonicalId: trimmed, searchable: true }).lean();
        return doc ? toPublicUniversityShape(doc) : null;
    } catch (err) {
        log("university-resolve id lookup failed:", err.message);
        return null;
    }
}

module.exports = {
    resolveUniversity,
    resolveUniversityById,
    resolveGoogleMapsCandidate,
    toPublicUniversityShape,
    MAX_QUERY_LENGTH,
    GOOGLE_MAPS_PROXIMITY_KM,
};
