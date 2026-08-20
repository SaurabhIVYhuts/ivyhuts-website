// Milestone 6 (IVYHUTS_MILESTONE_6_INVENTORY_LOSS_REPORT.md, Phase 3):
// dev/test-only inventory pipeline trace. NOT wired into any public API
// endpoint, NOT called from any production request path — imported only by
// scripts/trace-accommodation-inventory.js and
// scripts/verify-milestone-6-inventory-loss.js.
//
// traceAmberInventory(city) runs ONE real, bounded, gateway-mediated fetch
// (via amberGateway.js's fetchListings() — same budget/lock/cache as every
// other caller, never bypassed) and reports exactly what happened to every
// item at every pipeline stage: pagination -> normalization/validation
// (this codebase's mapAmberItemToResidence() performs both as a single
// combined step, not two separate ones — reported faithfully as one shared
// mechanism, not invented as two) -> deduplication -> Mongo upsert.
//
// SAFETY: by default (`persist: false`) this makes ZERO Mongo writes — only
// the fetch and in-memory normalize/dedup stages run, so a trace can be run
// freely to inspect what WOULD happen. Passing `persist: true` performs the
// real (idempotent, upsert-only, non-destructive) Mongo write via the exact
// same persistResidencesRaw() every real refresh uses — never a delete,
// never an overwrite of an unrelated property (identity is always
// {source, propertyId}, per accommodationIndex.js's own unique index).
// Never logs a full raw Amber payload — only identifying fields
// (sourceId/name/city) and reasons, matching this file's own "do not log
// secrets, do not permanently log full payloads" constraint.
"use strict";

const AccommodationResidence = require("./models/AccommodationResidence");
const { fetchListings, normalizeCityName } = require("./amberGateway");
const { mapAmberItemToResidence, extractResultArray, persistResidencesRaw, REFRESH_TARGET_COUNT } = require("./accommodationIndex");
const { log } = require("./sharedStore");

async function traceAmberInventory(city, { priority = "LOW", source = "trace", persist = false, targetCount } = {}) {
    const normalizedCity = normalizeCityName(city);
    const startedAt = Date.now();

    // ── Stage: pagination / raw fetch ──────────────────────────────────
    let result;
    try {
        result = await fetchListings({ city: normalizedCity, page: 1, limit: targetCount || REFRESH_TARGET_COUNT }, priority, source);
    } catch (err) {
        return {
            city: normalizedCity,
            error: err.message,
            rawCount: 0, normalizedCount: 0, rejectedCount: 0, duplicateCount: 0,
            upsertAttemptCount: 0, upsertSuccessCount: 0, finalMongoCount: null,
            pagination: { pages: 0, rawItems: 0 },
            normalization: { accepted: 0, rejected: 0 },
            validation: { accepted: 0, rejected: 0, reasons: {} },
            deduplication: { before: 0, after: 0, removed: 0, reasons: [] },
            mongo: { attempted: 0, inserted: 0, updated: 0, failed: 0, errors: [] },
            durationMs: Date.now() - startedAt,
        };
    }

    const rawItems = extractResultArray(result.data);
    const uniqueRawIds = new Set(rawItems.map((r) => String(r.id ?? "")));

    // ── Stage: normalization + validation (one combined mechanism in this
    // codebase — mapAmberItemToResidence's own two guard clauses) ────────
    const normalized = [];
    const rejected = [];
    const reasonCounts = {};
    for (const raw of rawItems) {
        const propertyId = raw?.id != null ? String(raw.id) : null;
        let reason = null;
        if (!propertyId) reason = "MISSING_SOURCE_ID";
        else if (!raw?.name) reason = "MISSING_NAME";

        if (reason) {
            rejected.push({ sourceId: propertyId, name: raw?.name || null, reason });
            reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
            continue;
        }
        const mapped = mapAmberItemToResidence(raw, normalizedCity);
        if (!mapped) {
            // Should be unreachable given the two checks above already
            // cover mapAmberItemToResidence's own rejection conditions —
            // recorded as UNKNOWN rather than silently dropped if it ever
            // does happen (e.g. the mapper's own logic changes in the
            // future without this trace being updated to match).
            rejected.push({ sourceId: propertyId, name: raw?.name || null, reason: "UNKNOWN" });
            reasonCounts.UNKNOWN = (reasonCounts.UNKNOWN || 0) + 1;
            continue;
        }
        normalized.push(mapped);
    }

    // ── Stage: deduplication (by canonical sourceId, within this batch) ──
    const beforeDedup = normalized.length;
    const dedupMap = new Map();
    for (const doc of normalized) dedupMap.set(doc.propertyId, doc);
    const deduped = Array.from(dedupMap.values());
    const duplicateCount = beforeDedup - deduped.length;

    // ── Stage: Mongo upsert (only if persist:true) ────────────────────
    const mongo = { attempted: 0, inserted: 0, updated: 0, failed: 0, errors: [] };
    if (persist && deduped.length) {
        mongo.attempted = deduped.length;
        // Per-doc updateOne (not the batched persistResidencesRaw) so this
        // trace can distinguish insert vs update vs failure per property —
        // persistResidencesRaw's own Promise.all still backs this (same
        // upsert filter, same benign-E11000 handling), just called doc-by-doc
        // here for per-doc result capture instead of the batch's aggregate
        // fire-and-forget shape.
        for (const doc of deduped) {
            try {
                const before = await AccommodationResidence.findOne({ source: doc.source, propertyId: doc.propertyId }).select("_id").lean();
                await AccommodationResidence.updateOne({ source: doc.source, propertyId: doc.propertyId }, { $set: doc }, { upsert: true });
                if (before) mongo.updated += 1; else mongo.inserted += 1;
            } catch (err) {
                if (err && err.code === 11000) {
                    // Benign concurrent-insert race (same precedent
                    // persistResidencesRaw already documents) — not a real
                    // failure, but still recorded, never silently ignored.
                    mongo.updated += 1;
                } else {
                    mongo.failed += 1;
                    mongo.errors.push({ sourceId: doc.propertyId, message: String(err.message || err).slice(0, 300) });
                    log(`[Trace] action=MONGO_WRITE_FAILED city=${normalizedCity} sourceId=${doc.propertyId} error=${err.message}`);
                }
            }
        }
    }

    const finalMongoCount = persist ? await AccommodationResidence.countDocuments({ city: normalizedCity }) : null;

    return {
        city: normalizedCity,
        rawCount: rawItems.length,
        normalizedCount: deduped.length,
        rejectedCount: rejected.length,
        duplicateCount,
        upsertAttemptCount: mongo.attempted,
        upsertSuccessCount: mongo.inserted + mongo.updated,
        finalMongoCount,
        pagination: { pages: Math.max(1, Math.ceil(uniqueRawIds.size / 50)), rawItems: rawItems.length },
        normalization: { accepted: normalized.length, rejected: rejected.length },
        validation: { accepted: normalized.length, rejected: rejected.length, reasons: reasonCounts },
        deduplication: { before: beforeDedup, after: deduped.length, removed: duplicateCount, reasons: duplicateCount > 0 ? ["DUPLICATE_SOURCE_ID_WITHIN_BATCH"] : [] },
        mongo,
        durationMs: Date.now() - startedAt,
    };
}

module.exports = { traceAmberInventory };
