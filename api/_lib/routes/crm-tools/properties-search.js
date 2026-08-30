// GET /api/properties/search — Find Rooms search orchestration.
// Internal CRM functionality only (an agent searching on a lead's behalf),
// gated the same way api/leads/* already is — never public.
//
// Minimum valid search is university + budget (min and/or max) + sharing,
// per the business objective (a lead does not need a completed call before
// this is usable). University coordinates, if supplied, are search input
// ONLY — never trusted for authorization or identity (see parseCriteria).
//
// AMBER IS NEVER USED HERE — this endpoint only ever calls the four
// adapters in ./_lib/providers/accommodation/registry.js, all of which are
// NOT_CONFIGURED today (see that directory's README.md for why).
const { requireRole } = require("../../businessAuth");
const { withCors } = require("../../cors");
const { withErrorHandling, badRequest, parseNumberParam } = require("../../validation");
const { sendSuccess } = require("../../apiResponse");
const { searchProviders } = require("../../providers/accommodation/search");

// Same internal-role set api/leads/* already uses (kept in sync by
// convention across this repo — see api/leads/index.js's own comment on
// this exact duplication).
const INTERNAL_ROLES = ["MARKETING_AGENT", "MARKETING_MANAGER", "ADMIN"];

function parseCriteria(query) {
    query = query || {};

    const universityName = typeof query.universityName === "string" ? query.universityName.trim() : "";
    if (!universityName) {
        throw badRequest("VALIDATION_ERROR", "university is required (pass universityName, and ideally universityId/universityCity/universityCountry from the resolved university).");
    }

    const budgetMin = parseNumberParam(query.budgetMin, "budgetMin");
    const budgetMax = parseNumberParam(query.budgetMax, "budgetMax");
    if (budgetMin === undefined && budgetMax === undefined) {
        throw badRequest("VALIDATION_ERROR", "At least one of budgetMin or budgetMax is required.");
    }
    if (budgetMin !== undefined && budgetMin <= 0) throw badRequest("VALIDATION_ERROR", "budgetMin must be a positive number.");
    if (budgetMax !== undefined && budgetMax <= 0) throw badRequest("VALIDATION_ERROR", "budgetMax must be a positive number.");
    if (budgetMin !== undefined && budgetMax !== undefined && budgetMin > budgetMax) {
        throw badRequest("VALIDATION_ERROR", "budgetMin cannot be greater than budgetMax.");
    }

    const sharing = parseNumberParam(query.sharing, "sharing");
    if (sharing === undefined || sharing <= 0) {
        throw badRequest("VALIDATION_ERROR", "sharing is required and must be a positive number.");
    }

    // Both lat and lng must be present and finite, or neither is used —
    // never a half-fabricated coordinate pair.
    const lat = parseNumberParam(query.universityLatitude, "universityLatitude");
    const lng = parseNumberParam(query.universityLongitude, "universityLongitude");
    const universityCoordinates = lat !== undefined && lng !== undefined ? { latitude: lat, longitude: lng } : null;

    const stayDurationMonths = parseNumberParam(query.stayDurationMonths, "stayDurationMonths");
    const preferredDistance = parseNumberParam(query.preferredDistance, "preferredDistance");

    return {
        university: {
            id: typeof query.universityId === "string" && query.universityId ? query.universityId : null,
            name: universityName,
            city: typeof query.universityCity === "string" && query.universityCity ? query.universityCity : null,
            country: typeof query.universityCountry === "string" && query.universityCountry ? query.universityCountry : null,
        },
        universityCoordinates,
        budgetMin: budgetMin !== undefined ? budgetMin : null,
        budgetMax: budgetMax !== undefined ? budgetMax : null,
        currency: typeof query.currency === "string" && query.currency ? query.currency : null,
        sharing,
        roomType: typeof query.roomType === "string" && query.roomType ? query.roomType : null,
        moveInDate: typeof query.moveInDate === "string" && query.moveInDate ? query.moveInDate : null,
        stayDurationMonths: stayDurationMonths !== undefined ? stayDurationMonths : null,
        preferredDistance: preferredDistance !== undefined ? preferredDistance : null,
        amenities:
            typeof query.amenities === "string" && query.amenities
                ? query.amenities.split(",").map((a) => a.trim()).filter(Boolean)
                : [],
    };
}

const handler = withErrorHandling(async (req, res) => {
    if (withCors(req, res)) return; // preflight handled

    if (req.method !== "GET") {
        res.status(405).json({ error: "Method not allowed" });
        return;
    }

    const identity = await requireRole(req, res, INTERNAL_ROLES);
    if (!identity) return; // requireRole already sent 401/403

    const criteria = parseCriteria(req.query);
    const { properties, providerCoverage } = await searchProviders(criteria);

    sendSuccess(res, {
        properties,
        providerCoverage,
        searchMetadata: {
            searchedAt: new Date().toISOString(),
            university: criteria.university,
            criteria: {
                budgetMin: criteria.budgetMin,
                budgetMax: criteria.budgetMax,
                currency: criteria.currency,
                sharing: criteria.sharing,
                roomType: criteria.roomType,
                moveInDate: criteria.moveInDate,
                stayDurationMonths: criteria.stayDurationMonths,
                preferredDistance: criteria.preferredDistance,
                amenities: criteria.amenities,
            },
            // Deliberate wording — Milestone 23.2 Part 10: never claim "all
            // available properties" when providerCoverage may show
            // NOT_CONFIGURED/UNAVAILABLE providers.
            disclaimer: "Matching properties from connected sources. See providerCoverage for which sources were actually searched.",
        },
    });
});

// Exposed for direct unit testing of validation (scripts/verify-property-
// search.js) without needing a real requireRole/Mongo round-trip — pure
// function, no side effects. Attached to the exported handler function
// itself so every existing caller (Vercel, scripts/local-api-server.js)
// keeps using `require(...)` as a plain callable, unchanged.
handler.parseCriteria = parseCriteria;

module.exports = handler;
