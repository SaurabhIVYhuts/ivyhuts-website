// Accommodation Presentation -- normalization (Milestone 23.8, extended
// Milestone 23.18).
//
// Turns an already-saved AccommodationCuration snapshot (never live Find
// Rooms state, never CompetitiveAnalysis -- see api/_lib/models/Presentation.js's
// header comment) plus the owning Lead's CONFIRMED Discovery record (read-
// only; Milestone 23.18 -- personalization now comes from the actual
// Discovery record, not just curation.criteriaSnapshot, which is Find-
// Rooms-search-shaped and has no course/intake/preferredLocation-as-text/
// distancePreference-as-text/priorities/notes) plus the owning Lead's own
// contact name into the flat, presentation-ready model
// ./pptBuilderAccommodation.js's slide functions consume. Same split of
// responsibility as the pre-existing Student Plan pipeline (./pptNormalize.js
// decides WHAT/how text is cleaned and formatted, ./pptBuilderAccommodation.js
// decides layout) -- this is a SEPARATE module, not an extension of
// pptNormalize.js, because the two input shapes share no fields (residences
// there carry no provider/url/image/sharing/amenities/availability at all;
// see that file's own header comment) and mixing the two domains into one
// normalizer would make neither easy to reason about.
//
// The one rule every function below exists to enforce: a field that isn't
// genuinely present in the saved curation/confirmed Discovery renders as
// the literal string "Not available" -- never a fabricated/guessed value,
// never silently omitted in a way that could look like "this property has
// no rent" rather than "we don't know this property's rent".
//
// `discovery` is always optional here (a curation can in principle exist
// for a lead with no Discovery at all -- historically via criteriaSnapshot
// alone) -- every discovery-sourced field below falls back to
// curation.criteriaSnapshot's narrower equivalent, and finally to
// NOT_AVAILABLE, never invented. Discovery, when present, wins because it
// is the actual confirmed-requirements source of truth (see Discovery.js's
// own header comment) -- criteriaSnapshot is only a point-in-time COPY of
// whatever subset of Discovery mattered for a Find Rooms search at some
// earlier moment, and can be stale or narrower.
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

// Mirrors Discovery.js's own DISCOVERY_PRIORITY_FACTORS enum (imported by
// value, not by reference, to keep this normalizer independent -- see this
// file's header comment on why the two normalizers/domains stay separate).
const PRIORITY_LABELS = {
    budget: "Budget",
    distance: "Distance to campus",
    travel_convenience: "Travel convenience",
    amenities: "Amenities",
    location: "Location",
    property_quality: "Property quality",
    other: "Other",
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

// Milestone 23.18 -- the honest booking/provenance line for a property
// slide. This codebase's curated properties come from external provider
// sites (UHomes/UniAcco/University Living/Gradding Homes), never an
// IVYHUTS-hosted listing page, so the claim is deliberately "view the
// original listing", never "book directly through IVYHUTS" (which this
// architecture does not actually do -- see this module's own header
// comment and Milestone 23.18's own instruction not to claim a booking
// capability the platform doesn't have).
function formatListingLine(property) {
    if (property.url) return `View property listing → ${property.url}`;
    return `Listing link: ${NOT_AVAILABLE}`;
}

// Milestone 23.18 -- the property-slide footer's provenance identifiers.
// Uses this codebase's OWN identity fields (provider + providerPropertyId,
// falling back to the canonical propertyId) -- never a fabricated "Amber
// Property ID"/"Room ID" the reference deck's Amber-sourced example used;
// this pipeline has no per-room id concept at all (one CuratedProperty =
// one room/rate combination -- see AccommodationCuration.js's schema).
function formatPropertyProvenance(property) {
    const label = PROVIDER_LABELS[property.provider] || property.provider || "Provider";
    const id = property.providerPropertyId || property.propertyId || null;
    return id ? `${label} Property ID: ${id}` : `${label} Property ID: ${NOT_AVAILABLE}`;
}

function normalizeProperty(raw) {
    return {
        propertyId: raw.propertyId,
        name: cleanText(raw.name, MAX_SHORT_LEN) || NOT_AVAILABLE,
        provider: raw.provider,
        providerLabel: PROVIDER_LABELS[raw.provider] || raw.provider || NOT_AVAILABLE,
        providerPropertyId: raw.providerPropertyId || null,
        image: typeof raw.image === "string" && raw.image.trim() ? raw.image.trim() : null,
        roomType: cleanText(raw.roomType, MAX_SHORT_LEN) || NOT_AVAILABLE,
        sharing: typeof raw.sharing === "number" && Number.isFinite(raw.sharing) ? raw.sharing : null,
        sharingLabel: formatSharing(raw.sharing),
        rentLabel: formatRent(raw),
        rentAmount: typeof raw.rent === "number" && Number.isFinite(raw.rent) ? raw.rent : null,
        rentPerWeek: typeof raw.rentPerWeek === "number" && Number.isFinite(raw.rentPerWeek) ? raw.rentPerWeek : null,
        // Milestone 23.20 -- the raw period enum (week/month/night/unknown),
        // kept alongside rentLabel/rentAmount so buildCostSummary can group
        // by currency AND period together -- a currency-only grouping would
        // silently merge e.g. "250/week" with "900/month" into one range,
        // which is not a real comparable figure (see that function's own
        // header comment).
        rentPeriod: RENT_PERIOD_LABELS[raw.rentPeriod] ? raw.rentPeriod : "unknown",
        currency: typeof raw.currency === "string" && raw.currency.trim() ? raw.currency.trim() : null,
        distanceKm: typeof raw.distanceFromUniversityKm === "number" && Number.isFinite(raw.distanceFromUniversityKm) ? raw.distanceFromUniversityKm : null,
        distanceLabel: formatDistance(raw.distanceFromUniversityKm),
        availabilityLabel: AVAILABILITY_LABELS[raw.availability] || NOT_AVAILABLE,
        // City/country are the only location fields this data model
        // actually carries -- no street address exists anywhere in
        // AccommodationCuration.js's schema, so a full postal address (as
        // the reference deck showed) is never fabricated here.
        locationLabel: cleanText([raw.city, raw.country].filter(Boolean).join(", "), MAX_SHORT_LEN) || NOT_AVAILABLE,
        amenities: Array.isArray(raw.amenities) ? raw.amenities.map((a) => cleanText(a, 40)).filter(Boolean).slice(0, 8) : [],
        url: typeof raw.url === "string" && raw.url.trim() ? raw.url.trim() : null,
        advantages: cleanText(raw.advantages),
        disadvantages: cleanText(raw.disadvantages),
    };
}

// Milestone 23.18 -- objective, evidence-based match reasons for the
// recommendation/ranked-options slide. Every entry here must be
// mechanically verifiable from real, already-normalized data on BOTH
// sides (the property AND the confirmed requirement) -- never a marketing
// adjective, never inferred. Returns [] (not a fabricated "great option!")
// when nothing about this property is actually verifiable against what was
// confirmed.
function buildMatchEvidence(property, requirements) {
    const evidence = [];
    if (!requirements.available) return evidence;

    // Budget: property.rentPerWeek is this pipeline's own already-
    // normalized weekly figure (see AccommodationCuration.js), matching
    // the convention budgetMin/budgetMax are captured in (see CRM's
    // src/lib/findRooms/format.ts formatting them as "/week"). Only
    // compared when currencies match -- a cross-currency "within budget"
    // claim would not be honest.
    if (
        property.rentPerWeek != null &&
        property.currency &&
        requirements.budgetMinRaw != null &&
        requirements.budgetMaxRaw != null &&
        requirements.currencyRaw &&
        property.currency === requirements.currencyRaw &&
        property.rentPerWeek >= requirements.budgetMinRaw &&
        property.rentPerWeek <= requirements.budgetMaxRaw
    ) {
        evidence.push(`Within your ${requirements.budgetLabel}/week budget`);
    }

    if (property.sharing != null && requirements.sharingRaw != null && property.sharing === requirements.sharingRaw) {
        evidence.push(`Matches your ${formatSharing(requirements.sharingRaw).toLowerCase()} preference`);
    }

    if (property.distanceKm != null && requirements.distancePreferenceKm != null && property.distanceKm <= requirements.distancePreferenceKm) {
        evidence.push(`Within your preferred ${requirements.distancePreferenceKm} km of campus`);
    }

    if (property.availabilityLabel === "Available") {
        evidence.push("Confirmed available at last check");
    }

    return evidence;
}

// `discovery` -- the plain object shape returned by
// api/_lib/models/Discovery.js's toObject() (or null when the lead has no
// Discovery record). `criteriaSnapshot` -- AccommodationCuration's own
// saved snapshot (Find-Rooms-search-shaped, narrower). Discovery wins
// wherever both could answer the same question.
function normalizeUniversity(discovery, criteriaSnapshot) {
    const discoveryName = discovery && discovery.student && cleanText(discovery.student.university, MAX_SHORT_LEN);
    if (discoveryName) {
        const resolved = discovery.student.universityResolved;
        const location = resolved ? cleanText([resolved.city, resolved.country].filter(Boolean).join(", "), MAX_SHORT_LEN) : null;
        return { available: true, name: discoveryName, location };
    }
    const uni = criteriaSnapshot && criteriaSnapshot.university;
    if (uni && uni.name) {
        return { available: true, name: cleanText(uni.name, MAX_SHORT_LEN), location: cleanText([uni.city, uni.country].filter(Boolean).join(", "), MAX_SHORT_LEN) };
    }
    return { available: false };
}

function normalizeRequirements(discovery, criteriaSnapshot) {
    const acc = discovery && discovery.accommodation;
    const student = discovery && discovery.student;
    if (!acc && !criteriaSnapshot) return { available: false };

    const budgetMinRaw = (acc && acc.budgetMin) ?? (criteriaSnapshot && criteriaSnapshot.budgetMin) ?? null;
    const budgetMaxRaw = (acc && acc.budgetMax) ?? (criteriaSnapshot && criteriaSnapshot.budgetMax) ?? null;
    const currencyRaw = (acc && acc.currency) ?? (criteriaSnapshot && criteriaSnapshot.currency) ?? null;
    const budgetParts = [];
    if (typeof budgetMinRaw === "number") budgetParts.push(formatMoney(budgetMinRaw, currencyRaw));
    if (typeof budgetMaxRaw === "number") budgetParts.push(formatMoney(budgetMaxRaw, currencyRaw));
    const budgetLabel = budgetParts.length === 2 ? `${budgetParts[0]} – ${budgetParts[1]}` : budgetParts[0] || NOT_AVAILABLE;

    const sharingRaw = (acc && acc.sharing) ?? (criteriaSnapshot && criteriaSnapshot.sharing) ?? null;
    const moveInDateRaw = (acc && acc.moveInDate) ?? (criteriaSnapshot && criteriaSnapshot.moveInDate) ?? null;
    const stayDurationRaw = (acc && acc.stayDurationMonths) ?? (criteriaSnapshot && criteriaSnapshot.stayDurationMonths) ?? null;

    // distancePreference: Discovery captures free text; criteriaSnapshot
    // (a Find Rooms search FILTER) captures a plain km number instead --
    // different shapes for the same underlying idea. Discovery's text wins
    // when present; otherwise the numeric filter is formatted honestly.
    // distancePreferenceKm is kept numeric-only (never parsed out of free
    // text) for buildMatchEvidence's own objective comparison above.
    const distancePreferenceKm = typeof (criteriaSnapshot && criteriaSnapshot.preferredDistance) === "number" ? criteriaSnapshot.preferredDistance : null;
    const distancePreferenceLabel = (acc && cleanText(acc.distancePreference, 80)) || (distancePreferenceKm != null ? `Within ${distancePreferenceKm} km of campus` : NOT_AVAILABLE);

    const roomPreferenceLabel = (acc && cleanText(acc.roomPreference, MAX_SHORT_LEN)) || (criteriaSnapshot && cleanText(criteriaSnapshot.roomType, MAX_SHORT_LEN)) || NOT_AVAILABLE;
    const preferredLocationLabel = (acc && cleanText(acc.preferredLocation, MAX_SHORT_LEN)) || NOT_AVAILABLE;
    const courseLabel = (student && cleanText(student.course, MAX_SHORT_LEN)) || NOT_AVAILABLE;
    const intakeLabel = (student && cleanText(student.intake, 60)) || NOT_AVAILABLE;

    const priorities = discovery && Array.isArray(discovery.priorities)
        ? discovery.priorities.map((p) => PRIORITY_LABELS[p]).filter(Boolean)
        : [];
    const notesLabel = (discovery && cleanText(discovery.notes)) || null;

    return {
        available: true,
        budgetLabel,
        // Raw values kept alongside the display labels ONLY for
        // buildMatchEvidence's own objective comparisons above -- never
        // rendered directly (the *Label fields are what every slide shows).
        budgetMinRaw, budgetMaxRaw, currencyRaw, sharingRaw, distancePreferenceKm,
        sharingLabel: formatSharing(sharingRaw),
        moveInDateLabel: cleanText(moveInDateRaw, 40) || NOT_AVAILABLE,
        stayDurationLabel: typeof stayDurationRaw === "number" && Number.isFinite(stayDurationRaw)
            ? `${stayDurationRaw} month${stayDurationRaw === 1 ? "" : "s"}`
            : NOT_AVAILABLE,
        distancePreferenceLabel,
        roomPreferenceLabel,
        preferredLocationLabel,
        courseLabel,
        intakeLabel,
        priorities,
        notesLabel,
        // Discovery has no "amenities" concept of its own (that's a Find
        // Rooms search filter, captured only on criteriaSnapshot) -- shown
        // as "requested filters", not a confirmed Discovery requirement.
        amenities: Array.isArray(criteriaSnapshot && criteriaSnapshot.amenities) ? criteriaSnapshot.amenities.map((a) => cleanText(a, 40)).filter(Boolean).slice(0, 10) : [],
    };
}

// No unsafe currency conversion (Milestone 23.8 Part 16): properties are
// grouped by their OWN stated currency, each group summarized with its own
// min/max range. Properties with no known rent/currency are counted but
// never folded into a numeric range.
// Milestone 23.20 fix -- groups by (currency, rentPeriod) TOGETHER, never
// currency alone. The pre-23.20 version grouped by currency only, so
// "EUR 250/week" and "EUR 900/month" collapsed into one misleading
// "EUR 250 - EUR 900" range -- two prices that are not actually comparable
// figures. A property whose rent period isn't known at all (raw.rentPeriod
// wasn't one of week/month/night) can't be honestly placed in any period-
// labeled group, so it's counted in unknownCount instead of guessed into
// one -- same treatment as a genuinely missing amount/currency. No
// week<->month conversion is ever performed; this codebase has no
// authoritative conversion rule, and inventing one would be exactly the
// kind of fabricated figure this pipeline exists to avoid.
function buildCostSummary(properties) {
    const byGroup = new Map();
    let unknownCount = 0;
    properties.forEach((p) => {
        const periodLabel = RENT_PERIOD_LABELS[p.rentPeriod] || null;
        if (p.rentAmount === null || !p.currency || !periodLabel) {
            unknownCount += 1;
            return;
        }
        const key = `${p.currency}|${p.rentPeriod}`;
        const group = byGroup.get(key) || { currency: p.currency, rentPeriod: p.rentPeriod, periodLabel, amounts: [] };
        group.amounts.push(p.rentAmount);
        byGroup.set(key, group);
    });
    const groups = Array.from(byGroup.values())
        .map(({ currency, rentPeriod, periodLabel, amounts }) => {
            const min = Math.min(...amounts);
            const max = Math.max(...amounts);
            return {
                currency,
                rentPeriod,
                periodLabel,
                rangeLabel: min === max ? formatMoney(min, currency) : `${formatMoney(min, currency)} – ${formatMoney(max, currency)}`,
                count: amounts.length,
            };
        })
        .sort((a, b) => a.currency.localeCompare(b.currency) || a.rentPeriod.localeCompare(b.rentPeriod));
    return { groups, unknownCount };
}

// `curation` is the plain object shape returned by
// api/leads/[id]/accommodation-curation.js's toSafeCuration (or an
// equivalent already-loaded Mongoose doc converted via .toObject()).
// `studentName` comes from the owning Lead's own contact.name -- never
// invented when absent. `discovery` (Milestone 23.18) -- the owning Lead's
// confirmed Discovery record (plain object or null), read-only, never
// mutated here or anywhere downstream.
function normalizeAccommodationCurationForPresentation(curation, { studentName, title, discovery = null } = {}) {
    const properties = (curation.properties || []).slice(0, MAX_PROPERTIES).map(normalizeProperty);
    const recommendedProperty = curation.recommendedPropertyId
        ? properties.find((p) => p.propertyId === curation.recommendedPropertyId) || null
        : null;
    const requirements = normalizeRequirements(discovery, curation.criteriaSnapshot);

    // Milestone 23.18 -- "other options" for the ranked recommendation
    // slide: every curated property that ISN'T the top recommendation,
    // each with its own objective match evidence (see buildMatchEvidence).
    // Order follows the saved curation's own order (Milestone 23.18 Part
    // 17 -- never re-ranked, never alphabetized).
    const otherProperties = properties
        .filter((p) => !recommendedProperty || p.propertyId !== recommendedProperty.propertyId)
        .map((p) => ({ property: p, evidence: buildMatchEvidence(p, requirements) }));

    return {
        title: cleanText(title, MAX_SHORT_LEN) || "Accommodation Options",
        student: { name: cleanText(studentName, MAX_SHORT_LEN) },
        university: normalizeUniversity(discovery, curation.criteriaSnapshot),
        requirements,
        properties,
        recommendation: recommendedProperty
            ? { property: recommendedProperty, reason: cleanText(curation.recommendationReason), evidence: buildMatchEvidence(recommendedProperty, requirements) }
            : null,
        otherProperties,
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
    buildMatchEvidence,
    formatRent,
    formatDistance,
    formatSharing,
    formatListingLine,
    formatPropertyProvenance,
    PRIORITY_LABELS,
};
