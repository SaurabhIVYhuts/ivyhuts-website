// GET/POST /api/leads/:id/meetings — Milestone 23.10.
//
// GET lists every meeting for this lead, most recently scheduled first.
// POST schedules a new one. A Lead can have many meetings (one-to-many —
// see Meeting.js's own header comment) — this never replaces or merges
// with an existing meeting, unlike Discovery/AccommodationCuration's
// upsert-by-leadId routes.
//
// A meeting always starts "scheduled" with recording/transcript status
// "none" — there is no live recording/transcription provider to ever
// create one already "available" (Milestone 23.9/23.10: do not fabricate
// this state). Advancing status happens only through explicit PATCH calls
// to .../meetings/:meetingId, made by an agent.
//
// Milestone 23.14 — scheduling a meeting ALSO attempts to create a real
// Google Meet conference (best-effort, never blocking): if
// googleMeetProvider is configured, the meeting is created WITH a real
// meetingUrl attached; if not configured, or the attempt fails, the
// Meeting record is still created successfully exactly as before this
// milestone (provider/providerMeetingId/meetingUrl simply stay null) —
// this preserves the existing, already-tested "scheduling a meeting always
// succeeds" contract rather than making a new external dependency a hard
// requirement of basic meeting tracking.
const { connectToDatabase } = require("../../../_lib/mongodb");
const { requireRole } = require("../../../_lib/businessAuth");
const { checkBusinessWriteRateLimit } = require("../../../_lib/businessRateLimit");
const { withCors } = require("../../../_lib/cors");
const Lead = require("../../../_lib/models/Lead");
const Meeting = require("../../../_lib/models/Meeting");
const { createMeeting: createGoogleMeet } = require("../../../_lib/providers/meeting/googleMeetProvider");
const { createNotification } = require("../../../_lib/notify");
const { withErrorHandling, requireObjectId, notFound, badRequest, parseJsonBody, parseDate } = require("../../../_lib/validation");
const { sendSuccess, sendCollection } = require("../../../_lib/apiResponse");

const INTERNAL_ROLES = ["MARKETING_AGENT", "MARKETING_MANAGER", "ADMIN"];
// Meeting scheduling authority — an agent conducts and completes meetings
// but does not independently choose when one happens; that decision (and
// any reschedule/cancel of it, see .../meetings/[meetingId]/index.js) is
// management's call, enforced here server-side rather than only hidden in
// the CRM UI.
const MANAGEMENT_ROLES = ["MARKETING_MANAGER", "ADMIN"];
const MAX_PAYLOAD_BYTES = 2_000; // scheduledAt + short notes — same "reject the unreasonable" convention as every other lead-scoped route.

function toSafeMeeting(doc) {
    return {
        id: String(doc._id),
        leadId: String(doc.leadId),
        status: doc.status,
        scheduledAt: doc.scheduledAt,
        completedAt: doc.completedAt,
        provider: doc.provider,
        providerMeetingId: doc.providerMeetingId,
        meetingUrl: doc.meetingUrl,
        recordingStatus: doc.recordingStatus,
        recordingUrl: doc.recordingUrl,
        transcriptStatus: doc.transcriptStatus,
        transcriptReference: doc.transcriptReference,
        transcriptText: doc.transcriptText,
        extractedRequirements: doc.extractedRequirements || null,
        notes: doc.notes,
        createdBy: doc.createdBy ? String(doc.createdBy) : null,
        updatedBy: doc.updatedBy ? String(doc.updatedBy) : null,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
    };
}

async function handleGet(req, res, leadId) {
    const identity = await requireRole(req, res, INTERNAL_ROLES);
    if (!identity) return;

    await connectToDatabase();
    const lead = await Lead.findById(leadId);
    if (!lead) throw notFound("Lead not found.");

    const meetings = await Meeting.find({ leadId }).sort({ scheduledAt: -1 });
    sendCollection(res, meetings.map(toSafeMeeting), { total: meetings.length });
}

async function handlePost(req, res, leadId) {
    const identity = await requireRole(req, res, MANAGEMENT_ROLES);
    if (!identity) return;

    await checkBusinessWriteRateLimit(req);
    await connectToDatabase();

    const lead = await Lead.findById(leadId);
    if (!lead) throw notFound("Lead not found.");

    const raw = req.body;
    const rawSize = Buffer.byteLength(typeof raw === "string" ? raw : JSON.stringify(raw || {}), "utf8");
    if (rawSize > MAX_PAYLOAD_BYTES) {
        throw badRequest("PAYLOAD_TOO_LARGE", `Request body exceeds the ${MAX_PAYLOAD_BYTES}-byte limit.`);
    }
    const body = parseJsonBody(req);

    const scheduledAt = parseDate(body.scheduledAt, "scheduledAt");
    if (!scheduledAt) throw badRequest("VALIDATION_ERROR", "scheduledAt is required.");
    if (body.notes !== undefined && body.notes !== null && typeof body.notes !== "string") {
        throw badRequest("VALIDATION_ERROR", "notes must be a string or null.");
    }

    // Best-effort real Google Meet creation — see this file's header
    // comment. Awaited (not fire-and-forget) so the response the agent sees
    // immediately reflects whether a real link is attached, but its own
    // failure/NOT_CONFIGURED result never prevents the Meeting from being
    // created below.
    const meetResult = await createGoogleMeet({
        scheduledAt,
        summary: lead.contact && lead.contact.name ? `IVYHUTS consultation — ${lead.contact.name}` : "IVYHUTS accommodation consultation",
        leadId: String(lead._id),
    }).catch((err) => {
        console.error("[meetings] Google Meet provider threw unexpectedly (non-fatal):", err.message);
        return { status: "ERROR", provider: null, providerMeetingId: null, meetingUrl: null };
    });

    const meeting = await Meeting.create({
        leadId,
        scheduledAt,
        notes: body.notes || null,
        provider: meetResult.status === "OK" ? meetResult.provider : null,
        providerMeetingId: meetResult.status === "OK" ? meetResult.providerMeetingId : null,
        meetingUrl: meetResult.status === "OK" ? meetResult.meetingUrl : null,
        createdBy: identity.mongoUser._id,
        updatedBy: identity.mongoUser._id,
    });

    // The agent works the lead but does not choose the meeting time (see
    // MANAGEMENT_ROLES above) — same "assignment must trigger agent action"
    // notification pattern as assignment.js, fire-and-forget-safe (notify.js).
    if (lead.assignedTo) {
        const studentName = (lead.contact && lead.contact.name) || "this lead";
        await createNotification({
            recipientUserId: lead.assignedTo,
            leadId: lead._id,
            type: "MEETING_SCHEDULED",
            title: "Meeting scheduled",
            message: `A meeting with ${studentName} was scheduled for ${scheduledAt.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}.`,
            actionHref: `/dashboard/leads/${lead._id}#meeting`,
        });
    }

    sendSuccess(res, toSafeMeeting(meeting), 201);
}

const handler = withErrorHandling(async (req, res) => {
    if (withCors(req, res)) return; // preflight handled

    const leadId = requireObjectId(req.query.id, "id");

    if (req.method === "GET") return handleGet(req, res, leadId);
    if (req.method === "POST") return handlePost(req, res, leadId);

    res.status(405).json({ error: "Method not allowed" });
});

// Exposed for scripts/verify-meetings.js's pure unit tests, same precedent
// as every other lead-scoped route in this repo.
handler.toSafeMeeting = toSafeMeeting;
handler.MAX_PAYLOAD_BYTES = MAX_PAYLOAD_BYTES;
handler.MANAGEMENT_ROLES = MANAGEMENT_ROLES;

module.exports = handler;
