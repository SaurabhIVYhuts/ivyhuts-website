// Vercel serverless function -- Student Plan PPT generation (Milestone 9).
//
// Architecture (plan item 3/4): this endpoint is a PRESENTATION layer only.
// It receives the exact plannerResult object StudentPlannerPage.js already
// holds in React state after its one /api/student-planner request, and
// turns it into a .pptx. It never independently calls Amber, never
// recomputes career ranking/salary/readiness, never talks to Mongo or any
// external service -- see ./_lib/pptBuilder.js's own header comment. The
// website and this PPT are simply two different presentations of the same
// planner result (plan item: "Amber -> Accommodation Data only; IVYHUTS ->
// Student/Career/Business intelligence").
//
// Trust boundary (plan item 5): the payload originates in an unauthenticated
// browser, so it is treated as untrusted input even though its *shape* is
// one this server itself produced moments earlier -- see
// ./_lib/pptValidation.js (structural validation + size ceiling) and
// ./_lib/pptNormalize.js (per-field cleaning/capping; degrades ungracefully-
// missing sections to "unavailable" rather than rejecting the whole plan).
const { parseJsonBody, ApiError } = require("../../validation");
const { validatePlannerPayload, assertPayloadSize, MAX_PAYLOAD_BYTES } = require("../../pptValidation");
const { normalizePlannerForPresentation } = require("../../pptNormalize");
const { generateStudentPlanPptxBuffer } = require("../../pptBuilder");

const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

// Builds a safe, student/university-aware download filename entirely
// server-side from already-normalized (control-character-stripped,
// length-capped) text -- never a raw client string, and restricted to a
// tiny safe character set so it can never smuggle a path separator or other
// filesystem-meaningful character into the Content-Disposition header
// (plan item 21/26 -- "do not expose filesystem paths" / "malicious
// filenames").
function buildFilename(normalized) {
    const parts = [normalized.university.available ? normalized.university.name : null, normalized.student.degree]
        .filter(Boolean)
        .join("-");
    const slug = parts
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60);
    return `ivyhuts-student-plan${slug ? `-${slug}` : ""}.pptx`;
}

async function handler(req, res) {
    if (req.method !== "POST") {
        res.status(405).json({ ok: false, error: "method_not_allowed" });
        return;
    }

    // Fail fast on an obviously oversized body before doing any parsing
    // work, using the Content-Length header when the platform provides one
    // -- a cheap first line of defense on top of assertPayloadSize() below,
    // which re-checks the actual parsed size regardless (plan item 25).
    const declaredLength = Number(req.headers["content-length"]);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_PAYLOAD_BYTES) {
        res.status(413).json({ ok: false, error: "payload_too_large", message: `Request body exceeds the ${MAX_PAYLOAD_BYTES}-byte limit.` });
        return;
    }

    try {
        const body = parseJsonBody(req);
        assertPayloadSize(body);
        validatePlannerPayload(body);

        // Presentation-only transformation (plan item 19/20): selects,
        // caps, and formats what's already in the planner result. Never
        // re-ranks careers, never recomputes salary or readiness.
        const normalized = normalizePlannerForPresentation(body);

        // Zero network calls, zero filesystem writes -- the buffer is built
        // entirely in memory (see pptBuilder.js's own header comment),
        // which is what makes this safe inside a Vercel serverless function.
        const buffer = await generateStudentPlanPptxBuffer(normalized);

        res.setHeader("Content-Type", PPTX_MIME);
        res.setHeader("Content-Disposition", `attachment; filename="${buildFilename(normalized)}"`);
        res.setHeader("Content-Length", String(buffer.length));
        // Each student's plan is unique to their own submitted planner
        // result -- never cached/shared across requests.
        res.setHeader("Cache-Control", "no-store");
        res.status(200);
        res.end(buffer);
    } catch (err) {
        if (err instanceof ApiError) {
            res.status(err.status).json({ ok: false, error: err.code, message: err.message });
            return;
        }
        // Unexpected (e.g. a pptxgenjs internal failure) -- log full detail
        // server-side only, never leak a stack trace to the client (same
        // philosophy as api/student-planner.js's own catch block).
        console.error("[student-planner-ppt] unexpected error:", err);
        res.status(500).json({ ok: false, error: "internal_error", message: "Unable to generate your plan. Please try again." });
    }
}

module.exports = handler;
// Exposed for scripts/verify-ppt-generation.js to unit-test filename
// generation without needing a live HTTP request, same precedent as
// api/student-planner.js exporting buildDegreeResult.
module.exports.buildFilename = buildFilename;
