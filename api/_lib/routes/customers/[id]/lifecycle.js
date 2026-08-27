// PATCH /api/customers/:id/lifecycle — updates User.accommodationJourney.
//
// Internal marketing roles may update any lifecycle field. An ordinary
// USER may only touch fields listed in SELF_SERVICE_FIELDS below, and only
// on their own record. That list is currently EMPTY — deliberately: none
// of accommodationJourney's fields (status, servicePurchased, move-in/out
// dates) have an established self-service product flow yet (that would
// require an actual booking flow, which is explicitly out of scope for
// this milestone — see the "Do not create a Booking/Stay model yet"
// instruction). Rather than guess which fields might be "safe enough",
// every field stays business-controlled until the business defines a real
// self-service policy — at that point, this is a one-line whitelist change.
const { connectToDatabase } = require("../../../mongodb");
const { requireCustomerIdentity } = require("../../../businessAuth");
const { checkBusinessWriteRateLimit } = require("../../../businessRateLimit");
const User = require("../../../models/User");
const { toSafeCustomer } = require("../../../customerView");
const { recordEvent } = require("../../../events");
const { withErrorHandling, requireObjectId, notFound, forbidden, badRequest, parseEnumParam, parseDate, parseNumberParam, parseJsonBody } = require("../../../validation");
const { sendSuccess } = require("../../../apiResponse");

const INTERNAL_ROLES = ["MARKETING_AGENT", "MARKETING_MANAGER", "ADMIN"];
const STATUSES = ["LEAD", "ENQUIRY", "BOOKING_IN_PROGRESS", "BOOKED", "STAY_IN_PROGRESS", "MOVED_IN", "STAY_COMPLETED", "CANCELLED"];
const SELF_SERVICE_FIELDS = []; // see header comment

module.exports = withErrorHandling(async (req, res) => {
    if (req.method !== "PATCH") {
        res.status(405).json({ error: "Method not allowed" });
        return;
    }
    const id = requireObjectId(req.query.id, "id");
    await checkBusinessWriteRateLimit(req);
    await connectToDatabase();

    const body = parseJsonBody(req);
    const requestedFields = Object.keys(body);

    let actorMongoUser;
    const isInternal = () => INTERNAL_ROLES.includes(actorMongoUser.role);

    // Try internal-role auth first without failing the request — a USER
    // legitimately hitting their own id is not an authorization failure,
    // it's a different (much more restricted) permission path.
    const identity = await requireCustomerIdentity(req, res);
    if (!identity) return; // 401 already sent
    actorMongoUser = identity.mongoUser;

    const isOwnRecord = String(actorMongoUser._id) === String(id);

    if (!isInternal()) {
        if (!isOwnRecord) {
            throw forbidden("You can only update your own accommodation lifecycle.");
        }
        const disallowed = requestedFields.filter((f) => !SELF_SERVICE_FIELDS.includes(f));
        if (disallowed.length) {
            throw forbidden(
                SELF_SERVICE_FIELDS.length
                    ? `These fields are business-managed and cannot be self-updated: ${disallowed.join(", ")}.`
                    : "Accommodation lifecycle fields are business-managed and cannot be self-updated."
            );
        }
    }

    const user = await User.findById(id);
    if (!user) throw notFound("Customer not found.");

    const aj = user.accommodationJourney;
    const previousStatus = aj.status;

    if (body.status !== undefined) aj.status = parseEnumParam(body.status, STATUSES, "status") || aj.status;
    if (body.servicePurchased !== undefined) {
        if (typeof body.servicePurchased !== "boolean") throw badRequest("VALIDATION_ERROR", "servicePurchased must be a boolean.");
        aj.servicePurchased = body.servicePurchased;
    }
    if (body.purchasedAt !== undefined) aj.purchasedAt = body.purchasedAt === null ? null : parseDate(body.purchasedAt, "purchasedAt");
    if (body.moveInDate !== undefined) aj.moveInDate = body.moveInDate === null ? null : parseDate(body.moveInDate, "moveInDate");
    if (body.expectedStayDurationMonths !== undefined) {
        const months = body.expectedStayDurationMonths === null ? null : parseNumberParam(body.expectedStayDurationMonths, "expectedStayDurationMonths");
        if (months !== null && months < 0) throw badRequest("VALIDATION_ERROR", "expectedStayDurationMonths cannot be negative.");
        aj.expectedStayDurationMonths = months;
    }
    if (body.expectedMoveOutDate !== undefined) aj.expectedMoveOutDate = body.expectedMoveOutDate === null ? null : parseDate(body.expectedMoveOutDate, "expectedMoveOutDate");
    if (body.actualMoveInDate !== undefined) aj.actualMoveInDate = body.actualMoveInDate === null ? null : parseDate(body.actualMoveInDate, "actualMoveInDate");
    if (body.actualMoveOutDate !== undefined) aj.actualMoveOutDate = body.actualMoveOutDate === null ? null : parseDate(body.actualMoveOutDate, "actualMoveOutDate");

    // Practical date-relationship checks only — not exhaustive.
    if (aj.moveInDate && aj.expectedMoveOutDate && aj.expectedMoveOutDate < aj.moveInDate) {
        throw badRequest("INVALID_DATE_RANGE", "expectedMoveOutDate cannot be before moveInDate.");
    }
    if (aj.actualMoveInDate && aj.actualMoveOutDate && aj.actualMoveOutDate < aj.actualMoveInDate) {
        throw badRequest("INVALID_DATE_RANGE", "actualMoveOutDate cannot be before actualMoveInDate.");
    }

    await user.save();

    if (body.status !== undefined && aj.status !== previousStatus) {
        await recordEvent({
            userId: user._id,
            event: "ACCOMMODATION_JOURNEY_STATUS_CHANGED",
            properties: { from: previousStatus, to: aj.status },
            metadata: { changedBy: String(actorMongoUser._id), changedByRole: actorMongoUser.role },
        });
    }

    sendSuccess(res, toSafeCustomer(user));
});
