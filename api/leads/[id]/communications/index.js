// GET/POST /api/leads/:id/communications — Milestone 23.11.
//
// Uses the EXISTING Communication.js model as-is (userId/leadId/channel/
// direction/type/content/status/agentId/metadata) — no schema change. This
// is a record of an interaction that already happened; POST never sends
// anything externally (see api/leads/[id]/whatsapp/messages.js for the
// only route that would ever actually perform a send, and it's a fail-
// closed stub — no provider is integrated).
//
// Ownership is always server-derived, matching the model's own field
// semantics: `agentId` = the authenticated staff member recording this
// (session identity); `userId` = the Lead's own customer link (may be
// null for an anonymous lead) — never the request body.
const { connectToDatabase } = require("../../../_lib/mongodb");
const { requireRole } = require("../../../_lib/businessAuth");
const { checkBusinessWriteRateLimit } = require("../../../_lib/businessRateLimit");
const { withCors } = require("../../../_lib/cors");
const Lead = require("../../../_lib/models/Lead");
const Communication = require("../../../_lib/models/Communication");
const { withErrorHandling, requireObjectId, notFound, badRequest, parseJsonBody } = require("../../../_lib/validation");
const { sendSuccess, sendCollection } = require("../../../_lib/apiResponse");

const INTERNAL_ROLES = ["MARKETING_AGENT", "MARKETING_MANAGER", "ADMIN"];
const MAX_PAYLOAD_BYTES = 6_000;
const MAX_CONTENT_LENGTH = 5_000;

function toSafeCommunication(doc) {
    return {
        id: String(doc._id),
        leadId: String(doc.leadId),
        userId: doc.userId ? String(doc.userId) : null,
        channel: doc.channel,
        direction: doc.direction,
        type: doc.type,
        content: doc.content,
        status: doc.status,
        agentId: doc.agentId,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
    };
}

function validateChannelAndDirection(channel, direction) {
    if (!Communication.CHANNELS.includes(channel)) {
        throw badRequest("VALIDATION_ERROR", `channel must be one of: ${Communication.CHANNELS.join(", ")}.`);
    }
    if (!Communication.DIRECTIONS.includes(direction)) {
        throw badRequest("VALIDATION_ERROR", `direction must be one of: ${Communication.DIRECTIONS.join(", ")}.`);
    }
}

async function handleGet(req, res, leadId) {
    const identity = await requireRole(req, res, INTERNAL_ROLES);
    if (!identity) return;

    await connectToDatabase();
    const lead = await Lead.findById(leadId);
    if (!lead) throw notFound("Lead not found.");

    const communications = await Communication.find({ leadId }).sort({ createdAt: -1 });
    sendCollection(res, communications.map(toSafeCommunication), { total: communications.length });
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

    validateChannelAndDirection(body.channel, body.direction);
    const type = body.type !== undefined && body.type !== null ? String(body.type).trim().slice(0, 60) : "general";
    if (body.content !== undefined && body.content !== null && typeof body.content !== "string") {
        throw badRequest("VALIDATION_ERROR", "content must be a string or null.");
    }
    const content = body.content ? String(body.content).trim().slice(0, MAX_CONTENT_LENGTH) : null;

    const communication = await Communication.create({
        leadId,
        userId: lead.userId || null,
        channel: body.channel,
        direction: body.direction,
        type,
        content,
        agentId: String(identity.mongoUser._id),
    });

    // A logged communication IS a contact event — keep Lead.lastContactAt in
    // sync so lastInboundCommunicationAt comparisons (buildLeadDetail in
    // api/leads/[id].js) stay meaningful. This is the one place that writes
    // it for this reason.
    lead.lastContactAt = new Date();
    await lead.save();

    sendSuccess(res, toSafeCommunication(communication), 201);
}

const handler = withErrorHandling(async (req, res) => {
    if (withCors(req, res)) return; // preflight handled

    const leadId = requireObjectId(req.query.id, "id");

    if (req.method === "GET") return handleGet(req, res, leadId);
    if (req.method === "POST") return handlePost(req, res, leadId);

    res.status(405).json({ error: "Method not allowed" });
});

handler.toSafeCommunication = toSafeCommunication;
handler.validateChannelAndDirection = validateChannelAndDirection;
handler.MAX_PAYLOAD_BYTES = MAX_PAYLOAD_BYTES;

module.exports = handler;
