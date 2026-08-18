// GET  /api/leads — list, internal roles only.
// POST /api/leads — create; PUBLIC (anonymous leads are valid business
// data, same as the existing enquiry forms) — but identity is still never
// trusted from the client, see handleCreate below.
const { connectToDatabase } = require("../_lib/mongodb");
const { requireRole, getOptionalMongoUserId, resolveMongoUser } = require("../_lib/businessAuth");
const { getCurrentUser } = require("../_lib/auth");
const { checkBusinessWriteRateLimit } = require("../_lib/businessRateLimit");
const Lead = require("../_lib/models/Lead");
const User = require("../_lib/models/User");
const { toSafeLead } = require("../_lib/leadView");
const { recordEvent } = require("../_lib/events");
const {
    withErrorHandling,
    badRequest,
    requireObjectId,
    parsePagination,
    buildPaginationMeta,
    escapeRegex,
    parseEnumParam,
    parseNumberParam,
    applyCreatedAtRange,
    parseJsonBody,
} = require("../_lib/validation");
const { sendCollection, sendSuccess } = require("../_lib/apiResponse");
const { withCors } = require("../_lib/cors");

const INTERNAL_ROLES = ["MARKETING_AGENT", "MARKETING_MANAGER", "ADMIN"];
// Kept in sync with api/_lib/models/Lead.js's LEAD_STATUSES (Milestone 22).
const LEAD_STATUSES = ["new", "contacted", "qualified", "nurturing", "converted", "lost"];

async function handleList(req, res) {
    const identity = await requireRole(req, res, INTERNAL_ROLES);
    if (!identity) return;

    await connectToDatabase();
    const pagination = parsePagination(req.query);
    const filter = {};

    // Archived leads are hidden by default — DELETE /api/leads/:id is a
    // soft delete (see api/leads/[id].js) and marketing data shouldn't
    // vanish from view accidentally in the other direction either.
    if (req.query.includeArchived !== "true") filter.archivedAt = null;

    if (req.query.search) {
        const pattern = new RegExp(escapeRegex(req.query.search.trim()), "i");
        filter.$or = [{ "contact.name": pattern }, { "contact.email": pattern }];
    }
    const status = parseEnumParam(req.query.status, LEAD_STATUSES, "status");
    if (status) filter.status = status;
    if (req.query.source) filter.source = req.query.source;
    if (req.query.assignedTo) filter.assignedTo = req.query.assignedTo;
    if (req.query.userId) filter.userId = requireObjectId(req.query.userId, "userId");
    if (req.query.city) filter["property.city"] = req.query.city;

    const scoreMin = parseNumberParam(req.query.scoreMin, "scoreMin");
    const scoreMax = parseNumberParam(req.query.scoreMax, "scoreMax");
    if (scoreMin !== undefined || scoreMax !== undefined) {
        filter.score = {};
        if (scoreMin !== undefined) filter.score.$gte = scoreMin;
        if (scoreMax !== undefined) filter.score.$lte = scoreMax;
    }
    applyCreatedAtRange(filter, req.query);

    const [documents, total] = await Promise.all([
        Lead.find(filter).sort({ createdAt: -1 }).skip(pagination.skip).limit(pagination.limit),
        Lead.countDocuments(filter),
    ]);

    sendCollection(res, documents.map(toSafeLead), buildPaginationMeta(pagination, total));
}

async function handleCreate(req, res) {
    await connectToDatabase();
    const body = parseJsonBody(req);

    // Identity: session-derived by default. An explicit client-supplied
    // userId is honored ONLY when the caller holds an internal role (the
    // staff-import case from the spec) and the target user is validated to
    // exist — anonymous/ordinary-user callers can never set another
    // person's userId, their value is simply ignored in favor of session
    // identity (or null, if they're not logged in either).
    let userId = await getOptionalMongoUserId(req);
    if (body.userId !== undefined && body.userId !== null) {
        const redisUser = await getCurrentUser(req);
        if (redisUser) {
            const actor = await resolveMongoUser(redisUser);
            if (INTERNAL_ROLES.includes(actor.role)) {
                const targetId = requireObjectId(body.userId, "userId");
                const target = await User.findById(targetId);
                if (!target) throw badRequest("VALIDATION_ERROR", "userId does not refer to an existing customer.");
                userId = target._id;
            }
        }
    }

    const contact = body.contact && typeof body.contact === "object" ? {
        name: body.contact.name || null,
        email: body.contact.email || null,
        phone: body.contact.phone || null,
    } : {};

    if (!userId && !contact.email) {
        throw badRequest("VALIDATION_ERROR", "A lead needs either a logged-in identity or a contact.email.");
    }

    const status = body.status ? parseEnumParam(body.status, LEAD_STATUSES, "status") : "new";

    const lead = await Lead.create({
        userId: userId || null,
        contact,
        status,
        source: body.source || null,
        sourceDetails: body.sourceDetails && typeof body.sourceDetails === "object" ? body.sourceDetails : {},
        property: body.property && typeof body.property === "object" ? {
            id: body.property.id || null,
            name: body.property.name || null,
            city: body.property.city || null,
        } : {},
        notes: body.notes || null,
        firstContactAt: new Date(),
        lastContactAt: new Date(),
    });

    await recordEvent({
        userId: lead.userId,
        event: "LEAD_CREATED",
        properties: { leadId: String(lead._id), source: lead.source },
    });

    sendSuccess(res, toSafeLead(lead), 201);
}

module.exports = withErrorHandling(async (req, res) => {
    if (withCors(req, res)) return; // preflight handled

    if (req.method === "GET") return handleList(req, res);
    if (req.method === "POST") {
        await checkBusinessWriteRateLimit(req);
        return handleCreate(req, res);
    }
    res.status(405).json({ error: "Method not allowed" });
});
