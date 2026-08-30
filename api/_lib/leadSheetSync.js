// Shared Google Sheet -> Lead sync core — extracted from
// api/leads/import/google-sheet.js so the SAME idempotent, fill-missing-
// only pipeline runs identically whether triggered manually (that route,
// INTERNAL_ROLES-gated) or on a schedule (api/leads/import/sync-cron.js,
// CRON_SECRET-gated). No behavior change from the original inline version
// — this is a pure extraction, not a rewrite.
//
// Never fabricates rows, never overwrites a field the CRM already has a
// value for (see leadIntake.js's computeFillMissingUpdate), and dedupes on
// externalLeadId — running this repeatedly, from either trigger, converges
// on the same state rather than creating duplicates or drifting.
"use strict";

const { connectToDatabase } = require("./mongodb");
const { isSheetsImportConfigured, fetchLeadSheetRows } = require("./googleSheetsClient");
const { normalizeMetaSheetRow, computeFillMissingUpdate } = require("./leadIntake");
const Lead = require("./models/Lead");
const { recordEvent } = require("./events");

// Defensive cap — this is a batch job (manual or scheduled), not a
// paginated list endpoint; a hard ceiling prevents one run from ever
// attempting an unbounded write burst even if the sheet grows very large.
const MAX_ROWS_PER_RUN = 500;

// Returns { status: "NOT_CONFIGURED" | "UPSTREAM_ERROR" | "OK", reason?, summary?, details? }.
// `actor` identifies who/what triggered this run for the audit trail
// (recordEvent metadata) — a real Mongo user id + role for the manual
// route, or a fixed "cron" marker for the scheduled trigger; never absent,
// so LEAD_IMPORTED_FROM_SHEET/LEAD_MERGED_FROM_SHEET events always show
// their real origin.
async function runLeadSheetSync({ actorUserId = null, actorRole = "cron" } = {}) {
    if (!isSheetsImportConfigured()) {
        return { status: "NOT_CONFIGURED", reason: "Google Sheets import is not configured on this deployment." };
    }

    await connectToDatabase();

    const sheetResult = await fetchLeadSheetRows();
    if (sheetResult.status !== "OK") {
        return { status: "UPSTREAM_ERROR", reason: sheetResult.reason || "Google Sheets is temporarily unavailable." };
    }

    const rows = sheetResult.rows.slice(0, MAX_ROWS_PER_RUN);
    const summary = { totalRows: rows.length, created: 0, merged: 0, unchanged: 0, skipped: 0 };
    const details = [];

    for (const row of rows) {
        const normalized = normalizeMetaSheetRow(row);
        if (!normalized) {
            summary.skipped += 1;
            continue;
        }

        const existing = await Lead.findOne({ externalLeadId: normalized.externalLeadId });
        if (!existing) {
            const lead = await Lead.create({
                externalLeadId: normalized.externalLeadId,
                userId: null,
                contact: normalized.contact,
                status: "new",
                source: normalized.source,
                sourceDetails: normalized.sourceDetails,
                // Partial data is intentional — every accommodation
                // requirement field is simply absent here, never blocked on.
            });
            summary.created += 1;
            details.push({ externalLeadId: normalized.externalLeadId, leadId: String(lead._id), action: "created" });
            await recordEvent({
                userId: null,
                event: "LEAD_IMPORTED_FROM_SHEET",
                properties: { leadId: String(lead._id), externalLeadId: normalized.externalLeadId, source: normalized.source },
                metadata: { importedBy: actorUserId, importedByRole: actorRole },
            });
            continue;
        }

        const update = computeFillMissingUpdate(existing, normalized);
        if (!update) {
            summary.unchanged += 1;
            details.push({ externalLeadId: normalized.externalLeadId, leadId: String(existing._id), action: "unchanged" });
            continue;
        }

        await Lead.updateOne({ _id: existing._id }, { $set: update });
        summary.merged += 1;
        details.push({ externalLeadId: normalized.externalLeadId, leadId: String(existing._id), action: "merged", filledFields: Object.keys(update) });
        await recordEvent({
            userId: null,
            event: "LEAD_MERGED_FROM_SHEET",
            properties: { leadId: String(existing._id), externalLeadId: normalized.externalLeadId, filledFields: Object.keys(update) },
            metadata: { importedBy: actorUserId, importedByRole: actorRole },
        });
    }

    return { status: "OK", summary, details };
}

module.exports = { runLeadSheetSync, MAX_ROWS_PER_RUN };
