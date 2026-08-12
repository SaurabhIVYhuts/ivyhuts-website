// Student Plan PPT (Milestone 9) -- presentation transformation layer.
//
// plannerResult (already validated as STRUCTURALLY sane by ./pptValidation.js)
// -> normalizePlannerForPresentation() -> a flat, slide-ready model
// api/_lib/pptBuilder.js consumes. This is the ONLY place that selects "top
// N", formats currency/text, and decides what counts as "available" for a
// given slide.
//
// Hard rule (plan item 20 -- no business-logic duplication): this file never
// re-ranks careers, never recomputes salary, never re-derives skill
// coverage. Every number/label it shows was already produced by
// api/_lib/careerResolver.js, api/_lib/salaryResolver.js or
// api/_lib/careerReadinessResolver.js earlier in the SAME planner response --
// this layer only ever selects, slices, and formats what's already there.
// If a value is missing/malformed, the correct behavior is to mark that
// section unavailable, never to invent or reconstruct it from elsewhere.
"use strict";

const MAX_SHORT_TEXT = 140; // names/titles/labels
const MAX_LONG_TEXT = 480; // summaries/descriptions
const MAX_RESIDENCES = 3; // plan item: Slide 3, "approximately the top 3"
const MAX_COMPARISON_ROWS = 5;
const MAX_CAREERS = 5;
const MAX_SKILL_CHIPS = 6;
const MAX_LIST_ITEMS = 5;

// Strips ASCII control characters (never let an embedded control char reach
// a slide's XML text run) using hex escapes only, so this source file never
// contains a literal raw control byte itself. Also caps length so a single
// oversized field can never blow out a slide's layout (plan item 26 --
// protect against "unexpected huge strings"). Truncates with an ellipsis
// rather than rejecting the whole request over one long field.
const CONTROL_CHAR_PATTERN = new RegExp("[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F\\x7F]", "g");

function cleanText(value, maxLen = MAX_LONG_TEXT) {
    if (typeof value !== "string") return "";
    const stripped = value.replace(CONTROL_CHAR_PATTERN, "").trim();
    if (stripped.length <= maxLen) return stripped;
    return `${stripped.slice(0, maxLen - 1).trimEnd()}...`;
}

// PowerPoint table/text cells are never formula-evaluated the way Excel/CSV
// cells are, so this isn't a real injection vector for .pptx -- but plan
// item 26 explicitly calls out "formula-like spreadsheet content" as
// something to defend against, so a leading =/+/-/@ is neutralized anyway
// as cheap defense-in-depth for any table content built from planner text.
function sanitizeTableCell(value, maxLen = MAX_SHORT_TEXT) {
    const cleaned = cleanText(value, maxLen);
    return /^[=+\-@]/.test(cleaned) ? ` ${cleaned}` : cleaned;
}

function cleanNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

// Every list on a slide is capped and every item is cleaned/dropped if it
// isn't a usable string -- one malformed entry in an otherwise-good array
// must never crash generation (plan item 27.3, "malformed career object
// rejected/handled").
function cleanStringList(list, maxItems = MAX_LIST_ITEMS, maxLen = MAX_SHORT_TEXT) {
    if (!Array.isArray(list)) return [];
    return list
        .map((item) => cleanText(item, maxLen))
        .filter(Boolean)
        .slice(0, maxItems);
}

function formatPrice(price) {
    if (!price || typeof price !== "object") return null;
    const amount = cleanNumber(price.amount);
    const currency = cleanText(price.currency, 6) || "";
    const duration = cleanText(price.duration, 20) || "";
    if (amount === null) return null;
    return `${currency}${amount}${duration ? `/${duration}` : ""}`;
}

function formatThousands(currency, amount) {
    const n = cleanNumber(amount);
    if (n === null) return null;
    return `${currency}${Math.round(n / 1000)}k`;
}

function formatSalaryRange(currency, range) {
    if (!range || typeof range !== "object") return null;
    const min = formatThousands(currency, range.min);
    const max = formatThousands(currency, range.max);
    if (min === null || max === null) return null;
    return `${min}-${max}`;
}

function normalizeStudent(student, university) {
    const s = student && typeof student === "object" ? student : {};
    return {
        // The Student Planner never collects the student's own name (only
        // university/degree/city/etc. -- see StudentPlannerPage.js's
        // `studentInput` state) -- never fabricated here either; the cover
        // slide simply omits a name line when absent (plan item 14).
        name: cleanText(s.name, MAX_SHORT_TEXT) || null,
        university: cleanText(s.university, MAX_SHORT_TEXT) || cleanText(university?.name, MAX_SHORT_TEXT) || null,
        degree: cleanText(s.degree, MAX_SHORT_TEXT) || null,
        specialization: cleanText(s.specialization, MAX_SHORT_TEXT) || null,
        city: cleanText(s.city, MAX_SHORT_TEXT) || null,
        country: cleanText(s.country, MAX_SHORT_TEXT) || null,
        currentYear: cleanText(s.currentYear, 40) || null,
        graduationYear: cleanText(s.graduationYear, 40) || null,
    };
}

function normalizeUniversity(university) {
    if (!university || typeof university !== "object") return { available: false };
    const name = cleanText(university.name, MAX_SHORT_TEXT);
    if (!name) return { available: false };
    return {
        available: true,
        name,
        city: cleanText(university.city, MAX_SHORT_TEXT) || null,
        country: cleanText(university.country, MAX_SHORT_TEXT) || null,
        summary: cleanText(university.summary, MAX_LONG_TEXT) || null,
        keyFacts: cleanStringList(university.keyFacts, 4, 160),
    };
}

function normalizeResidenceItem(residence) {
    if (!residence || typeof residence !== "object") return null;
    const name = cleanText(residence.name, MAX_SHORT_TEXT);
    if (!name) return null;
    return {
        name,
        price: formatPrice(residence.price),
        rating: cleanNumber(residence.rating?.overall),
        distanceKm: cleanNumber(residence.distanceKm),
        walkingMinutes: cleanNumber(residence.walkingMinutes),
        roomType: cleanText(residence.roomType, 60) || null,
        badge: cleanText(residence.badge, 40) || null,
        matchScore: cleanNumber(residence.matchScore),
    };
}

function normalizeResidences(residences, maxItems) {
    if (!Array.isArray(residences)) return [];
    // Order is preserved exactly as received -- this is the SAME ranking
    // accommodationIndex.js already produced; the PPT layer never re-sorts.
    return residences.map(normalizeResidenceItem).filter(Boolean).slice(0, maxItems);
}

function normalizeLivingExpenses(livingExpenses) {
    if (!livingExpenses || typeof livingExpenses !== "object") return { available: false };
    const currency = cleanText(livingExpenses.currency, 6) || "";
    const rows = [
        ["Accommodation", livingExpenses.accommodation],
        ["Food", livingExpenses.food],
        ["Transport", livingExpenses.transport],
        ["Utilities", livingExpenses.utilities],
        ["Personal", livingExpenses.personal],
        ["Other", livingExpenses.other],
    ]
        .map(([label, value]) => [label, cleanNumber(value)])
        .filter(([, value]) => value !== null)
        .map(([label, value]) => ({ label, value, formatted: `${currency}${value}` }));

    const totalMonthly = cleanNumber(livingExpenses.totalMonthly);
    const totalAnnual = cleanNumber(livingExpenses.totalAnnual);

    if (rows.length === 0 && totalMonthly === null) return { available: false };

    return {
        available: true,
        currency,
        rows,
        totalMonthly,
        totalAnnual,
        note: cleanText(livingExpenses.meta?.note, 200) || null,
    };
}

function normalizeDegree(degree) {
    if (!degree || typeof degree !== "object" || degree.status !== "ready") return { available: false };
    const name = cleanText(degree.name, MAX_SHORT_TEXT);
    if (!name) return { available: false };
    const specialization = degree.specialization && typeof degree.specialization === "object"
        ? {
            name: cleanText(degree.specialization.name, MAX_SHORT_TEXT),
            emphasisSkills: cleanStringList(degree.specialization.emphasisSkills, MAX_SKILL_CHIPS, 60),
        }
        : null;
    return {
        available: true,
        name,
        category: cleanText(degree.category, 80) || null,
        summary: cleanText(degree.summary, MAX_LONG_TEXT) || null,
        coreSkills: cleanStringList(degree.coreSkills, 8, 60),
        technicalAreas: cleanStringList(degree.technicalAreas, 5, 60),
        specialization: specialization && specialization.name ? specialization : null,
    };
}

function normalizeCareerItem(career) {
    if (!career || typeof career !== "object") return null;
    const title = cleanText(career.title, MAX_SHORT_TEXT);
    if (!title) return null;
    return {
        title,
        category: cleanText(career.category, 80) || null,
        matchLabel: cleanText(career.matchLabel, 40) || null,
        summary: cleanText(career.summary, MAX_LONG_TEXT) || null,
        requiredSkills: cleanStringList(career.requiredSkills, MAX_SKILL_CHIPS, 60),
        alreadyHaveSkills: cleanStringList(career.alreadyHaveSkills, MAX_SKILL_CHIPS, 60),
        skillsToDevelop: cleanStringList(career.skillsToDevelop, MAX_SKILL_CHIPS, 60),
    };
}

function normalizeCareers(careers, maxItems) {
    if (!Array.isArray(careers)) return [];
    // Order is preserved exactly as received -- this is Milestone 6's own
    // matchScore ranking; the PPT layer never re-sorts or re-scores.
    return careers.map(normalizeCareerItem).filter(Boolean).slice(0, maxItems);
}

const SALARY_LEVELS = [
    ["entryLevel", "Entry Level"],
    ["earlyCareer", "Early Career"],
    ["midCareer", "Mid Career"],
    ["experienced", "Experienced"],
];

function normalizeSalary(salary) {
    if (!salary || salary.available !== true || !salary.ranges) {
        return { available: false, note: cleanText(salary?.note, 200) || "Salary guidance isn't available for this career/location yet." };
    }
    const currency = cleanText(salary.currency, 6) || "";
    const stages = SALARY_LEVELS
        .map(([key, label]) => ({ label, value: formatSalaryRange(currency, salary.ranges[key]) }))
        .filter((stage) => stage.value !== null);
    if (stages.length === 0) {
        return { available: false, note: "Salary guidance isn't available for this career/location yet." };
    }
    return {
        available: true,
        country: cleanText(salary.country, MAX_SHORT_TEXT) || null,
        currency,
        stages,
        note: cleanText(salary.note, 240) || "Estimated planning range. Actual compensation varies by experience, employer, location and market conditions.",
    };
}

const INTERVIEW_CATEGORIES = [
    ["technical", "Technical"],
    ["practical", "Practical"],
    ["behavioral", "Behavioral"],
];

function normalizeReadiness(readiness) {
    if (!readiness || readiness.available !== true) {
        return { available: false, note: cleanText(readiness?.note, 200) || "Hiring guidance isn't available for this career yet." };
    }
    const interviewAreas = INTERVIEW_CATEGORIES
        .map(([key, label]) => ({ label, items: cleanStringList(readiness.interviewAreas?.[key], 4, 60) }))
        .filter((group) => group.items.length > 0);

    return {
        available: true,
        alreadyCoveredSkills: cleanStringList(readiness.alreadyCoveredSkills, MAX_SKILL_CHIPS, 60),
        skillsToDevelop: cleanStringList(readiness.skillsToDevelop, MAX_SKILL_CHIPS, 60),
        portfolioExpectations: cleanStringList(readiness.portfolioExpectations, 4, 120),
        projectEvidence: cleanStringList(readiness.projectEvidence, 4, 120),
        interviewAreas,
        entryRoutes: cleanStringList(readiness.entryRoutes, 5, 100),
        // Order preserved exactly -- this is the curated dataset's own
        // authored sequence (api/_lib/careerReadiness.json), never re-sorted.
        preparationSteps: cleanStringList(readiness.preparationSteps, 6, 140),
    };
}

// Mirrors StudentPlannerPage.js's own JOURNEY_STEPS labels exactly -- this is
// static, presentation-only structural content already established on the
// website, not invented business data.
const JOURNEY_STEPS = ["Housing", "University", "Living Costs", "Degree", "Skills", "Career", "Salary", "Hiring"];

// Builds the closing "next steps" list from a small fixed set of generic,
// always-safe phrases (drawn from the milestone's own suggested slide 12
// example) -- each line only included when the planner result actually
// supports it, never invented, never referencing data this specific plan
// doesn't have.
function buildClosingSteps(normalized) {
    const steps = [];
    if (normalized.residences.length > 0) steps.push("Finalize your accommodation choice");
    if (normalized.readiness.available && normalized.readiness.skillsToDevelop.length > 0) steps.push("Strengthen your priority skills");
    if (normalized.readiness.available && (normalized.readiness.portfolioExpectations.length > 0 || normalized.readiness.projectEvidence.length > 0)) steps.push("Build relevant portfolio evidence");
    if (normalized.readiness.available && normalized.readiness.interviewAreas.length > 0) steps.push("Prepare for interviews");
    if (normalized.readiness.available && normalized.readiness.entryRoutes.length > 0) steps.push("Begin exploring entry routes and applications");
    if (steps.length === 0) {
        // Nothing career-specific was available at all (e.g. degree
        // unresolved) -- a safe, generic fallback rather than an empty slide.
        steps.push("Review your degree and living-cost plan");
        steps.push("Add a recognized degree to unlock career and hiring guidance");
    }
    return steps.slice(0, 5);
}

function normalizePlannerForPresentation(plannerResult) {
    const body = plannerResult && typeof plannerResult === "object" ? plannerResult : {};

    const university = normalizeUniversity(body.university);
    const student = normalizeStudent(body.student, body.university);
    const residences = normalizeResidences(body.residences, MAX_RESIDENCES);
    const comparison = normalizeResidences(body.comparison, MAX_COMPARISON_ROWS);
    const livingExpenses = normalizeLivingExpenses(body.livingExpenses);
    const degree = normalizeDegree(body.degree);
    const careers = normalizeCareers(body.careers, MAX_CAREERS);

    // The primary (top-ranked) career's raw salary/readiness -- read from
    // the FIRST entry of the original, unmodified `careers` array so its
    // position is unambiguous even if normalizeCareers() had to drop an
    // earlier malformed entry.
    const primaryCareerRaw = Array.isArray(body.careers)
        ? body.careers.find((c) => c && typeof c === "object" && cleanText(c.title, MAX_SHORT_TEXT))
        : null;
    const salary = normalizeSalary(primaryCareerRaw?.salary);
    const readiness = normalizeReadiness(primaryCareerRaw?.readiness);

    const normalized = {
        student,
        university,
        residences,
        comparison,
        livingExpenses,
        degree,
        careers,
        primaryCareerTitle: careers[0]?.title || null,
        primaryCareerMatchLabel: careers[0]?.matchLabel || null,
        salary,
        readiness,
        journeySteps: JOURNEY_STEPS,
    };
    normalized.closingSteps = buildClosingSteps(normalized);
    return normalized;
}

module.exports = {
    normalizePlannerForPresentation,
    // Exposed for unit testing, same precedent as the other resolver modules.
    cleanText,
    sanitizeTableCell,
    cleanNumber,
    cleanStringList,
    formatPrice,
    formatSalaryRange,
    normalizeUniversity,
    normalizeResidences,
    normalizeLivingExpenses,
    normalizeDegree,
    normalizeCareers,
    normalizeSalary,
    normalizeReadiness,
    MAX_RESIDENCES,
    MAX_COMPARISON_ROWS,
    MAX_CAREERS,
};
