// GET/POST /api/leads/:id/follow-ups — Milestone 23.11.
//
// Uses the EXISTING FollowUp.js model as-is — no schema change. A
// follow-up is a sales ACTION to take, not a record of something that
// already happened (that's Communication — see follow-up's own header
// comment). `assignedTo` is deliberately derived from the LEAD's own
// `assignedTo` field, NOT the session identity — a manager can schedule a
// follow-up that's the assigned agent's responsibility, matching the CRM
// frontend's own existing contract comment
// (src/lib/api/followUps.ts: "assignedTo is never sent; the backend
// derives it from the Lead's own assignment").
const { connectToDatabase } = require("../../../_lib/mongodb");
const { requireRole } = require("../../../_lib/businessAuth");
const { checkBusinessWriteRateLimit } = require("../../../_lib/businessRateLimit");
const { withCors } = require("../../../_lib/cors");
const Lead = require("../../../_lib/models/Lead");
const FollowUp = require("../../../_lib/models/FollowUp");
const { withErrorHandling, requireObjectId, notFound, badRequest, parseJsonBody, parseDate } = require("../../../_lib/validation");
const { sendSuccess, sendCollection } = require("../../../_lib/apiResponse");

const INTERNAL_ROLES = ["MARKETING_AGENT", "MARKETING_MANAGER", "ADMIN"];
const MAX_PAYLOAD_BYTES = 3_000;
const MAX_NOTES_LENGTH = 2_000;

function toSafeFollowUp(doc) {
    return {
        id: String(doc._id),
        leadId: String(doc.leadId),
        userId: doc.userId ? String(doc.userId) : null,
        assignedTo: doc.assignedTo,
        type: doc.type,
        priority: doc.priority,
        dueAt: doc.dueAt,
        status: doc.status,
        notes: doc.notes,
        completedAt: doc.completedAt,
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

    const followUps = await FollowUp.find({ leadId }).sort({ dueAt: 1 });
    sendCollection(res, followUps.map(toSafeFollowUp), { total: followUps.length });
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

    if (!FollowUp.FOLLOWUP_TYPES.includes(body.type)) {
        throw badRequest("VALIDATION_ERROR", `type must be one of: ${FollowUp.FOLLOWUP_TYPES.join(", ")}.`);
    }
    const dueAt = parseDate(body.dueAt, "dueAt");
    if (!dueAt) throw badRequest("VALIDATION_ERROR", "dueAt is required.");
    let priority = "medium";
    if (body.priority !== undefined) {
        if (!FollowUp.FOLLOWUP_PRIORITIES.includes(body.priority)) {
            throw badRequest("VALIDATION_ERROR", `priority must be one of: ${FollowUp.FOLLOWUP_PRIORITIES.join(", ")}.`);
        }
        priority = body.priority;
    }
    if (body.notes !== undefined && body.notes !== null && typeof body.notes !== "string") {
        throw badRequest("VALIDATION_ERROR", "notes must be a string or null.");
    }
    const notes = body.notes ? String(body.notes).trim().slice(0, MAX_NOTES_LENGTH) : null;

    const followUp = await FollowUp.create({
        leadId,
        userId: lead.userId || null,
        assignedTo: lead.assignedTo || null,
        type: body.type,
        priority,
        dueAt,
        notes,
    });

    sendSuccess(res, toSafeFollowUp(followUp), 201);
}

const handler = withErrorHandling(async (req, res) => {
    if (withCors(req, res)) return; // preflight handled

    const leadId = requireObjectId(req.query.id, "id");

    if (req.method === "GET") return handleGet(req, res, leadId);
    if (req.method === "POST") return handlePost(req, res, leadId);

    res.status(405).json({ error: "Method not allowed" });
});

handler.toSafeFollowUp = toSafeFollowUp;
handler.MAX_PAYLOAD_BYTES = MAX_PAYLOAD_BYTES;

module.exports = handler;
