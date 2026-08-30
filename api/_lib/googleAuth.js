// Shared Google service-account authentication — Milestone 23.14.
//
// Confirmed by audit before writing this: NO Google OAuth/Calendar/Meet
// integration existed anywhere in either repo (no googleapis, no
// google-auth-library, no GOOGLE_* env vars, no service-account handling).
// This is the ONE place a Google service-account credential is ever loaded
// from the environment — api/_lib/googleSheetsClient.js and
// api/_lib/providers/meeting/googleMeetProvider.js both depend on this
// file rather than each parsing credentials themselves, so there is
// exactly one place that ever touches the private key.
//
// Deliberately service-account-only, not interactive user OAuth — this
// backend has no browser-based consent flow anywhere, and a server-to-
// server credential (a Google Workspace service account with domain-wide
// delegation, impersonating a real Workspace user via `subject`) is the
// correct shape for a headless CRM integration. See .env.example for the
// three required variables and exactly what to configure in Google Cloud
// Console + Google Workspace Admin.
//
// FAILS CLOSED: if the required env vars are not set, isGoogleConfigured()
// returns false and getGoogleAuthClient() throws — every caller must check
// isGoogleConfigured() first and return a NOT_CONFIGURED result instead of
// ever calling getGoogleAuthClient() when it would throw. No credential is
// ever fabricated, logged, or exposed to the CRM frontend.
"use strict";

const SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || "";
// Stored in env as a single-line string with literal "\n" sequences (the
// standard way a PEM private key survives a .env file / Vercel env var) —
// converted back to real newlines here, the one place that conversion
// happens.
const SERVICE_ACCOUNT_PRIVATE_KEY = (process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || "").replace(/\\n/g, "\n");
// The real Workspace user this service account impersonates via
// domain-wide delegation (required for Calendar/Meet creation on someone's
// real calendar, and for Sheets access scoped to a real identity rather
// than the service account's own empty Drive). Optional for Sheets-only
// read access to a sheet explicitly shared with the service account's own
// email — see googleSheetsClient.js's own comment on this distinction.
const IMPERSONATE_SUBJECT = process.env.GOOGLE_WORKSPACE_IMPERSONATE_SUBJECT || "";

function isGoogleConfigured() {
    return Boolean(SERVICE_ACCOUNT_EMAIL && SERVICE_ACCOUNT_PRIVATE_KEY);
}

// `scopes` and `subject` let each caller request exactly what it needs
// (Sheets readonly vs. Calendar events) rather than one over-broad token.
// Lazily requires google-auth-library so a codebase without the credential
// configured never even loads it.
function getGoogleAuthClient({ scopes, subject } = {}) {
    if (!isGoogleConfigured()) {
        throw new Error("Google service-account credentials are not configured (GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY).");
    }
    // eslint-disable-next-line global-require
    const { JWT } = require("google-auth-library");
    return new JWT({
        email: SERVICE_ACCOUNT_EMAIL,
        key: SERVICE_ACCOUNT_PRIVATE_KEY,
        scopes: scopes || [],
        subject: subject || IMPERSONATE_SUBJECT || undefined,
    });
}

module.exports = { isGoogleConfigured, getGoogleAuthClient, IMPERSONATE_SUBJECT };
