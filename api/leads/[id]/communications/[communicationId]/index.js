// GET/PATCH /api/leads/:id/communications/:communicationId — Milestone 23.11.
//
// Always queried as {_id: communicationId, leadId} together, never
// `_id` alone — cross-lead isolation, same rule every other lead-scoped
// route in this repo follows. PATCH may correct channel/direction/type/
// content/status after the fact (a typo in a logged call, for instance) —
// it never reassigns `agentId` (who the interaction was logged by/with is
// an immutable fact of the record, not something a later editor claims for
// themselves) and never touches `userId`/`leadId`.
const { connectToDatabase } = require("../../../../_lib/mongodb");
const { requireRole } = require("../../../../_lib/businessAuth");
const { checkBusinessWriteRateLimit } = require("../../../../_lib/businessRateLimit");
const { withCors } = require("../../../../_lib/cors");
const Lead = require("../../../../_lib/models/Lead");
const Communication = require("../../../../_lib/models/Communication");
const { withErrorHandling, requireObjectId, notFound, badRequest, parseJsonBody } = require("../../../../_lib/validation");
const { sendSuccess } = require("../../../../_lib/apiResponse");
const { toSafeCommunication, validateChannelAndDirection } = require("../index.js");

const INTERNAL_ROLES = ["MARKETING_AGENT", "MARKETING_MANAGER", "ADMIN"];
const MAX_PAYLOAD_BYTES = 6_000;
const MAX_CONTENT_LENGTH = 5_000;

async function handleGet(req, res, leadId, communicationId) {
    const identity = await requireRole(req, res, INTERNAL_ROLES);
    if (!identity) return;

    await connectToDatabase();
    const lead = await Lead.findById(leadId);
    if (!lead) throw notFound("Lead not found.");

    const communication = await Communication.findOne({ _id: communicationId, leadId });
    if (!communication) throw notFound("Communication not found.");

    sendSuccess(res, toSafeCommunication(communication));
}

async function handlePatch(req, res, leadId, communicationId) {
    const identity = await requireRole(req, res, INTERNAL_ROLES);
    if (!identity) return;

    await checkBusinessWriteRateLimit(req);
    await connectToDatabase();

    const lead = await Lead.findById(leadId);
    if (!lead) throw notFound("Lead not found.");

    const communication = await Communication.findOne({ _id: communicationId, leadId });
    if (!communication) throw notFound("Communication not found.");

    const raw = req.body;
    const rawSize = Buffer.byteLength(typeof raw === "string" ? raw : JSON.stringify(raw || {}), "utf8");
    if (rawSize > MAX_PAYLOAD_BYTES) {
        throw badRequest("PAYLOAD_TOO_LARGE", `Request body exceeds the ${MAX_PAYLOAD_BYTES}-byte limit.`);
    }
    const body = parseJsonBody(req);

    const effectiveChannel = body.channel !== undefined ? body.channel : communication.channel;
    const effectiveDirection = body.direction !== undefined ? body.direction : communication.direction;
    if (body.channel !== undefined || body.direction !== undefined) {
        validateChannelAndDirection(effectiveChannel, effectiveDirection);
        communication.channel = effectiveChannel;
        communication.direction = effectiveDirection;
    }
    if (body.type !== undefined) {
        communication.type = body.type ? String(body.type).trim().slice(0, 60) : "general";
    }
    if (body.content !== undefined) {
        if (body.content !== null && typeof body.content !== "string") throw badRequest("VALIDATION_ERROR", "content must be a string or null.");
        communication.content = body.content ? String(body.content).trim().slice(0, MAX_CONTENT_LENGTH) : null;
    }
    if (body.status !== undefined) {
        if (body.status !== null && typeof body.status !== "string") throw badRequest("VALIDATION_ERROR", "status must be a string or null.");
        communication.status = body.status;
    }

    await communication.save();
    sendSuccess(res, toSafeCommunication(communication));
}

const handler = withErrorHandling(async (req, res) => {
    if (withCors(req, res)) return; // preflight handled

    const leadId = requireObjectId(req.query.id, "id");
    const communicationId = requireObjectId(req.query.communicationId, "communicationId");

    if (req.method === "GET") return handleGet(req, res, leadId, communicationId);
    if (req.method === "PATCH") return handlePatch(req, res, leadId, communicationId);

    res.status(405).json({ error: "Method not allowed" });
});

module.exports = handler;
