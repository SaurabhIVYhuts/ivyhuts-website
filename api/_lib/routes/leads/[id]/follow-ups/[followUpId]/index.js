// GET/PATCH /api/leads/:id/follow-ups/:followUpId — Milestone 23.11.
//
// Always queried as {_id: followUpId, leadId} together — cross-lead
// isolation, same rule every other lead-scoped route in this repo follows.
// `completedAt` is never accepted from the client — set automatically,
// exactly once, on the transition INTO status="completed" (mirrors
// api/leads/[id]/meetings/[meetingId]/index.js's identical completedAt
// rule for Meeting.status). `assignedTo`/`userId`/`leadId` are never
// PATCH-able here — reassigning a follow-up to a different agent is an
// assignment concern, not a follow-up-editing concern (out of scope for
// this milestone, matching "do not build a giant task-management system").
const { connectToDatabase } = require("../../../../../mongodb");
const { requireRole } = require("../../../../../businessAuth");
const { checkBusinessWriteRateLimit } = require("../../../../../businessRateLimit");
const { withCors } = require("../../../../../cors");
const Lead = require("../../../../../models/Lead");
const FollowUp = require("../../../../../models/FollowUp");
const { withErrorHandling, requireObjectId, notFound, badRequest, parseJsonBody, parseDate } = require("../../../../../validation");
const { sendSuccess } = require("../../../../../apiResponse");
const { toSafeFollowUp } = require("../index.js");

const INTERNAL_ROLES = ["MARKETING_AGENT", "MARKETING_MANAGER", "ADMIN"];
const MAX_PAYLOAD_BYTES = 3_000;
const MAX_NOTES_LENGTH = 2_000;

async function handleGet(req, res, leadId, followUpId) {
    const identity = await requireRole(req, res, INTERNAL_ROLES);
    if (!identity) return;

    await connectToDatabase();
    const lead = await Lead.findById(leadId);
    if (!lead) throw notFound("Lead not found.");

    const followUp = await FollowUp.findOne({ _id: followUpId, leadId });
    if (!followUp) throw notFound("Follow-up not found.");

    sendSuccess(res, toSafeFollowUp(followUp));
}

async function handlePatch(req, res, leadId, followUpId) {
    const identity = await requireRole(req, res, INTERNAL_ROLES);
    if (!identity) return;

    await checkBusinessWriteRateLimit(req);
    await connectToDatabase();

    const lead = await Lead.findById(leadId);
    if (!lead) throw notFound("Lead not found.");

    const followUp = await FollowUp.findOne({ _id: followUpId, leadId });
    if (!followUp) throw notFound("Follow-up not found.");

    const raw = req.body;
    const rawSize = Buffer.byteLength(typeof raw === "string" ? raw : JSON.stringify(raw || {}), "utf8");
    if (rawSize > MAX_PAYLOAD_BYTES) {
        throw badRequest("PAYLOAD_TOO_LARGE", `Request body exceeds the ${MAX_PAYLOAD_BYTES}-byte limit.`);
    }
    const body = parseJsonBody(req);

    const previousStatus = followUp.status;

    if (body.status !== undefined) {
        if (!FollowUp.FOLLOWUP_STATUSES.includes(body.status)) {
            throw badRequest("VALIDATION_ERROR", `status must be one of: ${FollowUp.FOLLOWUP_STATUSES.join(", ")}.`);
        }
        followUp.status = body.status;
    }
    if (body.type !== undefined) {
        if (!FollowUp.FOLLOWUP_TYPES.includes(body.type)) {
            throw badRequest("VALIDATION_ERROR", `type must be one of: ${FollowUp.FOLLOWUP_TYPES.join(", ")}.`);
        }
        followUp.type = body.type;
    }
    if (body.priority !== undefined) {
        if (!FollowUp.FOLLOWUP_PRIORITIES.includes(body.priority)) {
            throw badRequest("VALIDATION_ERROR", `priority must be one of: ${FollowUp.FOLLOWUP_PRIORITIES.join(", ")}.`);
        }
        followUp.priority = body.priority;
    }
    if (body.dueAt !== undefined) {
        const dueAt = parseDate(body.dueAt, "dueAt");
        if (!dueAt) throw badRequest("VALIDATION_ERROR", "dueAt must be a valid date.");
        followUp.dueAt = dueAt;
    }
    if (body.notes !== undefined) {
        if (body.notes !== null && typeof body.notes !== "string") throw badRequest("VALIDATION_ERROR", "notes must be a string or null.");
        followUp.notes = body.notes ? String(body.notes).trim().slice(0, MAX_NOTES_LENGTH) : null;
    }

    if (followUp.status === "completed" && previousStatus !== "completed") followUp.completedAt = new Date();

    await followUp.save();
    sendSuccess(res, toSafeFollowUp(followUp));
}

const handler = withErrorHandling(async (req, res) => {
    if (withCors(req, res)) return; // preflight handled

    const leadId = requireObjectId(req.query.id, "id");
    const followUpId = requireObjectId(req.query.followUpId, "followUpId");

    if (req.method === "GET") return handleGet(req, res, leadId, followUpId);
    if (req.method === "PATCH") return handlePatch(req, res, leadId, followUpId);

    res.status(405).json({ error: "Method not allowed" });
});

module.exports = handler;
