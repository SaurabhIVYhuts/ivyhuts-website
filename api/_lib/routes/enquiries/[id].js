// GET   /api/enquiries/:id — detail, internal roles only.
// PATCH /api/enquiries/:id — status/leadId update, internal roles only.
const { connectToDatabase } = require("../../mongodb");
const { requireRole } = require("../../businessAuth");
const { checkBusinessWriteRateLimit } = require("../../businessRateLimit");
const Enquiry = require("../../models/Enquiry");
const Lead = require("../../models/Lead");
const { toSafeEnquiry } = require("../../enquiryView");
const { withErrorHandling, requireObjectId, notFound, badRequest, parseEnumParam, parseJsonBody } = require("../../validation");
const { sendSuccess } = require("../../apiResponse");

const INTERNAL_ROLES = ["MARKETING_AGENT", "MARKETING_MANAGER", "ADMIN"];
const ENQUIRY_STATUSES = ["new", "contacted", "in_progress", "resolved", "converted", "closed"];

async function handleGet(req, res, id) {
    const identity = await requireRole(req, res, INTERNAL_ROLES);
    if (!identity) return;
    await connectToDatabase();
    const enquiry = await Enquiry.findById(id);
    if (!enquiry) throw notFound("Enquiry not found.");
    sendSuccess(res, toSafeEnquiry(enquiry));
}

async function handlePatch(req, res, id) {
    const identity = await requireRole(req, res, INTERNAL_ROLES);
    if (!identity) return;
    await connectToDatabase();
    const enquiry = await Enquiry.findById(id);
    if (!enquiry) throw notFound("Enquiry not found.");

    const body = parseJsonBody(req);
    if (body.status !== undefined) enquiry.status = parseEnumParam(body.status, ENQUIRY_STATUSES, "status");
    if (body.leadId !== undefined) {
        if (body.leadId === null) {
            enquiry.leadId = null;
        } else {
            const leadId = requireObjectId(body.leadId, "leadId");
            const lead = await Lead.findById(leadId);
            if (!lead) throw badRequest("VALIDATION_ERROR", "leadId does not refer to an existing lead.");
            enquiry.leadId = leadId;
        }
    }

    await enquiry.save();
    sendSuccess(res, toSafeEnquiry(enquiry));
}

module.exports = withErrorHandling(async (req, res) => {
    const id = requireObjectId(req.query.id, "id");
    if (req.method === "GET") return handleGet(req, res, id);
    if (req.method === "PATCH") {
        await checkBusinessWriteRateLimit(req);
        return handlePatch(req, res, id);
    }
    res.status(405).json({ error: "Method not allowed" });
});
