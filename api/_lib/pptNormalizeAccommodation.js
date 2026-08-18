// Accommodation Presentation -- normalization (Milestone 23.8).
//
// Turns an already-saved AccommodationCuration snapshot (never live Find
// Rooms state, never CompetitiveAnalysis -- see api/_lib/models/Presentation.js's
// header comment) plus the owning Lead's own contact name into the flat,
// presentation-ready model ./pptBuilderAccommodation.js's slide functions
// consume. Same split of responsibility as the pre-existing Student Plan
// pipeline (./pptNormalize.js decides WHAT/how text is cleaned and
// formatted, ./pptBuilderAccommodation.js decides layout) -- this is a
// SEPARATE module, not an extension of pptNormalize.js, because the two
// input shapes share no fields (residences there carry no provider/url/
// image/sharing/amenities/availability at all; see that file's own header
// comment) and mixing the two domains into one normalizer would make
// neither easy to reason about.
//
// The one rule every function below exists to enforce: a field that isn't
// genuinely present in the saved curation renders as the literal string
// "Not available" -- never a fabricated/guessed value, never silently
// omitted in a way that could look like "this property has no rent" rather
// than "we don't know this property's rent".
"use strict";

const NOT_AVAILABLE = "Not available";

const PROVIDER_LABELS = {
    uhomes: "U-Homes",
    uniacco: "UniAcco",
    university_living: "University Living",
    gradding_homes: "Gradding Homes",
};

const AVAILABILITY_LABELS = {
    available: "Available",
    unavailable: "Unavailable",
    unknown: NOT_AVAILABLE,
};

const RENT_PERIOD_LABELS = {
    week: "week",
    month: "month",
    night: "night",
    unknown: null,
};

const MAX_TEXT_LEN = 600;
const MAX_SHORT_LEN = 120;
const MAX_PROPERTIES = 12; // generous ceiling -- a real curated shortlist is a handful of properties, never dozens

// Strips control characters and caps length -- the same defensive shape as
// ./pptNormalize.js's own cleanText, kept as a small local copy rather than
// a cross-import since the two normalizers are intentionally independent
// (see this file's header comment).
function cleanText(value, maxLen = MAX_TEXT_LEN) {
    if (typeof value !== "string") return null;
    // eslint-disable-next-line no-control-regex
    const stripped = value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "").trim();
    if (!stripped) return null;
    if (stripped.length <= maxLen) return stripped;
    return `${stripped.slice(0, maxLen - 1).trimEnd()}…`;
}

function formatMoney(amount, currency) {
    if (typeof amount !== "number" || !Number.isFinite(amount)) return null;
    const prefix = typeof currency === "string" && currency.trim() ? `${currency.trim()} ` : "";
    return `${prefix}${amount.toLocaleString()}`;
}

function formatRent(property) {
    const amount = formatMoney(property.rent, property.currency);
    if (!amount) return NOT_AVAILABLE;
    const period = RENT_PERIOD_LABELS[property.rentPeriod] || null;
    return period ? `${amount} / ${period}` : amount;
}

function formatDistance(km) {
    if (typeof km !== "number" || !Number.isFinite(km)) return NOT_AVAILABLE;
    return `${km.toFixed(1)} km`;
}

function formatSharing(sharing) {
    if (typeof sharing !== "number" || !Number.isFinite(sharing) || sharing <= 0) return NOT_AVAILABLE;
    return sharing === 1 ? "Single occupancy" : `${sharing} sharing`;
}

function normalizeProperty(raw) {
    return {
        propertyId: raw.propertyId,
        name: cleanText(raw.name, MAX_SHORT_LEN) || NOT_AVAILABLE,
        provider: raw.provider,
        providerLabel: PROVIDER_LABELS[raw.provider] || raw.provider || NOT_AVAILABLE,
        image: typeof raw.image === "string" && raw.image.trim() ? raw.image.trim() : null,
        roomType: cleanText(raw.roomType, MAX_SHORT_LEN) || NOT_AVAILABLE,
        sharingLabel: formatSharing(raw.sharing),
        rentLabel: formatRent(raw),
        rentAmount: typeof raw.rent === "number" && Number.isFinite(raw.rent) ? raw.rent : null,
        currency: typeof raw.currency === "string" && raw.currency.trim() ? raw.currency.trim() : null,
        distanceLabel: formatDistance(raw.distanceFromUniversityKm),
        availabilityLabel: AVAILABILITY_LABELS[raw.availability] || NOT_AVAILABLE,
        amenities: Array.isArray(raw.amenities) ? raw.amenities.map((a) => cleanText(a, 40)).filter(Boolean).slice(0, 8) : [],
        url: typeof raw.url === "string" && raw.url.trim() ? raw.url.trim() : null,
        advantages: cleanText(raw.advantages),
        disadvantages: cleanText(raw.disadvantages),
    };
}

function normalizeRequirements(snapshot) {
    if (!snapshot) {
        return { available: false };
    }
    const budgetParts = [];
    if (typeof snapshot.budgetMin === "number" && Number.isFinite(snapshot.budgetMin)) budgetParts.push(formatMoney(snapshot.budgetMin, snapshot.currency));
    if (typeof snapshot.budgetMax === "number" && Number.isFinite(snapshot.budgetMax)) budgetParts.push(formatMoney(snapshot.budgetMax, snapshot.currency));
    const budgetLabel = budgetParts.length === 2 ? `${budgetParts[0]} – ${budgetParts[1]}` : budgetParts[0] || NOT_AVAILABLE;

    return {
        available: true,
        budgetLabel,
        sharingLabel: formatSharing(snapshot.sharing),
        moveInDateLabel: cleanText(snapshot.moveInDate, 40) || NOT_AVAILABLE,
        stayDurationLabel: typeof snapshot.stayDurationMonths === "number" && Number.isFinite(snapshot.stayDurationMonths)
            ? `${snapshot.stayDurationMonths} month${snapshot.stayDurationMonths === 1 ? "" : "s"}`
            : NOT_AVAILABLE,
        distancePreferenceLabel: typeof snapshot.preferredDistance === "number" && Number.isFinite(snapshot.preferredDistance)
            ? `Within ${snapshot.preferredDistance} km of campus`
            : NOT_AVAILABLE,
        amenities: Array.isArray(snapshot.amenities) ? snapshot.amenities.map((a) => cleanText(a, 40)).filter(Boolean).slice(0, 10) : [],
    };
}

function normalizeUniversity(snapshot) {
    const uni = snapshot && snapshot.university;
    if (!uni || !uni.name) return { available: false };
    return {
        available: true,
        name: cleanText(uni.name, MAX_SHORT_LEN),
        location: cleanText([uni.city, uni.country].filter(Boolean).join(", "), MAX_SHORT_LEN),
    };
}

// No unsafe currency conversion (Milestone 23.8 Part 16): properties are
// grouped by their OWN stated currency, each group summarized with its own
// min/max range. Properties with no known rent/currency are counted but
// never folded into a numeric range.
function buildCostSummary(properties) {
    const byCurrency = new Map();
    let unknownCount = 0;
    properties.forEach((p) => {
        if (p.rentAmount === null || !p.currency) {
            unknownCount += 1;
            return;
        }
        const list = byCurrency.get(p.currency) || [];
        list.push(p.rentAmount);
        byCurrency.set(p.currency, list);
    });
    const groups = Array.from(byCurrency.entries()).map(([currency, amounts]) => {
        const min = Math.min(...amounts);
        const max = Math.max(...amounts);
        return {
            currency,
            rangeLabel: min === max ? formatMoney(min, currency) : `${formatMoney(min, currency)} – ${formatMoney(max, currency)}`,
            count: amounts.length,
        };
    });
    return { groups, unknownCount };
}

// `curation` is the plain object shape returned by
// api/leads/[id]/accommodation-curation.js's toSafeCuration (or an
// equivalent already-loaded Mongoose doc converted via .toObject()).
// `studentName` comes from the owning Lead's own contact.name -- never
// invented when absent.
function normalizeAccommodationCurationForPresentation(curation, { studentName, title } = {}) {
    const properties = (curation.properties || []).slice(0, MAX_PROPERTIES).map(normalizeProperty);
    const recommendedProperty = curation.recommendedPropertyId
        ? properties.find((p) => p.propertyId === curation.recommendedPropertyId) || null
        : null;

    return {
        title: cleanText(title, MAX_SHORT_LEN) || "Accommodation Options",
        student: { name: cleanText(studentName, MAX_SHORT_LEN) },
        university: normalizeUniversity(curation.criteriaSnapshot),
        requirements: normalizeRequirements(curation.criteriaSnapshot),
        properties,
        recommendation: recommendedProperty
            ? { property: recommendedProperty, reason: cleanText(curation.recommendationReason) }
            : null,
        costSummary: buildCostSummary(properties),
    };
}

module.exports = {
    NOT_AVAILABLE,
    normalizeAccommodationCurationForPresentation,
    // Exposed for unit testing (scripts/verify-presentations.js), same
    // precedent as pptNormalize.js exporting its own field-level helpers.
    normalizeProperty,
    normalizeRequirements,
    normalizeUniversity,
    buildCostSummary,
    formatRent,
    formatDistance,
    formatSharing,
};
