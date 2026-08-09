// GET  /api/enquiries — list, internal roles only.
// POST /api/enquiries — create; PUBLIC (anonymous enquiries are valid,
// matching the existing enquiry forms) — identity still never trusted from
// the client. Writes to MongoDB only — this is NOT a replacement for
// api/enquire.js (email) or the client-side Google Sheets write; see
// docs/marketing-data-architecture.md for how these three coexist for now.
const { connectToDatabase } = require("../_lib/mongodb");
const { requireRole, getOptionalMongoUserId } = require("../_lib/businessAuth");
const { checkBusinessWriteRateLimit } = require("../_lib/businessRateLimit");
const Enquiry = require("../_lib/models/Enquiry");
const { findOrCreateLeadForEnquiry } = require("../_lib/leadLinking");
const { toSafeEnquiry } = require("../_lib/enquiryView");
const { recordEvent } = require("../_lib/events");
const {
    withErrorHandling,
    badRequest,
    requireObjectId,
    parsePagination,
    buildPaginationMeta,
    escapeRegex,
    parseEnumParam,
    applyCreatedAtRange,
    parseJsonBody,
} = require("../_lib/validation");
const { sendCollection, sendSuccess } = require("../_lib/apiResponse");

const INTERNAL_ROLES = ["MARKETING_AGENT", "MARKETING_MANAGER", "ADMIN"];
const ENQUIRY_STATUSES = ["new", "contacted", "in_progress", "resolved", "converted", "closed"];

async function handleList(req, res) {
    const identity = await requireRole(req, res, INTERNAL_ROLES);
    if (!identity) return;

    await connectToDatabase();
    const pagination = parsePagination(req.query);
    const filter = {};

    if (req.query.search) {
        const pattern = new RegExp(escapeRegex(req.query.search.trim()), "i");
        filter.$or = [{ "contact.name": pattern }, { "contact.email": pattern }];
    }
    const status = parseEnumParam(req.query.status, ENQUIRY_STATUSES, "status");
    if (status) filter.status = status;
    if (req.query.source) filter.source = req.query.source;
    if (req.query.userId) filter.userId = requireObjectId(req.query.userId, "userId");
    if (req.query.leadId) filter.leadId = requireObjectId(req.query.leadId, "leadId");
    if (req.query.city) filter["property.city"] = req.query.city;
    applyCreatedAtRange(filter, req.query);

    const [documents, total] = await Promise.all([
        Enquiry.find(filter).sort({ createdAt: -1 }).skip(pagination.skip).limit(pagination.limit),
        Enquiry.countDocuments(filter),
    ]);

    sendCollection(res, documents.map(toSafeEnquiry), buildPaginationMeta(pagination, total));
}

async function handleCreate(req, res) {
    await connectToDatabase();
    const body = parseJsonBody(req);

    const userId = await getOptionalMongoUserId(req);

    const contact = body.contact && typeof body.contact === "object" ? {
        name: body.contact.name || null,
        email: body.contact.email || null,
        phone: body.contact.phone || null,
    } : {};
    // contact.email is intentionally optional (Enquiry.contact.email has no
    // `required` on the schema — see api/_lib/models/Enquiry.js) — some
    // forms (e.g. ContactPage) only collect name + phone. contact.name is
    // still the one non-negotiable field: an enquiry with literally no name
    // and no email has nothing to reach the person by.
    if (!contact.name) {
        throw badRequest("VALIDATION_ERROR", "contact.name is required.");
    }

    const property = body.property && typeof body.property === "object" ? {
        id: body.property.id || null,
        name: body.property.name || null,
        city: body.property.city || null,
    } : {};

    const source = body.source || null;

    let leadId = null;
    if (body.leadId) {
        leadId = requireObjectId(body.leadId, "leadId");
    } else {
        const lead = await findOrCreateLeadForEnquiry({ userId, contact, source, sourceDetails: { fromEnquiry: true }, property });
        leadId = lead._id;
    }

    const enquiry = await Enquiry.create({
        userId: userId || null,
        leadId,
        property,
        message: body.message || null,
        contact,
        source,
        status: "new",
    });

    await recordEvent({
        userId,
        event: "ENQUIRY_SUBMITTED",
        properties: { enquiryId: String(enquiry._id), leadId: String(leadId), propertyId: property.id },
        metadata: { source },
    });

    sendSuccess(res, toSafeEnquiry(enquiry), 201);
}

module.exports = withErrorHandling(async (req, res) => {
    if (req.method === "GET") return handleList(req, res);
    if (req.method === "POST") {
        await checkBusinessWriteRateLimit(req);
        return handleCreate(req, res);
    }
    res.status(405).json({ error: "Method not allowed" });
});
