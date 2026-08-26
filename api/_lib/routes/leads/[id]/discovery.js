// GET/PUT /api/leads/:id/discovery — Milestone 23.7.
//
// PUT is a PARTIAL, dot-path upsert — matching the pre-existing CRM
// contract exactly (src/lib/api/discovery.ts's own comment: "a key omitted
// here is left untouched server-side; an explicit `null` clears it. Lets
// the agent save incrementally across calls."). This is deliberately
// DIFFERENT from AccommodationCuration's full-replace PUT (Milestone
// 23.6) — Discovery is captured incrementally across a sales conversation,
// a shortlist is curated and saved as one complete decision.
//
// Validation (budget/currency in particular) is checked against the
// EFFECTIVE merged state (existing document + this request's partial
// fields), not the partial body in isolation — otherwise a request that
// only sets `budgetMin` this call, with `currency` already saved from a
// previous call, would be wrongly rejected.
//
// Sharing (accommodation.sharing) is a plain, honestly-nullable numeric
// field here — this route NEVER derives it from roomPreference text. That
// legacy-record derivation lives entirely in the CRM's
// deriveFindRoomsRequirements() (src/lib/findRooms/requirements.ts), so
// there is exactly one place "guess sharing from free text" logic can
// ever exist, not a second copy here.
const { connectToDatabase } = require("../../../mongodb");
const { requireRole } = require("../../../businessAuth");
const { checkBusinessWriteRateLimit } = require("../../../businessRateLimit");
const { withCors } = require("../../../cors");
const Lead = require("../../../models/Lead");
const Discovery = require("../../../models/Discovery");
const { withErrorHandling, requireObjectId, notFound, badRequest, parseJsonBody } = require("../../../validation");
const { sendSuccess } = require("../../../apiResponse");

const INTERNAL_ROLES = ["MARKETING_AGENT", "MARKETING_MANAGER", "ADMIN"];
const MAX_PAYLOAD_BYTES = 20_000; // Discovery is a handful of short fields — comfortably generous, same "reject the unreasonable" convention as accommodation-curation.js.

function toSafeDiscovery(doc) {
    if (!doc) return null;
    return {
        id: String(doc._id),
        leadId: String(doc.leadId),
        student: {
            university: doc.student.university,
            universityResolved: doc.student.universityResolved
                ? {
                      id: doc.student.universityResolved.id,
                      name: doc.student.universityResolved.name,
                      city: doc.student.universityResolved.city,
                      country: doc.student.universityResolved.country,
                      latitude: doc.student.universityResolved.latitude,
                      longitude: doc.student.universityResolved.longitude,
                  }
                : null,
            course: doc.student.course,
            intake: doc.student.intake,
        },
        accommodation: {
            budgetMin: doc.accommodation.budgetMin,
            budgetMax: doc.accommodation.budgetMax,
            currency: doc.accommodation.currency,
            moveInDate: doc.accommodation.moveInDate,
            stayDurationMonths: doc.accommodation.stayDurationMonths,
            preferredLocation: doc.accommodation.preferredLocation,
            roomPreference: doc.accommodation.roomPreference,
            sharing: doc.accommodation.sharing,
            distancePreference: doc.accommodation.distancePreference,
        },
        priorities: doc.priorities,
        notes: doc.notes,
        requirementSources: {
            university: doc.requirementSources ? doc.requirementSources.university : null,
            budget: doc.requirementSources ? doc.requirementSources.budget : null,
            sharing: doc.requirementSources ? doc.requirementSources.sharing : null,
        },
        createdBy: doc.createdBy ? String(doc.createdBy) : null,
        updatedBy: doc.updatedBy ? String(doc.updatedBy) : null,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
    };
}

// Merges only the keys actually PRESENT in `incoming` onto `existing`
// (absent keys pass `existing`'s value through untouched; an explicit
// `null` in `incoming` clears that key) — and records each touched key as
// a `${prefix}.key` -> value entry in `setPaths`, for a dot-path Mongo
// $set that only ever touches fields this request actually mentioned.
function mergeAndCollectSetPaths(prefix, existing, incoming, allowedKeys, setPaths) {
    const effective = { ...existing };
    if (incoming && typeof incoming === "object") {
        for (const key of allowedKeys) {
            if (Object.prototype.hasOwnProperty.call(incoming, key)) {
                effective[key] = incoming[key];
                setPaths[`${prefix}.${key}`] = incoming[key];
            }
        }
    }
    return effective;
}

const STUDENT_KEYS = ["university", "universityResolved", "course", "intake"];
const ACCOMMODATION_KEYS = [
    "budgetMin",
    "budgetMax",
    "currency",
    "moveInDate",
    "stayDurationMonths",
    "preferredLocation",
    "roomPreference",
    "sharing",
    "distancePreference",
];
const REQUIREMENT_SOURCE_KEYS = ["university", "budget", "sharing"];

function validateUniversityResolved(value, label) {
    if (value === null || value === undefined) return;
    if (typeof value !== "object") throw badRequest("VALIDATION_ERROR", `${label} must be an object or null.`);
    if (typeof value.id !== "string" || !value.id.trim()) throw badRequest("VALIDATION_ERROR", `${label}.id is required.`);
    if (typeof value.name !== "string" || !value.name.trim()) throw badRequest("VALIDATION_ERROR", `${label}.name is required.`);
    for (const key of ["city", "country"]) {
        if (value[key] != null && typeof value[key] !== "string") throw badRequest("VALIDATION_ERROR", `${label}.${key} must be a string or null.`);
    }
    for (const key of ["latitude", "longitude"]) {
        if (value[key] != null && (typeof value[key] !== "number" || !Number.isFinite(value[key]))) {
            throw badRequest("VALIDATION_ERROR", `${label}.${key} must be a number or null.`);
        }
    }
}

// Validates the EFFECTIVE (merged) accommodation state — see this file's
// header comment for why merged, not just the incoming partial.
function validateEffectiveAccommodation(accommodation) {
    const { budgetMin, budgetMax, currency, sharing } = accommodation;

    if (budgetMin != null) {
        if (typeof budgetMin !== "number" || !Number.isFinite(budgetMin) || budgetMin < 0) {
            throw badRequest("VALIDATION_ERROR", "accommodation.budgetMin must be a non-negative number.");
        }
    }
    if (budgetMax != null) {
        if (typeof budgetMax !== "number" || !Number.isFinite(budgetMax) || budgetMax < 0) {
            throw badRequest("VALIDATION_ERROR", "accommodation.budgetMax must be a non-negative number.");
        }
    }
    if (budgetMin != null && budgetMax != null && budgetMin > budgetMax) {
        throw badRequest("VALIDATION_ERROR", "accommodation.budgetMin cannot be greater than accommodation.budgetMax.");
    }
    // Never silently assume a currency (e.g. GBP) — if any budget bound is
    // set, currency must be too (Milestone 23.7 Part 6).
    if ((budgetMin != null || budgetMax != null) && !currency) {
        throw badRequest("VALIDATION_ERROR", "accommodation.currency is required whenever budgetMin or budgetMax is set.");
    }
    if (currency != null && (typeof currency !== "string" || !currency.trim())) {
        throw badRequest("VALIDATION_ERROR", "accommodation.currency must be a non-empty string or null.");
    }

    if (sharing != null) {
        if (typeof sharing !== "number" || !Number.isInteger(sharing)) {
            throw badRequest("VALIDATION_ERROR", "accommodation.sharing must be a whole number.");
        }
        // >0 (never zero/negative — "0 people sharing" is meaningless) and a
        // generous but real upper bound (reject obvious garbage input
        // without over-restricting legitimate large shared houses).
        if (sharing <= 0 || sharing > 20) {
            throw badRequest("VALIDATION_ERROR", "accommodation.sharing must be a whole number between 1 and 20.");
        }
    }

    for (const key of ["moveInDate", "preferredLocation", "roomPreference", "distancePreference"]) {
        if (accommodation[key] != null && typeof accommodation[key] !== "string") {
            throw badRequest("VALIDATION_ERROR", `accommodation.${key} must be a string or null.`);
        }
    }
    if (accommodation.stayDurationMonths != null) {
        if (typeof accommodation.stayDurationMonths !== "number" || !Number.isFinite(accommodation.stayDurationMonths) || accommodation.stayDurationMonths < 0) {
            throw badRequest("VALIDATION_ERROR", "accommodation.stayDurationMonths must be a non-negative number.");
        }
    }
}

function validateEffectiveStudent(student) {
    for (const key of ["university", "course", "intake"]) {
        if (student[key] != null && typeof student[key] !== "string") {
            throw badRequest("VALIDATION_ERROR", `student.${key} must be a string or null.`);
        }
    }
    validateUniversityResolved(student.universityResolved, "student.universityResolved");
}

// Provenance is validated independently of the value it describes — a
// caller can set requirementSources.budget without touching
// accommodation.budgetMin/Max in the same call (e.g. an agent confirming
// "yes, what the transcript said is right" after already having entered
// the number earlier).
function validateRequirementSources(sources) {
    for (const key of REQUIREMENT_SOURCE_KEYS) {
        const value = sources[key];
        if (value != null && !Discovery.REQUIREMENT_SOURCES.includes(value)) {
            throw badRequest("VALIDATION_ERROR", `requirementSources.${key} must be one of: ${Discovery.REQUIREMENT_SOURCES.join(", ")}, or null.`);
        }
    }
}

async function handleGet(req, res, leadId) {
    const identity = await requireRole(req, res, INTERNAL_ROLES);
    if (!identity) return;

    await connectToDatabase();
    const lead = await Lead.findById(leadId);
    if (!lead) throw notFound("Lead not found.");

    const discovery = await Discovery.findOne({ leadId });
    sendSuccess(res, toSafeDiscovery(discovery));
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
        throw badRequest("PAYLOAD_TOO_LARGE", `Request body exceeds the ${MAX_PAYLOAD_BYTES}-byte limit for Discovery.`);
    }
    const body = parseJsonBody(req);

    const existing = await Discovery.findOne({ leadId });
    const existingStudent = existing ? existing.student.toObject() : { university: null, universityResolved: null, course: null, intake: null };
    const existingAccommodation = existing
        ? existing.accommodation.toObject()
        : { budgetMin: null, budgetMax: null, currency: null, moveInDate: null, stayDurationMonths: null, preferredLocation: null, roomPreference: null, sharing: null, distancePreference: null };

    const existingRequirementSources = existing && existing.requirementSources
        ? existing.requirementSources.toObject()
        : { university: null, budget: null, sharing: null };

    const setPaths = {};
    const effectiveStudent = mergeAndCollectSetPaths("student", existingStudent, body.student, STUDENT_KEYS, setPaths);
    const effectiveAccommodation = mergeAndCollectSetPaths("accommodation", existingAccommodation, body.accommodation, ACCOMMODATION_KEYS, setPaths);
    const effectiveRequirementSources = mergeAndCollectSetPaths("requirementSources", existingRequirementSources, body.requirementSources, REQUIREMENT_SOURCE_KEYS, setPaths);

    validateEffectiveStudent(effectiveStudent);
    validateEffectiveAccommodation(effectiveAccommodation);
    validateRequirementSources(effectiveRequirementSources);

    if (Object.prototype.hasOwnProperty.call(body, "priorities")) {
        if (!Array.isArray(body.priorities) || !body.priorities.every((p) => Discovery.DISCOVERY_PRIORITY_FACTORS.includes(p))) {
            throw badRequest("VALIDATION_ERROR", `priorities must be an array containing only: ${Discovery.DISCOVERY_PRIORITY_FACTORS.join(", ")}.`);
        }
        setPaths.priorities = body.priorities;
    }
    if (Object.prototype.hasOwnProperty.call(body, "notes")) {
        if (body.notes !== null && typeof body.notes !== "string") throw badRequest("VALIDATION_ERROR", "notes must be a string or null.");
        setPaths.notes = body.notes;
    }

    setPaths.updatedBy = identity.mongoUser._id;

    const discovery = await Discovery.findOneAndUpdate(
        { leadId },
        { $set: setPaths, $setOnInsert: { leadId, createdBy: identity.mongoUser._id } },
        { upsert: true, returnDocument: "after", setDefaultsOnInsert: true, runValidators: true }
    );

    sendSuccess(res, toSafeDiscovery(discovery));
}

const handler = withErrorHandling(async (req, res) => {
    if (withCors(req, res)) return; // preflight handled

    const leadId = requireObjectId(req.query.id, "id");

    if (req.method === "GET") return handleGet(req, res, leadId);
    if (req.method === "PUT") return handlePut(req, res, leadId);

    res.status(405).json({ error: "Method not allowed" });
});

// Exposed for direct unit testing of validation
// (scripts/verify-discovery.js) without needing a real requireRole/Mongo
// round-trip — pure functions, no side effects. Same pattern as
// api/properties/search.js and api/leads/[id]/accommodation-curation.js.
handler.validateEffectiveAccommodation = validateEffectiveAccommodation;
handler.validateEffectiveStudent = validateEffectiveStudent;
handler.validateRequirementSources = validateRequirementSources;
handler.mergeAndCollectSetPaths = mergeAndCollectSetPaths;
handler.MAX_PAYLOAD_BYTES = MAX_PAYLOAD_BYTES;

module.exports = handler;
