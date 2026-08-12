// Student Plan PPT (Milestone 9) — payload validation / trust boundary.
//
// api/student-planner-ppt.js receives the SAME plannerResult object
// StudentPlannerPage.js already holds in React state after its one
// /api/student-planner request — an unauthenticated browser POSTs it back
// verbatim so the PPT can be built from "the exact planner result already
// displayed to the student" (no second Amber/career/salary/readiness
// lookup). Because that payload originates in the browser, it is untrusted
// input like any other POST body, even though its *shape* is one this
// server itself produced moments earlier. This module is the one place that
// decides whether a payload is even worth attempting to normalize/present —
// api/_lib/pptNormalize.js only ever runs on payloads that already passed
// through here.
//
// Deliberately narrow: this only checks STRUCTURAL shape (right types on
// known top-level keys) and enforces a hard size ceiling. It does not
// enforce business rules (e.g. "matchScore must be 0-100") — that's
// ./pptNormalize.js's job, which clamps/drops bad values rather than
// rejecting the whole request, since one malformed career object must never
// take down an otherwise-fine presentation (plan item 14/27.3).
"use strict";

const { ApiError } = require("./validation");

// A generous ceiling for a real planner result (5 careers with full
// salary+readiness, a handful of residences, degree data) is comfortably
// under 50KB in practice — 300KB leaves headroom while still making a
// deliberate, arbitrarily-large payload impossible.
const MAX_PAYLOAD_BYTES = 300 * 1024;

const OBJECT_FIELDS = ["student", "university", "livingExpenses", "degree"];
const ARRAY_FIELDS = ["residences", "comparison", "careers"];
const KNOWN_TOP_LEVEL_FIELDS = [...OBJECT_FIELDS, ...ARRAY_FIELDS];

function badRequest(message) {
    return new ApiError(400, "INVALID_PLANNER_PAYLOAD", message);
}

// Rejects a request outright before it's even JSON.parse()'d — cheaper than
// parsing first, and a clear defense against an arbitrarily large body
// regardless of what Vercel's own platform-level limit happens to be.
function assertPayloadSize(rawBody) {
    const byteLength = Buffer.byteLength(typeof rawBody === "string" ? rawBody : JSON.stringify(rawBody || {}), "utf8");
    if (byteLength > MAX_PAYLOAD_BYTES) {
        throw badRequest(`Planner result payload is too large (${byteLength} bytes, max ${MAX_PAYLOAD_BYTES}).`);
    }
    return byteLength;
}

// Structural validation only — never treats a field's TEXT content as
// something to execute or interpret (no HTML parsing, no template
// evaluation anywhere in this file or its callers). A payload that isn't
// even shaped like a planner result (wrong JS types on known fields, or no
// recognizable planner fields at all) is rejected with a 400; anything
// beyond that (missing optional sub-fields, out-of-range numbers, malformed
// individual list items) is left to pptNormalize.js to degrade gracefully.
function validatePlannerPayload(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw badRequest("Planner result must be a JSON object.");
    }

    const hasAnyKnownField = KNOWN_TOP_LEVEL_FIELDS.some((key) => Object.prototype.hasOwnProperty.call(body, key));
    if (!hasAnyKnownField) {
        throw badRequest("Planner result does not contain any recognizable planner fields.");
    }

    OBJECT_FIELDS.forEach((key) => {
        const value = body[key];
        if (value !== undefined && value !== null && (typeof value !== "object" || Array.isArray(value))) {
            throw badRequest(`"${key}" must be an object.`);
        }
    });

    ARRAY_FIELDS.forEach((key) => {
        const value = body[key];
        if (value !== undefined && value !== null && !Array.isArray(value)) {
            throw badRequest(`"${key}" must be an array.`);
        }
    });

    return true;
}

module.exports = { validatePlannerPayload, assertPayloadSize, MAX_PAYLOAD_BYTES };
