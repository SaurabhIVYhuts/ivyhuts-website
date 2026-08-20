#!/usr/bin/env node
// Milestone 17 (IVYHUTS_MILESTONE_17_TARGETED_CITY_REMEDIATION_REPORT.md):
// targeted, bounded remediation of the 3 known city-mistagged
// AccommodationResidence records found in Milestone 15 and fixed at the
// ingestion-code level in Milestone 16 (matchesCity() no longer matches on
// item.name).
//
// SAFETY:
//   - Exactly ONE live Amber call per target property, via the SAME
//     existing per-property mechanism api/amber.js's own Mongo-enrich step
//     already uses (fetchAmber type:"detail" by canonical_name/slug, then
//     matchesCity() re-verification) — not a new mechanism, not a city-wide
//     refresh. Hard-capped at 3 calls total (one per target sourceId).
//   - Only the `city` field is ever written. propertyId/slug/name/price/
//     rooms/availability/coordinates are read for verification but never
//     modified.
//   - Uses the existing bulkWrite-free, single-document updateOne path —
//     no persistResidencesRaw(), no refresh, no AccommodationIndexMeta write.
//   - A record is updated ONLY if classified CONFIRMED_WRONG_CITY (live
//     Amber location evidence agrees with the name-derived expected city AND
//     disagrees with the currently-stored city). Otherwise it is left
//     untouched and reported as INSUFFICIENT_EVIDENCE.
"use strict";

const path = require("path");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
require("dotenv").config({ path: path.join(ROOT, ".env.local") });
require("dotenv").config({ path: path.join(ROOT, ".env") });

const { connectToDatabase, disconnectFromDatabase } = require(path.join(ROOT, "api", "_lib", "mongodb"));
const AccommodationResidence = require(path.join(ROOT, "api", "_lib", "models", "AccommodationResidence"));
const { fetchAmber, matchesCity, normalizeCityName } = require(path.join(ROOT, "api", "_lib", "amberGateway"));
const { extractResultArray } = require(path.join(ROOT, "api", "_lib", "accommodationIndex"));

const APPLY = process.argv.includes("--apply"); // dry-run unless explicitly passed

const TARGETS = [
    { sourceId: "137834", expectedCityRaw: "Huddersfield" },
    { sourceId: "1167294", expectedCityRaw: "Salford" },
    { sourceId: "147713", expectedCityRaw: "Salford" },
];

async function main() {
    console.log(`=== Milestone 17 — Targeted City Attribution Remediation (${APPLY ? "APPLY" : "DRY RUN"}) ===\n`);
    await connectToDatabase();

    const report = { generatedAt: new Date().toISOString(), mode: APPLY ? "APPLY" : "DRY_RUN", amberCallsMade: 0, records: [] };

    for (const target of TARGETS) {
        console.log(`--- ${target.sourceId} ---`);
        const before = await AccommodationResidence.findOne({ source: "amber", propertyId: target.sourceId }).lean();
        if (!before) {
            console.log(`  NOT FOUND in Mongo — skipping.`);
            report.records.push({ sourceId: target.sourceId, found: false });
            continue;
        }

        const expectedCity = normalizeCityName(target.expectedCityRaw);

        // ── PART 6: duplicate check BEFORE any write ────────────────────────
        const dupCount = await AccommodationResidence.countDocuments({ source: "amber", propertyId: target.sourceId });
        if (dupCount !== 1) {
            console.log(`  DUPLICATE SAFETY STOP: expected exactly 1 record for this sourceId, found ${dupCount}.`);
            report.records.push({ sourceId: target.sourceId, found: true, before, duplicateCount: dupCount, result: "STOPPED_DUPLICATE_CHECK_FAILED" });
            continue;
        }

        // ── PART 3: single targeted live Amber lookup (bounded, exactly 1) ──
        let liveItem = null;
        let liveError = null;
        try {
            const detail = await fetchAmber({ type: "detail", params: { slug: before.slug }, priority: "LOW", source: "milestone17-remediation" });
            report.amberCallsMade += 1; // the attempt itself counts, success or not — incremented once per property, here only
            liveItem = extractResultArray(detail.data)[0] || null;
        } catch (err) {
            liveError = err.message;
        }

        let liveEvidence = null;
        let classification = "INSUFFICIENT_EVIDENCE";
        let reason;
        if (!liveItem) {
            reason = liveError
                ? `Live Amber detail lookup failed: ${liveError}. No live evidence available — record left unmodified.`
                : `Live Amber detail lookup returned no item for slug "${before.slug}" (property may have been delisted). No live evidence available — record left unmodified.`;
        } else {
            liveEvidence = {
                name: liveItem.name || null,
                locality: liveItem.location?.locality?.long_name || null,
                city: liveItem.location?.city?.long_name || null,
                country: liveItem.location?.country?.long_name || null,
                coordinates: liveItem.location_coordinates || null,
                canonical_name: liveItem.canonical_name || null,
                available: liveItem.available ?? null,
            };
            const matchesExpected = matchesCity(liveItem, expectedCity);
            const matchesCurrentStored = matchesCity(liveItem, before.city);
            if (matchesExpected && !matchesCurrentStored) {
                classification = "CONFIRMED_WRONG_CITY";
                reason = `Live Amber location data (post-Milestone-16 matchesCity(), location fields only) confirms "${expectedCity}" and does NOT confirm "${before.city}".`;
            } else if (matchesExpected && matchesCurrentStored) {
                classification = "INSUFFICIENT_EVIDENCE";
                reason = `Live Amber location data matches BOTH "${expectedCity}" and stored "${before.city}" — ambiguous, not correcting without clearer evidence.`;
            } else if (!matchesExpected) {
                classification = "INSUFFICIENT_EVIDENCE";
                reason = `Live Amber location data does NOT confirm the expected city "${expectedCity}" either — the name-derived hypothesis is not supported by live evidence. Left unmodified.`;
            }
        }

        console.log(`  liveEvidence: ${JSON.stringify(liveEvidence)}`);
        console.log(`  classification: ${classification} — ${reason}`);

        const record = {
            sourceId: target.sourceId,
            propertyId: before.propertyId,
            slug: before.slug,
            name: before.propertyName,
            oldCity: before.city,
            expectedCity,
            liveEvidence,
            liveVerified: Boolean(liveItem),
            duplicateCheck: dupCount,
            classification,
            reason,
        };

        if (classification === "CONFIRMED_WRONG_CITY") {
            if (APPLY) {
                const updateResult = await AccommodationResidence.updateOne(
                    { source: "amber", propertyId: target.sourceId },
                    { $set: { city: expectedCity } }
                );
                const after = await AccommodationResidence.findOne({ source: "amber", propertyId: target.sourceId }).lean();
                const dupAfter = await AccommodationResidence.countDocuments({ source: "amber", propertyId: target.sourceId });
                const identityPreserved = after.propertyId === before.propertyId && after.slug === before.slug && after.propertyName === before.propertyName;
                record.newCity = after.city;
                record.matchedCount = updateResult.matchedCount;
                record.modifiedCount = updateResult.modifiedCount;
                record.identityPreserved = identityPreserved;
                record.duplicateCountAfter = dupAfter;
                record.result = identityPreserved && dupAfter === 1 && after.city === expectedCity ? "CORRECTED" : "CORRECTED_BUT_VERIFY";
                console.log(`  APPLIED: city ${before.city} -> ${after.city} (identityPreserved=${identityPreserved}, duplicateCountAfter=${dupAfter})`);
            } else {
                record.newCity = expectedCity;
                record.result = "WOULD_CORRECT (dry run — pass --apply to write)";
                console.log(`  DRY RUN: would set city ${before.city} -> ${expectedCity}`);
            }
        } else {
            record.result = "NOT_MODIFIED";
        }

        report.records.push(record);
    }

    console.log(`\nTotal live Amber calls made: ${report.amberCallsMade}`);
    const outPath = path.join(ROOT, "IVYHUTS_MILESTONE_17_REMEDIATION_DATA.json");
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.log(`Full data written to ${outPath}`);

    await disconnectFromDatabase();
    process.exit(0);
}

main().catch((err) => { console.error("Remediation script crashed:", err); process.exit(1); });
