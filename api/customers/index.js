// GET  /api/customers — list, internal roles only (dashboard-facing).
// POST /api/customers — create/import a customer record, internal roles only.
//
// Never touches Amber; never accepts a raw client filter object (every
// supported query param is explicitly whitelisted and translated into a
// Mongoose filter below — see api/_lib/validation.js's header comment).
const { connectToDatabase } = require("../_lib/mongodb");
const { requireRole } = require("../_lib/businessAuth");
const { checkBusinessWriteRateLimit } = require("../_lib/businessRateLimit");
const User = require("../_lib/models/User");
const { toSafeCustomer } = require("../_lib/customerView");
const {
    withErrorHandling,
    badRequest,
    parsePagination,
    buildPaginationMeta,
    escapeRegex,
    parseEnumParam,
    applyCreatedAtRange,
    parseJsonBody,
} = require("../_lib/validation");
const { sendCollection, sendSuccess } = require("../_lib/apiResponse");

const INTERNAL_ROLES = ["MARKETING_AGENT", "MARKETING_MANAGER", "ADMIN"];
const ACCOMMODATION_STATUSES = ["LEAD", "ENQUIRY", "BOOKING_IN_PROGRESS", "BOOKED", "STAY_IN_PROGRESS", "MOVED_IN", "STAY_COMPLETED", "CANCELLED"];

async function handleList(req, res) {
    const identity = await requireRole(req, res, INTERNAL_ROLES);
    if (!identity) return;

    await connectToDatabase();
    const pagination = parsePagination(req.query);
    const filter = {};

    if (req.query.search) {
        const pattern = new RegExp(escapeRegex(req.query.search.trim()), "i");
        filter.$or = [{ name: pattern }, { email: pattern }];
    }
    const status = parseEnumParam(req.query.status, ACCOMMODATION_STATUSES, "status");
    if (status) filter["accommodationJourney.status"] = status;
    if (req.query.source) filter["marketing.source"] = req.query.source;
    if (req.query.city) filter["profile.city"] = req.query.city;
    applyCreatedAtRange(filter, req.query);

    const [documents, total] = await Promise.all([
        User.find(filter).sort({ createdAt: -1 }).skip(pagination.skip).limit(pagination.limit),
        User.countDocuments(filter),
    ]);

    sendCollection(res, documents.map(toSafeCustomer), buildPaginationMeta(pagination, total));
}

async function handleCreate(req, res) {
    const identity = await requireRole(req, res, INTERNAL_ROLES);
    if (!identity) return;

    await connectToDatabase();
    const body = parseJsonBody(req);
    if (!body.email || typeof body.email !== "string") throw badRequest("VALIDATION_ERROR", "email is required.");
    if (!body.name || typeof body.name !== "string") throw badRequest("VALIDATION_ERROR", "name is required.");

    const user = await User.create({
        email: body.email,
        name: body.name,
        phone: body.phone || null,
        profile: body.profile || undefined,
        marketing: body.marketing || undefined,
    });

    sendSuccess(res, toSafeCustomer(user), 201);
}

module.exports = withErrorHandling(async (req, res) => {
    if (req.method === "GET") return handleList(req, res);
    if (req.method === "POST") {
        await checkBusinessWriteRateLimit(req);
        return handleCreate(req, res);
    }
    res.status(405).json({ error: "Method not allowed" });
});
