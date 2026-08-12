// Career Path Intelligence (Milestone 6) — deterministic, curated, zero-AI,
// zero-external-API resolver. Same shape/precedent as ./degreeResolver.js:
// plain CommonJS, no build step, reads its JSON sibling directly, makes no
// network calls of its own.
//
// This module deliberately does NOT re-implement degree/specialization
// resolution — it requires the exact same resolveDegreeById/
// resolveDegreeByName/resolveSpecialization functions api/student-planner.js
// already uses for the `degree` field (via buildDegreeResult in
// api/student-planner.js), so there is exactly one canonical place that
// knows how to turn a client-supplied degree/specialization into a real
// record. Never accept a client-supplied career id as authoritative — the
// caller only ever supplies degreeId/degree/specialization, and this module
// determines which careers apply.
"use strict";

const CAREERS = require("./careers.json");
const { resolveDegreeById, resolveDegreeByName, resolveSpecialization } = require("./degreeResolver");

const DEGREE_MATCH_SCORE = 50;
const SPECIALIZATION_MATCH_SCORE = 30;
const SKILL_OVERLAP_MAX_SCORE = 20;
const MIN_SCORE_TO_SHOW = 40;
const MAX_RESULTS = 5;

// A small, controlled set of known wording variants — NOT a general
// ontology. Kept intentionally short (item 9 of the Milestone 6 plan): the
// careers dataset is authored by hand to reuse degrees.json's own skill
// terminology wherever the concept genuinely matches, so this only needs to
// cover the handful of cases where a career's natural phrasing legitimately
// differs from the degree dataset's phrasing for the same underlying skill.
const SKILL_ALIASES = {
    "cloud computing": "cloud platforms",
    "cloud infrastructure": "cloud platforms",
    "programming languages": "programming",
    "software testing": "testing",
    "version control": "git",
};

function normalizeSkill(skill) {
    const key = String(skill || "").toLowerCase().trim().replace(/\s+/g, " ");
    if (!key) return "";
    return SKILL_ALIASES[key] || key;
}

// Builds the normalized set of skills a student is credited with from their
// degree's coreSkills plus (if a specialization was resolved) its
// emphasisSkills — the same two fields DegreeCareerSection.js already
// displays. Never claims skills the degree dataset doesn't actually list.
function buildStudentSkillSet(degree, specialization) {
    const raw = [...(degree.coreSkills || []), ...((specialization && specialization.emphasisSkills) || [])];
    return new Set(raw.map(normalizeSkill).filter(Boolean));
}

function scoreCareer(career, degree, specialization, studentSkills) {
    let score = 0;

    if ((career.relevantDegrees || []).includes(degree.id)) {
        score += DEGREE_MATCH_SCORE;
    }

    const specKey = specialization ? `${degree.id}:${specialization.id}` : null;
    if (specKey && (career.relevantSpecializations || []).includes(specKey)) {
        score += SPECIALIZATION_MATCH_SCORE;
    }

    const required = career.requiredSkills || [];
    if (required.length) {
        const requiredSet = new Set(required.map(normalizeSkill).filter(Boolean));
        let overlap = 0;
        requiredSet.forEach((skill) => { if (studentSkills.has(skill)) overlap++; });
        const overlapFraction = requiredSet.size ? overlap / requiredSet.size : 0;
        score += Math.round(overlapFraction * SKILL_OVERLAP_MAX_SCORE);
    }

    // Never negative, never above 100 — a defensive clamp, not something the
    // weights above should ever actually hit.
    return Math.max(0, Math.min(100, score));
}

function matchLabelForScore(score) {
    if (score >= 80) return "Strong Match";
    if (score >= 60) return "Good Match";
    if (score >= MIN_SCORE_TO_SHOW) return "Possible Path";
    return null;
}

// Splits a career's required + preferred skills into "already covered by the
// degree/specialization" vs "still to develop" — deliberately phrased in the
// UI as "skills covered by your degree", never "skills you've mastered"
// (item 10 of the plan). Dedupes by normalized form so near-duplicate
// wording never shows the same underlying skill twice.
function buildSkillGap(career, studentSkills) {
    const already = [];
    const toDevelop = [];
    const seen = new Set();

    const addSkill = (skill) => {
        const norm = normalizeSkill(skill);
        if (!norm || seen.has(norm)) return;
        seen.add(norm);
        if (studentSkills.has(norm)) already.push(skill);
        else toDevelop.push(skill);
    };

    (career.requiredSkills || []).forEach(addSkill);
    (career.preferredSkills || []).forEach(addSkill);

    return { already, toDevelop };
}

// Resolves the top 3-5 career paths for a degree (+ optional specialization).
// Mirrors buildDegreeResult's own (degreeId, freeTextName, freeTextSpecialization)
// calling convention in api/student-planner.js for consistency. Never
// throws, never returns NaN/duplicate/negative-score careers — an unknown
// degree, a degree with no career mappings, or an unrecognized specialization
// all degrade to a controlled (possibly empty) array, same "never fabricate,
// never crash" philosophy as degreeResolver.js/buildDegreeResult.
function resolveCareersForDegree(degreeId, degreeText, specializationText) {
    const degree = resolveDegreeById(degreeId) || resolveDegreeByName(degreeText);
    if (!degree) return [];

    const specializationInput = specializationText && String(specializationText).trim();
    const specialization = specializationInput ? resolveSpecialization(degree, specializationInput) : null;
    const specKey = specialization ? `${degree.id}:${specialization.id}` : null;

    const candidates = CAREERS.filter((career) =>
        (career.relevantDegrees || []).includes(degree.id) ||
        (specKey && (career.relevantSpecializations || []).includes(specKey))
    );

    const studentSkills = buildStudentSkillSet(degree, specialization);

    const ranked = candidates
        .map((career) => {
            const matchScore = scoreCareer(career, degree, specialization, studentSkills);
            const matchLabel = matchLabelForScore(matchScore);
            if (!matchLabel) return null; // below the show threshold — never surfaced as a "top" path
            const { already, toDevelop } = buildSkillGap(career, studentSkills);
            return {
                id: career.id,
                title: career.title,
                category: career.category,
                summary: career.summary,
                matchScore,
                matchLabel,
                requiredSkills: career.requiredSkills || [],
                alreadyHaveSkills: already,
                skillsToDevelop: toDevelop,
                source: "ivyhuts-career-guidance",
            };
        })
        .filter(Boolean);

    // Deterministic ordering: highest score first, alphabetical title as a
    // stable tie-break — never random, so identical inputs always produce
    // identical output.
    ranked.sort((a, b) => b.matchScore - a.matchScore || a.title.localeCompare(b.title));

    // Defensive dedup — the curated dataset should never contain a duplicate
    // career id, but this guarantees the API response never could even if it did.
    const seenIds = new Set();
    const deduped = ranked.filter((career) => {
        if (seenIds.has(career.id)) return false;
        seenIds.add(career.id);
        return true;
    });

    return deduped.slice(0, MAX_RESULTS);
}

module.exports = {
    resolveCareersForDegree,
    // Exposed for unit testing (scripts/verify-planner-accommodation-index.js),
    // same precedent as accommodationIndex.js/costOfLiving.js exporting their
    // own pure helper functions.
    normalizeSkill,
    scoreCareer,
    matchLabelForScore,
    buildSkillGap,
    buildStudentSkillSet,
    CAREERS,
    DEGREE_MATCH_SCORE,
    SPECIALIZATION_MATCH_SCORE,
    SKILL_OVERLAP_MAX_SCORE,
    MIN_SCORE_TO_SHOW,
    MAX_RESULTS,
};
