// Vercel serverless function backing the Student Planner's residence
// discovery AND (Milestone 4) its Living Cost layer. Thin by design, same
// shape as api/amber.js: all the actual coordination lives in
// ./_lib/accommodationIndex.js, which never talks to Amber directly either —
// it goes through the existing ./_lib/amberGateway.js (fetchListings), so
// this endpoint inherits the exact same global rate budget/cooldown/
// distributed-lock protection as every other Amber consumer. There is no
// separate planner-specific Amber quota anywhere in this path.
//
// ./_lib/costOfLiving.js is a second, independent library this endpoint
// calls alongside accommodationIndex.js — not a new Amber path. It makes no
// network calls of its own; it only reads a curated in-repo dataset plus
// whichever accommodation price accommodationIndex.js already computed. See
// its own header comment for why no live cost-of-living API was connected.
//
// ./_lib/degreeResolver.js (Milestone 5) is a THIRD independent library,
// same shape: no network calls, no Amber import, no Mongo — a plain
// in-process lookup against ./degrees.json. See that file's own header.
//
// ./_lib/careerResolver.js (Milestone 6) is a FOURTH independent library,
// same shape again: no network calls, no Amber import, no Mongo — a plain
// in-process lookup against ./careers.json, ranked using the same resolved
// degree/specialization the `degree` field above already produced. See that
// file's own header comment.
//
// ./_lib/salaryResolver.js (Milestone 7) is a FIFTH independent library,
// same shape again: no network calls, no Amber import, no Mongo — a plain
// in-process lookup against ./salaries.json, keyed by careerId + the SAME
// effectiveCountry this endpoint already resolves for the Living Cost layer
// below. Deliberately does not take a degree/specialization at all — salary
// belongs to the career, not the degree (see that file's own header comment).
//
// ./_lib/careerReadinessResolver.js (Milestone 8) is a SIXTH independent
// library, same shape again: no network calls, no Amber import, no Mongo — a
// plain in-process lookup against ./careerReadiness.json, keyed by
// career.id. Takes the already-ranked career object (not the raw
// degree/specialization) so it can reuse Milestone 6's already-computed
// alreadyHaveSkills/skillsToDevelop directly rather than recomputing skill
// matching a second time (see that file's own header comment).
const { getCityResidences, getOverrideResidences } = require("../../accommodationIndex");
const { resolveUniversityById } = require("../../universityResolver");
const { getLivingExpenses } = require("../../costOfLiving");
const { resolveDegreeById, resolveDegreeByName, resolveSpecialization } = require("../../degreeResolver");
const { resolveCareersForDegree } = require("../../careerResolver");
const { resolveSalaryForCareer } = require("../../salaryResolver");
const { resolveReadinessForCareer } = require("../../careerReadinessResolver");

const DEGREE_DATA_SOURCE = "ivyhuts-degree-guidance";

// Never fabricates: an unresolved degree returns a controlled shape (empty
// arrays, null summary/category) with the raw text the student entered
// preserved as `name` so the UI can still show what they typed, rather than
// inventing skills for a degree we have no curated data for.
function buildDegreeResult(degreeId, degreeText, specializationText) {
    const resolved = resolveDegreeById(degreeId) || resolveDegreeByName(degreeText);
    if (!resolved) {
        return {
            id: null,
            name: (degreeText && String(degreeText).trim()) || null,
            status: "unresolved",
            category: null,
            summary: null,
            coreSkills: [],
            technicalAreas: [],
            specializationPaths: [],
            specialization: null,
            specializationNote: null,
            source: DEGREE_DATA_SOURCE,
        };
    }

    const specializationInput = specializationText && String(specializationText).trim();
    let specialization = null;
    let specializationNote = null;
    if (specializationInput) {
        const match = resolveSpecialization(resolved, specializationInput);
        if (match) {
            specialization = { id: match.id, name: match.name, emphasisSkills: match.emphasisSkills };
        } else {
            // Optional and unrecognized — never breaks the rest of the degree
            // result, just surfaces a controlled note (item 15).
            specializationNote = "Specialization not found in IVYHUTS guidance dataset.";
        }
    }

    return {
        id: resolved.id,
        name: resolved.name,
        status: "ready",
        category: resolved.category,
        summary: resolved.summary,
        coreSkills: resolved.coreSkills,
        technicalAreas: resolved.technicalAreas,
        specializationPaths: resolved.specializationPaths.map((p) => ({ id: p.id, name: p.name })),
        specialization,
        specializationNote,
        source: DEGREE_DATA_SOURCE,
    };
}

async function handler(req, res) {
    if (req.method !== "GET") {
        res.status(405).json({ ok: false, error: "method_not_allowed" });
        return;
    }

    const { city, country, universityId, budget, accommodationPreference, priority, source, degreeId, degree, specialization } = req.query;

    // Authoritative server-side resolution — a client-supplied universityId
    // is only ever a lookup key here, never trusted directly for coordinates.
    // Unresolved/absent -> falls back to the exact Milestone 2 city-only path.
    const university = resolveUniversityById(universityId);
    // Country for the Living Cost lookup: prefer the server-resolved
    // university's country (authoritative) over the client-supplied
    // `country` query param, which is only ever a courtesy fallback for
    // free-text (unresolved) universities — same trust precedent as
    // resolveUniversityById itself.
    const effectiveCountry = university?.country || (country && String(country).trim()) || null;
    // Every student-input field is optional (see StudentPlannerPage.js). City
    // is no longer required: when absent, fall back to the resolved
    // university's own authoritative city (never a client-supplied city
    // paired with a mismatched university) before finally giving up on a
    // location entirely — never guess a city just to have something to send
    // to Amber.
    const effectiveCity = (city && String(city).trim()) || (university && university.city) || null;

    // A resolved university's `accommodationOverride` (see
    // universityResolver.js's own header) is an explicit business rule —
    // "only ever show these specific properties for this university" — not
    // a generic nearby-accommodation search. It takes priority over the
    // normal city-search path whenever present; the university identity
    // itself (not the raw client-supplied `city`/`country` params) is what's
    // trusted here, same precedent as `effectiveCountry`/`effectiveCity`
    // above already preferring the resolved university's own data.
    const overrideSlugs = university?.accommodationOverride?.propertySlugs;
    const hasOverride = Array.isArray(overrideSlugs) && overrideSlugs.length > 0;

    try {
        // No location signal at all -> controlled "no-location" state, zero
        // Amber attempts (a falsy `effectiveCity` never reaches
        // getCityResidences, which is the only other path to Amber in this
        // file besides the override path below).
        const { status, residences } = hasOverride
            ? await getOverrideResidences(overrideSlugs, {
                city: effectiveCity,
                university: university ? { latitude: university.latitude, longitude: university.longitude } : null,
                priority: priority === "HIGH" || priority === "LOW" ? priority : "MEDIUM",
                source: source || "student-planner-page",
            })
            : effectiveCity
            ? await getCityResidences(effectiveCity, {
                budget,
                accommodationPreference,
                priority: priority === "HIGH" || priority === "LOW" ? priority : "MEDIUM",
                source: source || "student-planner-page",
                university: university ? { latitude: university.latitude, longitude: university.longitude } : null,
            })
            : { status: "no-location", residences: [] };

        // Accommodation input for the Living Cost layer: the top-ranked
        // recommended residence's already-normalized monthly price, or null
        // when there is no ready residence / its duration wasn't
        // normalizable — costOfLiving.js never guesses a replacement value.
        const accommodationMonthly = status === "ready" && residences[0] ? residences[0].priceMonthly : null;
        // getLivingExpenses() always returns a usable (possibly world-default)
        // row — only worth calling once there is SOME location signal to
        // ground it in; with neither a city nor a country, an honest `null`
        // (never a guessed-default estimate) is the correct response (see
        // LivingExpenses.js's handling of a null livingExpenses prop).
        const livingExpenses = (effectiveCity || effectiveCountry)
            ? getLivingExpenses({ city: effectiveCity, country: effectiveCountry, accommodationMonthly })
            : null;

        // Degree & Skills (Milestone 5) — a third, fully independent lookup
        // alongside the two above. Zero Amber, zero Mongo, pure in-process
        // dataset read; never throws (buildDegreeResult always returns a
        // usable — possibly "unresolved" — shape, same "never fabricate,
        // never crash the request" philosophy as the rest of this endpoint.
        const degreeResult = buildDegreeResult(degreeId, degree, specialization);

        // Career Path Intelligence (Milestone 6) — a fourth, fully
        // independent lookup. Deterministic, curated, zero-AI; ranks the
        // same resolved degree/specialization against api/_lib/careers.json.
        // resolveCareersForDegree() never throws — an unresolved degree or a
        // degree with no career mappings simply returns [], same "never
        // fabricate, never crash" philosophy as the rest of this endpoint.
        const careers = resolveCareersForDegree(degreeId, degree, specialization);

        // Salary Intelligence (Milestone 7) — layered onto each career
        // object using the SAME effectiveCountry the Living Cost layer above
        // already resolved (the selected university's canonical country,
        // never the client's browser/IP location — plan item 3). Never
        // throws: an unsupported career/country pair degrades to a
        // controlled `available: false` entry, so every career always
        // renders, with or without salary data (plan item 22).
        const careersWithSalary = careers.map((career) => ({
            ...career,
            salary: resolveSalaryForCareer({ careerId: career.id, country: effectiveCountry }),
        }));

        // Career Readiness & Hiring Path (Milestone 8) — layered onto each
        // already-ranked, already-salaried career object. Never throws: a
        // career missing curated readiness data degrades to a controlled
        // `available: false` entry, so every career always renders (plan
        // item 30). Does not affect ranking or salary — resolveReadinessForCareer
        // only reads career.id/requiredSkills/alreadyHaveSkills/skillsToDevelop.
        const careersWithReadiness = careersWithSalary.map((career) => ({
            ...career,
            readiness: resolveReadinessForCareer(career),
        }));

        res.status(200).json({ ok: true, status, residences, comparison: residences, livingExpenses, degree: degreeResult, careers: careersWithReadiness });
    } catch (err) {
        // getCityResidences() is designed to never throw for expected
        // conditions (Mongo unconfigured, Amber unavailable, city never
        // indexed all degrade to status:"building") — a throw here means
        // something genuinely unexpected. Never leak stack traces.
        console.error("[student-planner] unexpected error:", err.message);
        res.status(500).json({ ok: false, error: "internal_error" });
    }
}

module.exports = handler;
// Exposed as a property of the handler (not a separate named export) so
// Vercel's runtime — which requires this module and calls it directly as a
// function — is unaffected; scripts/verify-planner-accommodation-index.js
// uses this to unit-test the degree-building logic without needing a live
// HTTP request or a working Mongo connection (same reasoning as
// accommodationIndex.js/costOfLiving.js exporting their pure functions).
module.exports.buildDegreeResult = buildDegreeResult;
