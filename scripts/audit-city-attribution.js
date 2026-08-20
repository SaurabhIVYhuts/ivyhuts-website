#!/usr/bin/env node
// Milestone 15 (IVYHUTS_MILESTONE_15_CITY_ATTRIBUTION_AUDIT_REPORT.md):
// read-only audit of whether AccommodationResidence.city correctly reflects
// each property's real location, using ONLY data already stored in Mongo —
// no new Amber calls (Part 19: this must never become "for each property,
// fetch Amber"), no external geocoding dependency (Part 6).
//
// INFERENCE METHOD: Amber property names in this catalog are consistently
// formatted "<Property Name>, <Locality>" (confirmed: 47/47 Manchester docs
// have a comma; the trailing segment matched the stored city for 44/47 —
// see the report for the 3 real mismatches this found). This script treats
// that trailing segment, run through the SAME normalizeCityName() every
// other read/write path in this codebase already uses (not a second
// normalizer — Part 25), as the property's self-reported locality, and
// compares it against the stored `city` field. This is real evidence
// (Amber's own data, already in Mongo) — not a guess, not reverse geocoding,
// not a new dependency. Where a property's name has no comma, this script
// reports UNKNOWN rather than fabricating an answer (Part 6).
//
// SAFETY: zero Amber calls, zero writes, zero deletes.
//
// Usage:
//   node scripts/audit-city-attribution.js --city=manchester
//   node scripts/audit-city-attribution.js --source-id=137834
"use strict";

const path = require("path");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
require("dotenv").config({ path: path.join(ROOT, ".env.local") });
require("dotenv").config({ path: path.join(ROOT, ".env") });

const { connectToDatabase, disconnectFromDatabase } = require(path.join(ROOT, "api", "_lib", "mongodb"));
const AccommodationResidence = require(path.join(ROOT, "api", "_lib", "models", "AccommodationResidence"));
const { normalizeCityName } = require(path.join(ROOT, "api", "_lib", "amberGateway"));

function parseArgs(argv) {
    const cityArg = argv.find((a) => a.startsWith("--city="));
    const sourceIdArg = argv.find((a) => a.startsWith("--source-id="));
    return {
        city: cityArg ? cityArg.split("=")[1] : null,
        sourceId: sourceIdArg ? sourceIdArg.split("=")[1] : null,
    };
}

// Trailing ", <locality>" segment of an Amber propertyName, normalized the
// same way every canonical city field in this codebase is. Returns null
// (never a guess) when the name has no comma to extract a locality from.
function inferCityFromName(propertyName) {
    if (typeof propertyName !== "string") return null;
    const parts = propertyName.split(",");
    if (parts.length < 2) return null;
    const trailing = parts[parts.length - 1].trim();
    if (!trailing) return null;
    return normalizeCityName(trailing);
}

function auditDoc(doc) {
    const inferredCity = inferCityFromName(doc.propertyName);
    // Real, evidence-backed corroboration for the specific bug mechanism
    // documented for this milestone (matchesCity() in amberGateway.js also
    // checks item.name via substring .includes(cityLower) — a property whose
    // own NAME happens to contain the requested city string, e.g. a brand
    // name like "True Manchester Salford," can satisfy a Manchester search
    // even when its real locality is Salford). Detected here by checking
    // whether the stored city appears as a literal substring of the
    // property's own name — real evidence already in Mongo, not inferred.
    const storedCityInName = doc.city && doc.propertyName && doc.propertyName.toLowerCase().includes(doc.city.toLowerCase());

    let mismatch = false;
    let confidence = "UNKNOWN";
    let reason = "propertyName has no ', <locality>' suffix to compare against — no evidence either way.";

    if (inferredCity != null) {
        if (inferredCity === doc.city) {
            mismatch = false;
            confidence = "HIGH";
            reason = "Trailing locality segment of propertyName matches the stored city.";
        } else {
            mismatch = true;
            confidence = "HIGH";
            reason = storedCityInName
                ? `Trailing locality segment ("${inferredCity}") disagrees with stored city ("${doc.city}"), AND the stored city string literally appears inside the property's own name — consistent with amberGateway.js's matchesCity() name-substring fallback (checks are.push(item.name)) matching on the property's brand/display name rather than its real location.`
                : `Trailing locality segment ("${inferredCity}") disagrees with stored city ("${doc.city}"). The exact Amber field (location.locality.long_name / location.city.long_name / location.country.long_name) that satisfied matchesCity() cannot be reconstructed from canonical Mongo alone — AccommodationResidence deliberately does not retain the raw Amber payload (see that model's own header). Would require a fresh, single, targeted Amber lookup to confirm definitively — not performed by this script (Part 19).`;
        }
    }

    return {
        sourceId: doc.propertyId,
        name: doc.propertyName,
        storedCity: doc.city,
        country: doc.country,
        latitude: doc.latitude,
        longitude: doc.longitude,
        inferredCity,
        mismatch,
        confidence,
        reason,
    };
}

async function auditCity(city) {
    const normalizedCity = normalizeCityName(city);
    const docs = await AccommodationResidence.find({ city: normalizedCity }).lean();
    const results = docs.map(auditDoc);
    const mismatched = results.filter((r) => r.mismatch);
    const unknown = results.filter((r) => !r.mismatch && r.confidence === "UNKNOWN");
    const correct = results.filter((r) => !r.mismatch && r.confidence !== "UNKNOWN");
    return {
        city: normalizedCity,
        total: results.length,
        correct: correct.length,
        mismatched: mismatched.length,
        unknown: unknown.length,
        attributionAccuracy: results.length ? Math.round((correct.length / results.length) * 1000) / 10 : null,
        mismatchedRecords: mismatched,
    };
}

async function main() {
    const { city, sourceId } = parseArgs(process.argv.slice(2));
    await connectToDatabase();

    if (sourceId) {
        const doc = await AccommodationResidence.findOne({ propertyId: String(sourceId) }).lean();
        if (!doc) {
            console.log(JSON.stringify({ sourceId, found: false }, null, 2));
        } else {
            console.log(JSON.stringify(auditDoc(doc), null, 2));
        }
        await disconnectFromDatabase();
        process.exit(0);
        return;
    }

    if (!city) {
        console.error("Usage: node scripts/audit-city-attribution.js --city=<city> | --source-id=<id>");
        process.exit(1);
    }

    const result = await auditCity(city);
    console.log(JSON.stringify(result, null, 2));
    await disconnectFromDatabase();
    process.exit(0);
}

if (require.main === module) {
    main().catch((err) => { console.error("Audit script crashed:", err); process.exit(1); });
}

module.exports = { inferCityFromName, auditDoc };
