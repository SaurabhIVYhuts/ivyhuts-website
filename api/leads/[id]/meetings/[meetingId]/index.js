// GET/PATCH /api/leads/:id/meetings/:meetingId — Milestone 23.10.
//
// Always queried as {_id: meetingId, leadId} together, never `_id` alone —
// a meetingId that's real but belongs to a DIFFERENT lead must 404 exactly
// like one that doesn't exist at all (cross-lead isolation, same rule every
// other lead-scoped route in this repo follows).
//
// PATCH is a partial update (only the fields present in the body change,
// same spirit as discovery.js) validated against the EFFECTIVE merged
// state — in particular: recordingUrl must be a non-empty string exactly
// when the effective recordingStatus is "available", and must be null
// otherwise (never a stale URL left behind after status regresses to
// "pending"/"none"); transcriptReference follows the identical rule for
// transcriptStatus. This is the enforcement that keeps the CRM from ever
// displaying a recording/transcript link that isn't honestly backed by an
// "available" status.
const { connectToDatabase } = require("../../../../_lib/mongodb");
const { requireRole } = require("../../../../_lib/businessAuth");
const { checkBusinessWriteRateLimit } = require("../../../../_lib/businessRateLimit");
const { withCors } = require("../../../../_lib/cors");
const Lead = require("../../../../_lib/models/Lead");
const Meeting = require("../../../../_lib/models/Meeting");
const { withErrorHandling, requireObjectId, notFound, badRequest, parseJsonBody, parseDate } = require("../../../../_lib/validation");
const { sendSuccess } = require("../../../../_lib/apiResponse");
const { toSafeMeeting } = require("../index.js");

const INTERNAL_ROLES = ["MARKETING_AGENT", "MARKETING_MANAGER", "ADMIN"];
const MAX_PAYLOAD_BYTES = 4_000;

function validateMediaPair(status, url, label) {
    if (!Meeting.MEDIA_STATUSES.includes(status)) {
        throw badRequest("VALIDATION_ERROR", `${label}Status must be one of: ${Meeting.MEDIA_STATUSES.join(", ")}.`);
    }
    if (status === "available") {
        if (typeof url !== "string" || !url.trim()) {
            throw badRequest("VALIDATION_ERROR", `${label}Url/${label}Reference is required when ${label}Status is "available".`);
        }
    } else if (url !== null) {
        throw badRequest("VALIDATION_ERROR", `${label}Url/${label}Reference must be null when ${label}Status is not "available".`);
    }
}

async function handleGet(req, res, leadId, meetingId) {
    const identity = await requireRole(req, res, INTERNAL_ROLES);
    if (!identity) return;

    await connectToDatabase();
    const lead = await Lead.findById(leadId);
    if (!lead) throw notFound("Lead not found.");

    const meeting = await Meeting.findOne({ _id: meetingId, leadId });
    if (!meeting) throw notFound("Meeting not found.");

    sendSuccess(res, toSafeMeeting(meeting));
}

async function handlePatch(req, res, leadId, meetingId) {
    const identity = await requireRole(req, res, INTERNAL_ROLES);
    if (!identity) return;

    await checkBusinessWriteRateLimit(req);
    await connectToDatabase();

    const lead = await Lead.findById(leadId);
    if (!lead) throw notFound("Lead not found.");

    const meeting = await Meeting.findOne({ _id: meetingId, leadId });
    if (!meeting) throw notFound("Meeting not found.");

    const raw = req.body;
    const rawSize = Buffer.byteLength(typeof raw === "string" ? raw : JSON.stringify(raw || {}), "utf8");
    if (rawSize > MAX_PAYLOAD_BYTES) {
        throw badRequest("PAYLOAD_TOO_LARGE", `Request body exceeds the ${MAX_PAYLOAD_BYTES}-byte limit.`);
    }
    const body = parseJsonBody(req);

    const previousStatus = meeting.status;

    if (body.status !== undefined) {
        if (!Meeting.MEETING_STATUSES.includes(body.status)) {
            throw badRequest("VALIDATION_ERROR", `status must be one of: ${Meeting.MEETING_STATUSES.join(", ")}.`);
        }
        meeting.status = body.status;
    }
    if (body.scheduledAt !== undefined) {
        const scheduledAt = parseDate(body.scheduledAt, "scheduledAt");
        if (!scheduledAt) throw badRequest("VALIDATION_ERROR", "scheduledAt must be a valid date.");
        meeting.scheduledAt = scheduledAt;
    }
    if (body.notes !== undefined) {
        if (body.notes !== null && typeof body.notes !== "string") throw badRequest("VALIDATION_ERROR", "notes must be a string or null.");
        meeting.notes = body.notes;
    }

    if (body.recordingStatus !== undefined || body.recordingUrl !== undefined) {
        const effectiveStatus = body.recordingStatus !== undefined ? body.recordingStatus : meeting.recordingStatus;
        const effectiveUrl = body.recordingUrl !== undefined ? body.recordingUrl : meeting.recordingUrl;
        validateMediaPair(effectiveStatus, effectiveUrl, "recording");
        meeting.recordingStatus = effectiveStatus;
        meeting.recordingUrl = effectiveUrl;
    }
    if (body.transcriptStatus !== undefined || body.transcriptReference !== undefined) {
        const effectiveStatus = body.transcriptStatus !== undefined ? body.transcriptStatus : meeting.transcriptStatus;
        const effectiveRef = body.transcriptReference !== undefined ? body.transcriptReference : meeting.transcriptReference;
        validateMediaPair(effectiveStatus, effectiveRef, "transcript");
        meeting.transcriptStatus = effectiveStatus;
        meeting.transcriptReference = effectiveRef;
    }

    if (meeting.status === "completed" && previousStatus !== "completed") meeting.completedAt = new Date();
    meeting.updatedBy = identity.mongoUser._id;

    await meeting.save();
    sendSuccess(res, toSafeMeeting(meeting));
}

const handler = withErrorHandling(async (req, res) => {
    if (withCors(req, res)) return; // preflight handled

    const leadId = requireObjectId(req.query.id, "id");
    const meetingId = requireObjectId(req.query.meetingId, "meetingId");

    if (req.method === "GET") return handleGet(req, res, leadId, meetingId);
    if (req.method === "PATCH") return handlePatch(req, res, leadId, meetingId);

    res.status(405).json({ error: "Method not allowed" });
});

handler.validateMediaPair = validateMediaPair;

module.exports = handler;
