// GET/PUT /api/leads/:id/accommodation-curation — Milestone 23.6.
//
// One idempotent save endpoint (Part 13 of the milestone spec): the CRM
// always PUTs its full current curation state; repeated identical PUTs are
// safe (upsert-by-leadId, no separate create/update routes). GET returns
// `{data: null}` when nothing has been saved yet — same "null is a normal,
// expected response" convention as GET /api/leads/:id/discovery (see that
// route's own comment).
//
// Internal roles only, same set every other business-write endpoint in
// this repo uses. leadId always comes from the URL, never the body — see
// buildCuration() below, which whitelists every field it reads from the
// request and never trusts createdBy/updatedBy/leadId from the client.
const { connectToDatabase } = require("../../_lib/mongodb");
const { requireRole } = require("../../_lib/businessAuth");
const { checkBusinessWriteRateLimit } = require("../../_lib/businessRateLimit");
const { withCors } = require("../../_lib/cors");
const Lead = require("../../_lib/models/Lead");
const AccommodationCuration = require("../../_lib/models/AccommodationCuration");
const { withErrorHandling, requireObjectId, notFound, badRequest, parseJsonBody } = require("../../_lib/validation");
const { sendSuccess } = require("../../_lib/apiResponse");

const INTERNAL_ROLES = ["MARKETING_AGENT", "MARKETING_MANAGER", "ADMIN"];

// Same spirit as api/_lib/pptValidation.js's assertPayloadSize (a
// pre-existing convention in this repo for "reject an unreasonably large
// client payload") — applied locally here rather than importing a
// PPT-specific helper into an unrelated route. 100KB comfortably fits a
// few dozen curated properties; nothing legitimate should ever approach it.
const MAX_PAYLOAD_BYTES = 100_000;

function toSafeCuration(doc) {
    if (!doc) return null;
    return {
        id: String(doc._id),
        leadId: String(doc.leadId),
        criteriaSnapshot: doc.criteriaSnapshot
            ? {
                  university: doc.criteriaSnapshot.university,
                  budgetMin: doc.criteriaSnapshot.budgetMin,
                  budgetMax: doc.criteriaSnapshot.budgetMax,
                  currency: doc.criteriaSnapshot.currency,
                  sharing: doc.criteriaSnapshot.sharing,
                  roomType: doc.criteriaSnapshot.roomType,
                  moveInDate: doc.criteriaSnapshot.moveInDate,
                  stayDurationMonths: doc.criteriaSnapshot.stayDurationMonths,
                  preferredDistance: doc.criteriaSnapshot.preferredDistance,
                  amenities: doc.criteriaSnapshot.amenities,
              }
            : null,
        properties: doc.properties.map((p) => ({
            provider: p.provider,
            providerPropertyId: p.providerPropertyId,
            propertyId: p.propertyId,
            name: p.name,
            url: p.url,
            slug: p.slug,
            image: p.image,
            city: p.city,
            country: p.country,
            latitude: p.latitude,
            longitude: p.longitude,
            rent: p.rent,
            rentPerWeek: p.rentPerWeek,
            currency: p.currency,
            rentPeriod: p.rentPeriod,
            roomType: p.roomType,
            sharing: p.sharing,
            availability: p.availability,
            amenities: p.amenities,
            distanceFromUniversityKm: p.distanceFromUniversityKm,
            advantages: p.advantages,
            disadvantages: p.disadvantages,
            providerMeta: p.providerMeta,
        })),
        recommendedPropertyId: doc.recommendedPropertyId,
        recommendationReason: doc.recommendationReason,
        notes: doc.notes,
        createdBy: doc.createdBy ? String(doc.createdBy) : null,
        updatedBy: doc.updatedBy ? String(doc.updatedBy) : null,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
    };
}

function requireString(value, label) {
    if (typeof value !== "string" || !value.trim()) {
        throw badRequest("VALIDATION_ERROR", `${label} must be a non-empty string.`);
    }
    return value;
}

function optionalString(value, label) {
    if (value === undefined || value === null) return null;
    if (typeof value !== "string") throw badRequest("VALIDATION_ERROR", `${label} must be a string or null.`);
    return value;
}

function optionalNumber(value, label) {
    if (value === undefined || value === null) return null;
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw badRequest("VALIDATION_ERROR", `${label} must be a number or null.`);
    }
    return value;
}

function validateUniversitySnapshot(input) {
    if (!input || typeof input !== "object") {
        throw badRequest("VALIDATION_ERROR", "criteriaSnapshot.university is required.");
    }
    return {
        id: optionalString(input.id, "criteriaSnapshot.university.id"),
        name: requireString(input.name, "criteriaSnapshot.university.name"),
        city: optionalString(input.city, "criteriaSnapshot.university.city"),
        country: optionalString(input.country, "criteriaSnapshot.university.country"),
        latitude: optionalNumber(input.latitude, "criteriaSnapshot.university.latitude"),
        longitude: optionalNumber(input.longitude, "criteriaSnapshot.university.longitude"),
    };
}

function validateCriteriaSnapshot(input) {
    if (input === undefined || input === null) return null;
    if (typeof input !== "object") throw badRequest("VALIDATION_ERROR", "criteriaSnapshot must be an object or null.");
    const sharing = input.sharing;
    if (typeof sharing !== "number" || !Number.isFinite(sharing) || sharing <= 0) {
        throw badRequest("VALIDATION_ERROR", "criteriaSnapshot.sharing must be a positive number.");
    }
    return {
        university: validateUniversitySnapshot(input.university),
        budgetMin: optionalNumber(input.budgetMin, "criteriaSnapshot.budgetMin"),
        budgetMax: optionalNumber(input.budgetMax, "criteriaSnapshot.budgetMax"),
        currency: optionalString(input.currency, "criteriaSnapshot.currency"),
        sharing,
        roomType: optionalString(input.roomType, "criteriaSnapshot.roomType"),
        moveInDate: optionalString(input.moveInDate, "criteriaSnapshot.moveInDate"),
        stayDurationMonths: optionalNumber(input.stayDurationMonths, "criteriaSnapshot.stayDurationMonths"),
        preferredDistance: optionalNumber(input.preferredDistance, "criteriaSnapshot.preferredDistance"),
        amenities: Array.isArray(input.amenities) ? input.amenities.filter((a) => typeof a === "string") : [],
    };
}

function validateProperty(input, index) {
    if (!input || typeof input !== "object") {
        throw badRequest("VALIDATION_ERROR", `properties[${index}] must be an object.`);
    }
    if (!AccommodationCuration.PROVIDERS.includes(input.provider)) {
        throw badRequest("VALIDATION_ERROR", `properties[${index}].provider must be one of: ${AccommodationCuration.PROVIDERS.join(", ")}.`);
    }
    const propertyId = requireString(input.propertyId, `properties[${index}].propertyId`);
    const name = requireString(input.name, `properties[${index}].name`);

    return {
        provider: input.provider,
        providerPropertyId: optionalString(input.providerPropertyId, `properties[${index}].providerPropertyId`),
        propertyId,
        name,
        url: optionalString(input.url, `properties[${index}].url`),
        slug: optionalString(input.slug, `properties[${index}].slug`),
        image: optionalString(input.image, `properties[${index}].image`),
        city: optionalString(input.city, `properties[${index}].city`),
        country: optionalString(input.country, `properties[${index}].country`),
        latitude: optionalNumber(input.latitude, `properties[${index}].latitude`),
        longitude: optionalNumber(input.longitude, `properties[${index}].longitude`),
        rent: optionalNumber(input.rent, `properties[${index}].rent`),
        rentPerWeek: optionalNumber(input.rentPerWeek, `properties[${index}].rentPerWeek`),
        currency: optionalString(input.currency, `properties[${index}].currency`),
        rentPeriod: AccommodationCuration.RENT_PERIODS.includes(input.rentPeriod) ? input.rentPeriod : "unknown",
        roomType: optionalString(input.roomType, `properties[${index}].roomType`),
        sharing: optionalNumber(input.sharing, `properties[${index}].sharing`),
        availability: AccommodationCuration.AVAILABILITY_VALUES.includes(input.availability) ? input.availability : "unknown",
        amenities: Array.isArray(input.amenities) ? input.amenities.filter((a) => typeof a === "string") : [],
        distanceFromUniversityKm: optionalNumber(input.distanceFromUniversityKm, `properties[${index}].distanceFromUniversityKm`),
        advantages: optionalString(input.advantages, `properties[${index}].advantages`),
        disadvantages: optionalString(input.disadvantages, `properties[${index}].disadvantages`),
        providerMeta: input.providerMeta && typeof input.providerMeta === "object" ? input.providerMeta : null,
    };
}

// Whitelists every field this endpoint accepts — createdBy/updatedBy/leadId
// are never read from `body` even if present (Milestone 23.6 Part 11/25).
function buildCurationFields(body) {
    if (!Array.isArray(body.properties)) {
        throw badRequest("VALIDATION_ERROR", "properties is required and must be an array.");
    }
    const properties = body.properties.map(validateProperty);

    const propertyIds = new Set(properties.map((p) => p.propertyId));
    if (propertyIds.size !== properties.length) {
        throw badRequest("VALIDATION_ERROR", "properties must not contain duplicate propertyId values.");
    }

    let recommendedPropertyId = optionalString(body.recommendedPropertyId, "recommendedPropertyId");
    if (recommendedPropertyId && !propertyIds.has(recommendedPropertyId)) {
        throw badRequest("VALIDATION_ERROR", "recommendedPropertyId must match one of the selected properties.");
    }

    return {
        criteriaSnapshot: validateCriteriaSnapshot(body.criteriaSnapshot),
        properties,
        recommendedPropertyId,
        recommendationReason: optionalString(body.recommendationReason, "recommendationReason"),
        notes: optionalString(body.notes, "notes"),
    };
}

async function handleGet(req, res, leadId) {
    const identity = await requireRole(req, res, INTERNAL_ROLES);
    if (!identity) return;

    await connectToDatabase();
    const lead = await Lead.findById(leadId);
    if (!lead) throw notFound("Lead not found.");

    // .findOne (not .find) — leadId is unique, and this query is always
    // scoped to exactly the lead in the URL, never any other lead's data.
    const curation = await AccommodationCuration.findOne({ leadId });
    sendSuccess(res, toSafeCuration(curation));
}

async function handlePut(req, res, leadId) {
    const identity = await requireRole(req, res, INTERNAL_ROLES);
    if (!identity) return;

    await checkBusinessWriteRateLimit(req);
    await connectToDatabase();

    const lead = await Lead.findById(leadId);
    if (!lead) throw notFound("Lead not found.");

    const raw = req.body;
    const rawSize = Buffer.byteLength(typeof raw === "string" ? raw : JSON.stringify(raw || {}), "utf8");
    if (rawSize > MAX_PAYLOAD_BYTES) {
        throw badRequest("PAYLOAD_TOO_LARGE", `Request body exceeds the ${MAX_PAYLOAD_BYTES}-byte limit for a curated shortlist.`);
    }

    const body = parseJsonBody(req);
    const fields = buildCurationFields(body);

    // Idempotent upsert-by-leadId — repeated identical PUTs are safe and
    // produce the same stored document. createdBy is set ONLY on insert
    // (via $setOnInsert); updatedBy is set on every save, always from the
    // authenticated session, never from the request body.
    const curation = await AccommodationCuration.findOneAndUpdate(
        { leadId },
        {
            $set: {
                criteriaSnapshot: fields.criteriaSnapshot,
                properties: fields.properties,
                recommendedPropertyId: fields.recommendedPropertyId,
                recommendationReason: fields.recommendationReason,
                notes: fields.notes,
                updatedBy: identity.mongoUser._id,
            },
            $setOnInsert: {
                leadId,
                createdBy: identity.mongoUser._id,
            },
        },
        { upsert: true, returnDocument: "after", setDefaultsOnInsert: true, runValidators: true }
    );

    sendSuccess(res, toSafeCuration(curation));
}

const handler = withErrorHandling(async (req, res) => {
    if (withCors(req, res)) return; // preflight handled

    const leadId = requireObjectId(req.query.id, "id");

    if (req.method === "GET") return handleGet(req, res, leadId);
    if (req.method === "PUT") return handlePut(req, res, leadId);

    res.status(405).json({ error: "Method not allowed" });
});

// Exposed for direct unit testing of validation
// (scripts/verify-accommodation-curation.js) without needing a real
// requireRole/Mongo round-trip — pure functions, no side effects. Same
// pattern as api/properties/search.js's exported parseCriteria (Milestone
// 23.3).
handler.buildCurationFields = buildCurationFields;
handler.validateProperty = validateProperty;
handler.validateCriteriaSnapshot = validateCriteriaSnapshot;
handler.MAX_PAYLOAD_BYTES = MAX_PAYLOAD_BYTES;

module.exports = handler;
