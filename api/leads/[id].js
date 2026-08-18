// GET    /api/leads/:id — detail + bounded related records, internal roles only.
// PATCH  /api/leads/:id — controlled business-field update, internal roles only.
// DELETE /api/leads/:id — soft delete (archive), ADMIN/MARKETING_MANAGER only.
const { connectToDatabase } = require("../_lib/mongodb");
const { requireRole } = require("../_lib/businessAuth");
const { checkBusinessWriteRateLimit } = require("../_lib/businessRateLimit");
const Lead = require("../_lib/models/Lead");
const Enquiry = require("../_lib/models/Enquiry");
const FollowUp = require("../_lib/models/FollowUp");
const Communication = require("../_lib/models/Communication");
const { toSafeLead } = require("../_lib/leadView");
const { recordEvent } = require("../_lib/events");
const { withErrorHandling, requireObjectId, notFound, badRequest, parseEnumParam, parseNumberParam, parseJsonBody } = require("../_lib/validation");
const { sendSuccess } = require("../_lib/apiResponse");
const { withCors } = require("../_lib/cors");

const INTERNAL_ROLES = ["MARKETING_AGENT", "MARKETING_MANAGER", "ADMIN"];
const DELETE_ROLES = ["MARKETING_MANAGER", "ADMIN"];
// Kept in sync with api/_lib/models/Lead.js's LEAD_STATUSES (Milestone 22).
const LEAD_STATUSES = ["new", "contacted", "qualified", "nurturing", "converted", "lost"];
const LEAD_TEMPERATURES = ["cold", "warm", "hot"];

// Fields a PATCH may never touch, even if present in the body — internal
// audit fields, generated ids, and anything owned by a different endpoint
// (assignment has its own dedicated route with its own validation).
const IMMUTABLE_FIELDS = new Set(["_id", "id", "createdAt", "updatedAt", "assignedTo", "userId"]);

async function buildLeadDetail(lead) {
    const [enquiries, followUps, communications] = await Promise.all([
        Enquiry.find({ leadId: lead._id }).sort({ createdAt: -1 }).limit(10).select("status source property contact createdAt"),
        FollowUp.find({ leadId: lead._id }).sort({ dueAt: 1 }).limit(10).select("type priority dueAt status notes"),
        Communication.find({ leadId: lead._id }).sort({ createdAt: -1 }).limit(10).select("channel direction type status createdAt"),
    ]);
    return { ...toSafeLead(lead), enquiries, followUps, communications };
}

async function handleGet(req, res, id) {
    const identity = await requireRole(req, res, INTERNAL_ROLES);
    if (!identity) return;
    await connectToDatabase();
    const lead = await Lead.findById(id);
    if (!lead) throw notFound("Lead not found.");
    sendSuccess(res, await buildLeadDetail(lead));
}

async function handlePatch(req, res, id) {
    const identity = await requireRole(req, res, INTERNAL_ROLES);
    if (!identity) return;
    await connectToDatabase();
    const lead = await Lead.findById(id);
    if (!lead) throw notFound("Lead not found.");

    const body = parseJsonBody(req);
    const attemptedImmutable = Object.keys(body).filter((k) => IMMUTABLE_FIELDS.has(k));
    if (attemptedImmutable.length) {
        throw badRequest("VALIDATION_ERROR", `These fields cannot be updated here: ${attemptedImmutable.join(", ")}.`);
    }

    const previousStatus = lead.status;

    if (body.status !== undefined) lead.status = parseEnumParam(body.status, LEAD_STATUSES, "status");
    if (body.temperature !== undefined) lead.temperature = parseEnumParam(body.temperature, LEAD_TEMPERATURES, "temperature");
    if (body.source !== undefined) lead.source = body.source;
    if (body.sourceDetails !== undefined && typeof body.sourceDetails === "object") lead.sourceDetails = body.sourceDetails;
    if (body.notes !== undefined) lead.notes = body.notes;
    if (Array.isArray(body.tags)) lead.tags = body.tags.map(String);
    if (body.score !== undefined) lead.score = parseNumberParam(body.score, "score");
    if (body.lostReason !== undefined) lead.lostReason = body.lostReason;

    if (body.contact && typeof body.contact === "object") {
        if (body.contact.name !== undefined) lead.contact.name = body.contact.name;
        if (body.contact.email !== undefined) lead.contact.email = body.contact.email;
        if (body.contact.phone !== undefined) lead.contact.phone = body.contact.phone;
    }
    if (body.property && typeof body.property === "object") {
        if (body.property.id !== undefined) lead.property.id = body.property.id;
        if (body.property.name !== undefined) lead.property.name = body.property.name;
        if (body.property.city !== undefined) lead.property.city = body.property.city;
    }

    if (body.status === "converted" && previousStatus !== "converted") lead.convertedAt = new Date();
    if (body.status === "lost" && previousStatus !== "lost") lead.lostAt = new Date();
    lead.lastContactAt = new Date();

    await lead.save();

    if (body.status !== undefined && lead.status !== previousStatus) {
        await recordEvent({
            userId: lead.userId,
            event: "LEAD_STATUS_CHANGED",
            properties: { leadId: String(lead._id), from: previousStatus, to: lead.status },
            metadata: { changedBy: String(identity.mongoUser._id), changedByRole: identity.mongoUser.role },
        });
    }

    sendSuccess(res, toSafeLead(lead));
}

async function handleDelete(req, res, id) {
    const identity = await requireRole(req, res, DELETE_ROLES);
    if (!identity) return;
    await connectToDatabase();
    const lead = await Lead.findById(id);
    if (!lead) throw notFound("Lead not found.");

    lead.archivedAt = new Date();
    await lead.save();

    sendSuccess(res, toSafeLead(lead));
}

module.exports = withErrorHandling(async (req, res) => {
    if (withCors(req, res)) return; // preflight handled

    const id = requireObjectId(req.query.id, "id");
    if (req.method === "GET") return handleGet(req, res, id);
    if (req.method === "PATCH") {
        await checkBusinessWriteRateLimit(req);
        return handlePatch(req, res, id);
    }
    if (req.method === "DELETE") {
        await checkBusinessWriteRateLimit(req);
        return handleDelete(req, res, id);
    }
    res.status(405).json({ error: "Method not allowed" });
});
