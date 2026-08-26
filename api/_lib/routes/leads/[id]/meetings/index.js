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
const { connectToDatabase } = require("../../../../mongodb");
const { requireRole } = require("../../../../businessAuth");
const { checkBusinessWriteRateLimit } = require("../../../../businessRateLimit");
const { withCors } = require("../../../../cors");
const Lead = require("../../../../models/Lead");
const Meeting = require("../../../../models/Meeting");
const { withErrorHandling, requireObjectId, notFound, badRequest, parseJsonBody, parseDate } = require("../../../../validation");
const { sendSuccess, sendCollection } = require("../../../../apiResponse");

const INTERNAL_ROLES = ["MARKETING_AGENT", "MARKETING_MANAGER", "ADMIN"];
const MAX_PAYLOAD_BYTES = 2_000; // scheduledAt + short notes — same "reject the unreasonable" convention as every other lead-scoped route.

function toSafeMeeting(doc) {
    return {
        id: String(doc._id),
        leadId: String(doc.leadId),
        status: doc.status,
        scheduledAt: doc.scheduledAt,
        completedAt: doc.completedAt,
        recordingStatus: doc.recordingStatus,
        recordingUrl: doc.recordingUrl,
        transcriptStatus: doc.transcriptStatus,
        transcriptReference: doc.transcriptReference,
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
    const identity = await requireRole(req, res, INTERNAL_ROLES);
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

    const meeting = await Meeting.create({
        leadId,
        scheduledAt,
        notes: body.notes || null,
        createdBy: identity.mongoUser._id,
        updatedBy: identity.mongoUser._id,
    });

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

module.exports = handler;
