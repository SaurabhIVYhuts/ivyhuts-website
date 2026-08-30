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
const { updateMeetingTime, cancelMeeting: cancelGoogleMeeting } = require("../../../../_lib/providers/meeting/googleMeetProvider");
const { createNotification } = require("../../../../_lib/notify");
const { withErrorHandling, requireObjectId, notFound, badRequest, forbidden, parseJsonBody, parseDate } = require("../../../../_lib/validation");
const { sendSuccess } = require("../../../../_lib/apiResponse");
const { toSafeMeeting, MANAGEMENT_ROLES } = require("../index.js");

const INTERNAL_ROLES = ["MARKETING_AGENT", "MARKETING_MANAGER", "ADMIN"];
// Milestone 23.14 — raised from 4,000 to accommodate a real, agent-pasted
// meeting transcript (transcriptText below); still a bounded, defensive
// cap (roughly a 45-60 minute meeting's worth of transcript text), not
// unlimited.
const MAX_PAYLOAD_BYTES = 60_000;
const MAX_TRANSCRIPT_TEXT_CHARS = 50_000;

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

    // Meeting scheduling authority — same rule as POST .../meetings (see
    // that file's header comment): an agent may conduct/complete a meeting
    // and update everything about it EXCEPT when or whether it happens.
    // Rescheduling (scheduledAt) or cancelling (status: "cancelled") is
    // management's call, enforced here rather than only hidden in the UI.
    const changesSchedule = body.scheduledAt !== undefined;
    const cancels = body.status === "cancelled";
    if ((changesSchedule || cancels) && !MANAGEMENT_ROLES.includes(identity.mongoUser.role)) {
        throw forbidden("Only a manager or admin can reschedule or cancel a meeting.");
    }

    const previousStatus = meeting.status;
    const previousScheduledAt = meeting.scheduledAt;

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
    // Milestone 23.14 — the actual transcript text, independent of the
    // reference/status pairing above (a meeting can have a reference link
    // AND/OR pasted text). Never validated against transcriptStatus — an
    // agent may paste text before formally marking the transcript
    // "available". Setting this to null does not clear extractedRequirements
    // (a past extraction result stays visible until a new one overwrites it
    // or the agent confirms it into Discovery) — this endpoint never
    // triggers extraction itself, see .../extract-requirements.js.
    if (body.transcriptText !== undefined) {
        if (body.transcriptText !== null) {
            if (typeof body.transcriptText !== "string") throw badRequest("VALIDATION_ERROR", "transcriptText must be a string or null.");
            if (body.transcriptText.length > MAX_TRANSCRIPT_TEXT_CHARS) {
                throw badRequest("VALIDATION_ERROR", `transcriptText cannot exceed ${MAX_TRANSCRIPT_TEXT_CHARS} characters.`);
            }
        }
        meeting.transcriptText = body.transcriptText;
    }
    // Milestone 23.14 — the explicit agent action that closes the loop on a
    // transcript suggestion: NOT the same request as confirming Discovery
    // (that stays PUT /discovery, the sole write path into Discovery), but
    // the second half of what the Agent Review UI's "Confirm All"/"Review &
    // Edit" actions must call so the lead stops showing in the work queue's
    // transcriptAvailableNeedsReview bucket forever. A one-way boolean
    // action rather than an open `extractedRequirements.status` setter —
    // there is exactly one legitimate transition an agent can make here.
    if (body.markExtractedRequirementsReviewed === true) {
        if (!meeting.extractedRequirements) {
            throw badRequest("VALIDATION_ERROR", "This meeting has no extracted requirements to mark reviewed.");
        }
        meeting.extractedRequirements.status = "reviewed";
    }

    if (meeting.status === "completed" && previousStatus !== "completed") meeting.completedAt = new Date();
    meeting.updatedBy = identity.mongoUser._id;

    const scheduleGenuinelyChanged = changesSchedule && meeting.scheduledAt.getTime() !== previousScheduledAt.getTime();
    const genuinelyCancelled = cancels && previousStatus !== "cancelled";

    // Best-effort real Calendar sync — see googleMeetProvider.js's own
    // header comments on updateMeetingTime/cancelMeeting. Never blocks or
    // fails this PATCH: the Meeting record (the CRM's own source of truth
    // for scheduledAt/status) still saves below exactly as before this
    // milestone even when Calendar isn't configured or the sync call fails,
    // and this never fabricates a "synced" outcome — only ever a real call.
    if (scheduleGenuinelyChanged && meeting.provider === "google_meet" && meeting.providerMeetingId) {
        const syncResult = await updateMeetingTime({ providerMeetingId: meeting.providerMeetingId, scheduledAt: meeting.scheduledAt }).catch((err) => {
            console.error("[meetings] Google Calendar reschedule sync threw unexpectedly (non-fatal):", err.message);
            return { status: "ERROR" };
        });
        if (syncResult.status !== "OK") {
            console.error(`[meetings] Google Calendar reschedule sync for meeting ${meeting._id}: ${syncResult.status} — ${syncResult.reason || "unknown"}`);
        }
    }
    if (genuinelyCancelled && meeting.provider === "google_meet" && meeting.providerMeetingId) {
        const cancelResult = await cancelGoogleMeeting({ providerMeetingId: meeting.providerMeetingId }).catch((err) => {
            console.error("[meetings] Google Calendar cancellation sync threw unexpectedly (non-fatal):", err.message);
            return { status: "ERROR" };
        });
        if (cancelResult.status !== "OK") {
            console.error(`[meetings] Google Calendar cancellation sync for meeting ${meeting._id}: ${cancelResult.status} — ${cancelResult.reason || "unknown"}`);
        }
    }

    await meeting.save();

    // Same "assignment must trigger agent action" notification pattern as
    // assignment.js/meetings/index.js — only on a genuine change, never a
    // no-op re-save, and only when the lead actually has an assigned agent
    // to notify.
    if (lead.assignedTo) {
        const studentName = (lead.contact && lead.contact.name) || "this lead";
        if (scheduleGenuinelyChanged) {
            await createNotification({
                recipientUserId: lead.assignedTo,
                leadId: lead._id,
                type: "MEETING_RESCHEDULED",
                title: "Meeting rescheduled",
                message: `The meeting with ${studentName} was moved to ${meeting.scheduledAt.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}.`,
                actionHref: `/dashboard/leads/${lead._id}#meeting`,
            });
        }
        if (genuinelyCancelled) {
            await createNotification({
                recipientUserId: lead.assignedTo,
                leadId: lead._id,
                type: "MEETING_CANCELLED",
                title: "Meeting cancelled",
                message: `The meeting with ${studentName} scheduled for ${previousScheduledAt.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })} was cancelled.`,
                actionHref: `/dashboard/leads/${lead._id}#meeting`,
            });
        }
    }

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
