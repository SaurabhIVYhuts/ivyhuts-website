#!/usr/bin/env node
// Milestone 13 (IVYHUTS_MILESTONE_13_LISTING_VISIBILITY_AUDIT_REPORT.md):
// read-only diagnostic that traces a REAL canonical-Mongo property all the
// way from AccommodationResidence through the canonical service, the real
// /api/city-listings route handler, the frontend mapper's exact filtering
// rule, and PropertyListingPage.js's own default-filter reducer (ported
// verbatim, not reimplemented from scratch), recording the count at every
// checkpoint so the FIRST stage where a record disappears can be identified
// with real evidence rather than assumption.
//
// SAFETY: zero Amber calls (this milestone is entirely Mongo + serving-layer
// — Milestone 12 already proved Amber<->Mongo coverage for these 7 cities,
// see IVYHUTS_MILESTONE_12_RECONCILIATION_DATA.json). Zero writes. Zero
// deletes. The real production functions are imported and executed directly
// (including api/city-listings.js's own exported handler, invoked with a
// real mock req/res) — nothing here is a mock of the pipeline's own logic.
//
// Usage:
//   node scripts/audit-listing-visibility.js --city manchester
//   node scripts/audit-listing-visibility.js --city manchester --source-id 12345
"use strict";

const path = require("path");
const ROOT = path.join(__dirname, "..");
require("dotenv").config({ path: path.join(ROOT, ".env.local") });
require("dotenv").config({ path: path.join(ROOT, ".env") });

const { connectToDatabase, disconnectFromDatabase } = require(path.join(ROOT, "api", "_lib", "mongodb"));
const AccommodationResidence = require(path.join(ROOT, "api", "_lib", "models", "AccommodationResidence"));
const accommodationIndex = require(path.join(ROOT, "api", "_lib", "accommodationIndex"));
const cityListingsHandler = require(path.join(ROOT, "api", "_lib", "routes", "content", "city-listings.js"));
const { normalizeCityName } = require(path.join(ROOT, "api", "_lib", "amberGateway"));

function parseArgs(argv) {
    const cityArg = argv.find((a) => a.startsWith("--city="));
    const sourceIdArg = argv.find((a) => a.startsWith("--source-id="));
    return {
        city: cityArg ? cityArg.split("=")[1] : null,
        sourceId: sourceIdArg ? sourceIdArg.split("=")[1] : null,
    };
}

// Invokes the REAL exported handler from api/city-listings.js — the actual
// file every production request runs — with a plain mock req/res, so this
// checkpoint reflects the real route (query parsing, status codes, JSON
// serialization) rather than only the service function underneath it.
function invokeApiHandler(handler, query) {
    return new Promise((resolve, reject) => {
        const req = { method: "GET", query };
        let statusCode = 200;
        const res = {
            setHeader() {},
            status(code) { statusCode = code; return this; },
            json(body) { resolve({ statusCode, body, bytes: Buffer.byteLength(JSON.stringify(body)) }); },
        };
        Promise.resolve(handler(req, res)).catch(reject);
    });
}

// Verbatim port of src/services/amberMapper.js's mapResidenceDocToListing()
// null-filter rule (that file is an ES module for CRA's webpack pipeline,
// not require()'able from this plain CommonJS script — same CRA/ESM
// boundary every prior milestone's test scripts have hit). This reproduces
// ONLY the filtering condition (line ~912: `if (!doc || typeof doc !== "object") return null;`),
// not the full field-mapping (irrelevant to whether a record survives).
function frontendMapperSurvives(doc) {
    return Boolean(doc && typeof doc === "object");
}

// Verbatim port of PropertyListingPage.js's `filteredListings` reducer
// (lines ~435-460), with an EMPTY filters object — i.e. exactly what every
// default/unfiltered browse (?city=, ?university=, ?property=) evaluates,
// since every clause there is `!filters.X || ...`. Ported rather than
// imported for the same CRA/ESM reason as above. If this script's output
// ever diverges from the real page's behavior, that itself is a finding —
// it would mean the two have drifted, which is exactly the kind of thing
// this audit exists to catch.
function passesDefaultListingFilter(mapped) {
    const filters = { query: "", minPrice: "", maxPrice: "", roomType: "", billsOnly: false, near: "", amenities: [], moveInMonth: "", stayDuration: "" };
    const q = (filters.query || "").toLowerCase().trim();
    const haystack = [mapped.name, mapped.address?.locality, mapped.address?.country, ...(mapped.distances?.nearby || []).map((d) => d.place)].join(" ").toLowerCase();
    const textMatch = !q || haystack.includes(q);
    const price = mapped.priceWeekly ?? mapped.price?.from ?? 0;
    const minOk = !filters.minPrice || price >= Number(filters.minPrice);
    const maxOk = !filters.maxPrice || price <= Number(filters.maxPrice);
    const roomTypeOk = !filters.roomType || (mapped.rooms?.types || []).includes(filters.roomType);
    const billsOk = !filters.billsOnly || mapped.billsIncluded;
    const nearOk = !filters.near || (mapped.distances?.nearby || []).some((d) => d.place === filters.near);
    const amenitiesOk = filters.amenities.every((a) => (mapped.amenities?.all || []).includes(a));
    const moveInOk = !filters.moveInMonth || (mapped.moveInOptions || []).includes(filters.moveInMonth);
    const stayDurationOk = !filters.stayDuration || (mapped.stayDurationOptions || []).includes(filters.stayDuration);
    return textMatch && minOk && maxOk && roomTypeOk && billsOk && nearOk && amenitiesOk && moveInOk && stayDurationOk;
}

// Same field the frontend reads as `id` (mapResidenceDocToListing: `const id = doc.propertyId ?? null;`)
// — used here to build the React-key-collision check for Part 18.
function listingKey(doc) { return doc.propertyId ?? null; }

async function auditCity(city, sourceId) {
    const normalizedCity = normalizeCityName(city);

    // ── CHECKPOINT 1: Mongo raw ────────────────────────────────────────────
    const t0 = Date.now();
    const mongoDocs = await AccommodationResidence.find({ city: normalizedCity }).lean();
    const mongoRawMs = Date.now() - t0;
    const mongoRawCount = mongoDocs.length;

    // ── CHECKPOINT 2: canonical service (accommodationIndex.getCityListings) ─
    const t1 = Date.now();
    const serviceResult = await accommodationIndex.getCityListings(city, { priority: "LOW", source: "milestone13-audit" });
    const canonicalServiceMs = Date.now() - t1;
    const canonicalServiceCount = serviceResult.residences.length;

    // ── CHECKPOINT 3: the REAL /api/city-listings route handler ────────────
    const t2 = Date.now();
    const apiResult = await invokeApiHandler(cityListingsHandler, { city, priority: "LOW", source: "milestone13-audit" });
    const apiMs = Date.now() - t2;
    const apiResponseCount = Array.isArray(apiResult.body.residences) ? apiResult.body.residences.length : 0;

    // ── CHECKPOINT 4-5: frontend received / frontend normalized (mapped) ───
    // "received" and "normalized" are the same array here because this
    // script calls the API in-process (no network hop to lose bytes over) —
    // documented explicitly, not assumed equal.
    const frontendReceived = apiResult.body.residences || [];
    const frontendMapped = frontendReceived.filter(frontendMapperSurvives);

    // ── CHECKPOINT 6-8: availability / price / search filter (default, empty) ─
    // PropertyListingPage.js's filteredListings applies ALL of these in one
    // combined predicate (not separable stages in the real code) — evaluated
    // together here for the same reason, with each intermediate label
    // representing "if this were the only filter active."
    const finalListing = frontendMapped.filter(passesDefaultListingFilter);

    // ── Part 18: React key collision check (key={listing.id}, id=propertyId) ─
    const keyCounts = new Map();
    for (const d of mongoDocs) {
        const k = listingKey(d);
        keyCounts.set(k, (keyCounts.get(k) || 0) + 1);
    }
    const keyCollisions = [...keyCounts.entries()].filter(([, c]) => c > 1);

    const checkpoints = {
        mongoRawCount,
        canonicalServiceCount,
        apiResponseCount,
        apiResponseBytes: apiResult.bytes,
        frontendReceivedCount: frontendReceived.length,
        frontendNormalizedCount: frontendMapped.length,
        availabilityIncludedCount: finalListing.length, // no availability filter exists in this path — see report
        pricingIncludedCount: finalListing.length, // no price filter active by default
        searchIncludedCount: finalListing.length, // no search query active by default
        finalDisplayedCount: finalListing.length,
        timingsMs: { mongoRaw: mongoRawMs, canonicalService: canonicalServiceMs, apiHandler: apiMs },
        keyCollisions: keyCollisions.map(([id, count]) => ({ id, count })),
    };

    let sourceIdTrace = null;
    if (sourceId) {
        const inMongo = mongoDocs.some((d) => d.propertyId === String(sourceId));
        const inCanonicalService = serviceResult.residences.some((d) => d.propertyId === String(sourceId));
        const inApi = frontendReceived.some((d) => d.propertyId === String(sourceId));
        const survivesMapper = frontendMapped.some((d) => d.propertyId === String(sourceId));
        const survivesFinal = finalListing.some((d) => d.propertyId === String(sourceId));
        const doc = mongoDocs.find((d) => d.propertyId === String(sourceId)) || null;

        let exclusionStage = "NONE";
        let exclusionReason = "Property is present at every traced checkpoint through to final display.";
        if (!inMongo) { exclusionStage = "MONGO"; exclusionReason = `sourceId ${sourceId} does not exist in AccommodationResidence for city=${normalizedCity}.`; }
        else if (!inCanonicalService) { exclusionStage = "CANONICAL_SERVICE"; exclusionReason = "Present in Mongo but absent from accommodationIndex.getCityListings() result — unexpected, since that function performs no filtering (see report)."; }
        else if (!inApi) { exclusionStage = "API"; exclusionReason = "Present in canonical service result but absent from api/city-listings.js's own JSON response — unexpected, since that handler performs no filtering (see report)."; }
        else if (!survivesMapper) { exclusionStage = "FRONTEND_MAPPER"; exclusionReason = "Rejected by mapResidenceDocToListing()'s null-guard — would require the API to have returned a non-object entry, which did not happen here."; }
        else if (!survivesFinal) { exclusionStage = "DEFAULT_FILTER"; exclusionReason = "Excluded by PropertyListingPage.js's filteredListings predicate even with all filters empty — investigate this specific record's fields."; }

        sourceIdTrace = {
            sourceId: String(sourceId),
            name: doc?.propertyName || null,
            mongoExists: inMongo,
            canonicalServiceIncluded: inCanonicalService,
            apiIncluded: inApi,
            frontendReceived: inApi,
            availabilityIncluded: survivesFinal,
            pricingIncluded: survivesFinal,
            searchIncluded: survivesFinal,
            finalIncluded: survivesFinal,
            exclusionStage,
            exclusionReason,
            mongoDoc: doc ? {
                propertyId: doc.propertyId, propertyName: doc.propertyName, slug: doc.slug, city: doc.city, country: doc.country,
                latitude: doc.latitude, longitude: doc.longitude, price: doc.price, priceDuration: doc.priceDuration, priceWeekly: doc.priceWeekly,
                roomsCount: doc.roomsCount, roomTypes: doc.roomTypes, available: doc.available, updatedAt: doc.updatedAt, createdAt: doc.createdAt,
            } : null,
        };
    }

    return { city: normalizedCity, checkpoints, sourceIdTrace };
}

async function main() {
    const { city, sourceId } = parseArgs(process.argv.slice(2));
    if (!city) {
        console.error("Usage: node scripts/audit-listing-visibility.js --city=<city> [--source-id=<id>]");
        process.exit(1);
    }
    console.log(`=== Milestone 13 — Listing Visibility Audit (read-only) ===`);
    console.log(`City: ${city}${sourceId ? `  sourceId: ${sourceId}` : ""}\n`);

    await connectToDatabase();
    const result = await auditCity(city, sourceId);
    await disconnectFromDatabase();

    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
}

main().catch((err) => { console.error("Audit script crashed:", err); process.exit(1); });
