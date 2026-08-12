// Career Readiness & Hiring Path (Milestone 8) — deterministic, curated,
// zero-AI, zero-external-API resolver. Same shape/precedent as
// ./careerResolver.js and ./salaryResolver.js: plain CommonJS, no build
// step, reads its JSON sibling directly, makes no network calls of its own.
//
// Deliberate pipeline (plan item: "must remain connected to Milestone 6
// data, not a disconnected system"): this module takes the ALREADY-RANKED,
// already-salary-enriched career object api/student-planner.js produced
// (id, requiredSkills, alreadyHaveSkills, skillsToDevelop — all from
// ./careerResolver.js) and layers readiness guidance on top, keyed by
// career.id (the same authoritative relationship ./salaryResolver.js uses —
// never career title). It does NOT re-rank careers, does NOT touch salary,
// and does NOT introduce a second skill vocabulary: `essentialSkills` is
// simply the career's own `requiredSkills` it was already given,
// `recommendedSkills` is the same career's `preferredSkills` straight from
// ./careers.json (the one authoritative career dataset), and
// `alreadyCoveredSkills`/`skillsToDevelop` are passed through unchanged from
// the Milestone 6 skill-matching result — this module performs zero skill
// normalization of its own, reusing ./careerResolver.js's result as-is.
"use strict";

const READINESS = require("./careerReadiness.json");
const CAREERS = require("./careers.json");

const UNAVAILABLE_NOTE = "Hiring guidance isn't available for this career yet.";
const READINESS_NOTE = "Preparation guidance, not a guarantee of an interview or an offer. Common entry routes and preparation areas — actual hiring processes vary by employer.";

const LIST_FIELDS = ["entryRoutes", "portfolioExpectations", "projectEvidence", "experienceSignals", "preparationSteps"];
const INTERVIEW_CATEGORIES = ["technical", "practical", "behavioral"];

function isNonEmptyStringList(list) {
    return (
        Array.isArray(list) &&
        list.length > 0 &&
        list.every((s) => typeof s === "string" && s.trim().length > 0) &&
        new Set(list).size === list.length // no duplicate items within the list
    );
}

// A row must have a real careerId and every required list populated with
// non-empty, non-duplicate strings to ever reach the UI (plan item 25) —
// malformed data is dropped here, at load time, same "never let bad data
// leak past the resolver" precedent as ./salaryResolver.js's
// isValidSalaryRow.
function isValidReadinessRow(row) {
    if (!row || typeof row !== "object" || !row.careerId) return false;
    if (!LIST_FIELDS.every((field) => isNonEmptyStringList(row[field]))) return false;
    if (!row.interviewAreas || typeof row.interviewAreas !== "object") return false;
    return INTERVIEW_CATEGORIES.every((cat) => isNonEmptyStringList(row.interviewAreas[cat]));
}

const CAREERS_BY_ID = new Map(CAREERS.map((c) => [c.id, c]));

// Keyed by careerId -> row. Built once at require time, filtering out
// anything that fails isValidReadinessRow and dropping (never overwriting)
// a second entry for a careerId already seen, so a duplicate/malformed
// dataset entry can only ever degrade a single career to "unavailable",
// never crash the endpoint or leak bad data to the UI.
const READINESS_INDEX = new Map();
const DUPLICATE_CAREER_IDS = [];
for (const row of READINESS) {
    if (!isValidReadinessRow(row)) continue;
    if (READINESS_INDEX.has(row.careerId)) {
        DUPLICATE_CAREER_IDS.push(row.careerId);
        continue;
    }
    READINESS_INDEX.set(row.careerId, row);
}

function unavailableReadiness() {
    return {
        available: false,
        essentialSkills: [],
        recommendedSkills: [],
        alreadyCoveredSkills: [],
        skillsToDevelop: [],
        entryRoutes: [],
        portfolioExpectations: [],
        projectEvidence: [],
        interviewAreas: null,
        experienceSignals: [],
        preparationSteps: [],
        note: UNAVAILABLE_NOTE,
    };
}

// Resolves hiring-readiness guidance for one already-ranked career object.
// Never throws, never fabricates guidance for a career missing curated
// readiness data — degrades to a controlled `available: false` shape so the
// career card still renders (plan item 30). `career` is the SAME object
// ./careerResolver.js (+ ./salaryResolver.js) already produced — this
// function only ever reads career.id/requiredSkills/alreadyHaveSkills/
// skillsToDevelop, never re-derives them.
function resolveReadinessForCareer(career) {
    const careerId = career && career.id;
    if (!careerId) return unavailableReadiness();

    const row = READINESS_INDEX.get(careerId);
    if (!row) return unavailableReadiness();

    const careerDataset = CAREERS_BY_ID.get(careerId);

    return {
        available: true,
        essentialSkills: career.requiredSkills || (careerDataset && careerDataset.requiredSkills) || [],
        recommendedSkills: (careerDataset && careerDataset.preferredSkills) || [],
        alreadyCoveredSkills: career.alreadyHaveSkills || [],
        skillsToDevelop: career.skillsToDevelop || [],
        entryRoutes: row.entryRoutes,
        portfolioExpectations: row.portfolioExpectations,
        projectEvidence: row.projectEvidence,
        interviewAreas: row.interviewAreas,
        experienceSignals: row.experienceSignals,
        preparationSteps: row.preparationSteps,
        note: READINESS_NOTE,
    };
}

module.exports = {
    resolveReadinessForCareer,
    // Exposed for unit testing, same precedent as careerResolver.js/salaryResolver.js.
    isValidReadinessRow,
    isNonEmptyStringList,
    DUPLICATE_CAREER_IDS,
    READINESS,
    LIST_FIELDS,
    INTERVIEW_CATEGORIES,
};
