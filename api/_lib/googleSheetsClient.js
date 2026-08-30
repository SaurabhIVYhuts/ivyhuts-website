// Google Sheets read access — Milestone 23.14, extended Milestone 23.22.
//
// Reads the Meta Ads lead-export sheet as plain rows. Two read paths,
// tried in this order:
//
//   1. AUTHENTICATED (preferred) — the real Sheets API v4, via a service
//      account explicitly granted read access (shared with its email in
//      Google Drive). Works for a private sheet too, and is the only path
//      that existed before Milestone 23.22.
//   2. PUBLIC (Milestone 23.22, opt-in only) — a plain CSV export request
//      against ONE explicitly-configured spreadsheet ID, for the case
//      where that spreadsheet's owner has deliberately made it
//      link-readable and no service account has been set up yet. This is
//      NOT a generic "any Google Sheet URL" capability — it activates only
//      when BOTH GOOGLE_SHEETS_PUBLIC_IMPORT_ENABLED=true AND
//      GOOGLE_SHEETS_LEADS_SPREADSHEET_ID are set server-side; the import
//      route takes no client-supplied spreadsheet id/URL at all (see
//      api/leads/import/google-sheet.js), so this can never be pointed at
//      an arbitrary sheet by a request. Original Milestone 23.14 reasoning
//      for avoiding this by default still applies (a permanently-public
//      PII-bearing sheet is a real posture to be deliberate about, not
//      default into) — this is why the flag defaults OFF and is scoped to
//      exactly one server-configured id, never inferred from a request.
//
// FAILS CLOSED: without EITHER path configured, returns NOT_CONFIGURED
// rather than fabricating rows or guessing at a fallback.
//
// Uses a direct REST call (fetch) against the Sheets API's values.get
// endpoint rather than the full `googleapis` SDK — that package pulls in
// every Google API's client, which is unnecessary weight for reading one
// range of one spreadsheet; google-auth-library alone (already a
// dependency, see googleAuth.js) is enough to mint the bearer token this
// needs.
"use strict";

const { isGoogleConfigured, getGoogleAuthClient } = require("./googleAuth");

const SHEETS_READONLY_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";
const SPREADSHEET_ID = process.env.GOOGLE_SHEETS_LEADS_SPREADSHEET_ID || "";
// Defaults to the whole first sheet's used range starting at row 1 (header
// included) — overridable if the real sheet ever needs a narrower range.
const SHEET_RANGE = process.env.GOOGLE_SHEETS_LEADS_RANGE || "A1:Z";
// Milestone 23.22 — explicit opt-in only; string comparison (not a bare
// truthy env-var check) so a stray "false"/"0" left in an environment file
// can never accidentally enable this.
const PUBLIC_IMPORT_ENABLED = String(process.env.GOOGLE_SHEETS_PUBLIC_IMPORT_ENABLED || "").trim().toLowerCase() === "true";
const PUBLIC_EXPORT_TIMEOUT_MS = 15_000;

function isAuthenticatedImportConfigured() {
    return isGoogleConfigured() && Boolean(SPREADSHEET_ID);
}

function isPublicImportConfigured() {
    return PUBLIC_IMPORT_ENABLED && Boolean(SPREADSHEET_ID);
}

function isSheetsImportConfigured() {
    return isAuthenticatedImportConfigured() || isPublicImportConfigured();
}

// Minimal RFC4180-shaped CSV parser: handles comma-separated fields,
// double-quoted fields (including embedded commas/newlines), and the ""
// escaped-quote convention — exactly what Google's own CSV export
// produces. Deliberately hand-rolled rather than a new dependency for one
// narrow, well-specified format; no third-party CSV library exists
// anywhere else in this repo (confirmed by inspection before writing
// this). Returns an array of rows, each an array of raw string cells.
function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = "";
    let inQuotes = false;
    for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        if (inQuotes) {
            if (ch === '"') {
                if (text[i + 1] === '"') {
                    field += '"';
                    i += 1;
                } else {
                    inQuotes = false;
                }
            } else {
                field += ch;
            }
            continue;
        }
        if (ch === '"') {
            inQuotes = true;
        } else if (ch === ",") {
            row.push(field);
            field = "";
        } else if (ch === "\r") {
            // swallowed; \n (bare or as part of \r\n) is the real row break
        } else if (ch === "\n") {
            row.push(field);
            rows.push(row);
            row = [];
            field = "";
        } else {
            field += ch;
        }
    }
    if (field !== "" || row.length > 0) {
        row.push(field);
        rows.push(row);
    }
    return rows;
}

// Turns a parsed CSV table (header row + data rows) into the same
// { status, rows } shape the authenticated path returns, so
// leadIntake.js's normalizeMetaSheetRow never needs to know which path
// produced its input. Rows that are entirely blank (a trailing export
// artifact, not real data) are dropped before normalization ever sees them.
function tableToSheetResult(table) {
    if (table.length === 0) return { status: "OK", rows: [] };
    const header = table[0].map((h) => String(h || "").trim());
    const rows = table
        .slice(1)
        .filter((cells) => cells.some((c) => String(c || "").trim() !== ""))
        .map((cells) => {
            const row = {};
            header.forEach((key, i) => {
                if (!key) return;
                row[key] = cells[i] !== undefined ? String(cells[i]) : "";
            });
            return row;
        });
    return { status: "OK", rows };
}

async function fetchViaAuthenticatedApi() {
    const client = getGoogleAuthClient({ scopes: [SHEETS_READONLY_SCOPE] });
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(SPREADSHEET_ID)}/values/${encodeURIComponent(SHEET_RANGE)}`;
    const response = await client.request({ url, method: "GET" });
    const values = (response.data && response.data.values) || [];
    return tableToSheetResult(values);
}

// Public CSV export — no credentials sent, no signature, just the
// spreadsheet's own "anyone with the link can view" sharing setting doing
// the work. Never logs the response body (may contain real lead PII — see
// this file's own header comment and the wider "never log PII" rule
// api/leads/import/google-sheet.js's own header already follows).
async function fetchViaPublicExport() {
    const url = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(SPREADSHEET_ID)}/export?format=csv`;
    let response;
    try {
        response = await fetch(url, { signal: AbortSignal.timeout(PUBLIC_EXPORT_TIMEOUT_MS) });
    } catch (err) {
        return { status: "ERROR", reason: `Public Google Sheet export request failed: ${err.message}`, rows: [] };
    }
    if (!response.ok) {
        return {
            status: "ERROR",
            reason: `Public Google Sheet export returned HTTP ${response.status} — the sheet may no longer be shared as "anyone with the link can view", or the id is wrong.`,
            rows: [],
        };
    }
    const text = await response.text();
    return tableToSheetResult(parseCsv(text));
}

// Returns { status: "NOT_CONFIGURED" | "OK" | "ERROR", reason?, rows }
// — never throws for a configuration problem; a real fetch/API failure is
// surfaced as ERROR for the caller to turn into a 502/503, never a
// fabricated empty-but-successful result.
async function fetchLeadSheetRows() {
    // Authenticated wins whenever both happen to be configured — it's the
    // strictly more capable, more secure path (works even if the sheet
    // stops being public), so public mode never silently overrides it.
    if (isAuthenticatedImportConfigured()) {
        return fetchViaAuthenticatedApi();
    }
    if (isPublicImportConfigured()) {
        return fetchViaPublicExport();
    }

    const missing = [];
    if (!SPREADSHEET_ID) missing.push("GOOGLE_SHEETS_LEADS_SPREADSHEET_ID");
    if (!PUBLIC_IMPORT_ENABLED) {
        missing.push("GOOGLE_SERVICE_ACCOUNT_EMAIL+GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY (authenticated) or GOOGLE_SHEETS_PUBLIC_IMPORT_ENABLED=true (public, opt-in)");
    }
    return { status: "NOT_CONFIGURED", reason: `Missing: ${missing.join(", ")}`, rows: [] };
}

module.exports = {
    isSheetsImportConfigured,
    isAuthenticatedImportConfigured,
    isPublicImportConfigured,
    fetchLeadSheetRows,
    // Exposed for direct unit testing (scripts/verify-lead-intake-meet-transcript.js)
    parseCsv,
};
