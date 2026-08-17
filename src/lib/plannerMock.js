// Student Planner — mock/fallback data for the sections not yet backed by a
// real source: currently just livingExpenses' network-failure fallback (see
// below). Everything else in this file is either real, resolved data or a
// controlled "pending" placeholder — never fabricated content.
//
// Residences are NOT generated here (Milestone 3) — they come entirely from
// the real accommodation index via /api/student-planner (see
// StudentPlannerPage.js's handleSubmit and api/_lib/accommodationIndex.js).
// This file always returns residences:[]/comparison:[]; if the API call
// fails or the index has no data yet, the UI's existing "building" state
// (RecommendedResidences.js et al.'s `status` prop) shows an honest empty
// state — it must never silently show fabricated residences in production.
//
// The `university` section uses a REAL resolved record (name/city/country/
// latitude/longitude from src/data/universities.json) when the student
// selected one via the autocomplete; otherwise it falls back to the same
// generic, non-fabricated templated summary this file has always used.
//
// The `degree` section (Milestone 5) is a controlled "pending" placeholder
// ONLY — never a keyword-bucket guess at skills. The real, curated degree
// dataset lives entirely in api/_lib/degrees.json and is only ever surfaced
// via the real /api/student-planner response (StudentPlannerPage.js
// overwrites this placeholder as soon as that response arrives, same
// pattern as residences/livingExpenses). If the API is unreachable, the UI
// honestly shows "still preparing your degree guidance" rather than
// fabricating skills client-side — see DegreeCareerSection.js.
//
// Career paths (Milestone 6) always start as an empty array here — never
// fabricated client-side. The real, curated, deterministically-ranked list
// lives entirely in api/_lib/careers.json + api/_lib/careerResolver.js and is
// only ever surfaced via the real /api/student-planner response
// (StudentPlannerPage.js overwrites `careers` as soon as that response
// arrives, same pattern as degree/residences/livingExpenses). Salary and
// hiring/job-market data remain explicitly OUT OF SCOPE this milestone too.
//
// Pure, zero-network, deterministic. Intentionally has ZERO coupling to
// Amber: no import from src/services/amberApi.js or amberMapper.js.

const CURRENCY_BY_COUNTRY = {
  "united kingdom": "£", uk: "£", england: "£",
  "united states": "$", usa: "$", us: "$",
  canada: "CA$",
  australia: "A$",
  ireland: "€", germany: "€", netherlands: "€", france: "€",
};

const DEFAULT_WEEKLY_BUDGET_BY_COUNTRY = {
  "united kingdom": 220, uk: 220, england: 220,
  "united states": 260, usa: 260, us: 260,
  canada: 230,
  australia: 250,
  ireland: 210, germany: 190, netherlands: 200, france: 200,
};

function roundTo5(n) {
  return Math.round(n / 5) * 5;
}

function lookupByCountry(table, country, fallback) {
  const key = (country || "").trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : fallback;
}

// Fallback for when /api/student-planner is unreachable, OR — the gap this
// comment didn't previously cover (audit fix) — when it responds but without
// a real livingExpenses field (e.g. res.ok but body.ok false, or the field
// missing for some other reason): StudentPlannerPage.js's handleSubmit only
// overwrites this with the real api/_lib/costOfLiving.js figure `if (res.ok
// && body?.ok && body.livingExpenses)`, so any other outcome silently leaves
// this generic country-level guess on screen. LivingExpenses.js already has
// an honest `meta.note` affordance for exactly this (built for the real
// API's own estimate caveat) — this was the one caller never supplying one,
// so a fabricated figure rendered pixel-identical to real curated data with
// no way for a student to tell the difference.
function buildLivingExpenses(accommodationMonthly, currency) {
  const food = roundTo5(accommodationMonthly * 0.35);
  const transport = roundTo5(accommodationMonthly * 0.12);
  const utilities = roundTo5(accommodationMonthly * 0.1);
  const personal = roundTo5(accommodationMonthly * 0.15);
  const totalMonthly = accommodationMonthly + food + transport + utilities + personal;
  return {
    accommodation: accommodationMonthly,
    food,
    transport,
    utilities,
    personal,
    totalMonthly,
    totalAnnual: totalMonthly * 12,
    currency,
    meta: { note: "Generic estimate based on typical costs for your country — not yet confirmed against real city-level data." },
  };
}

// Controlled placeholder ONLY — never a keyword-bucket guess at skills. Real
// content always comes from /api/student-planner's `degree` field (built by
// api/_lib/degreeResolver.js + api/_lib/degrees.json), which
// StudentPlannerPage.js overwrites this with as soon as it responds.
// `status: "pending"` (distinct from the API's own "ready"/"unresolved")
// lets DegreeCareerSection.js show an honest "still preparing" state instead
// of an empty-looking section while the request is in flight, and distinct
// from "unresolved" (which means the API answered but doesn't recognize the
// degree) — see DegreeCareerSection.js.
function buildPendingDegree(degreeName) {
  return {
    id: null,
    name: (degreeName || "").trim() || null,
    status: "pending",
    category: null,
    summary: null,
    coreSkills: [],
    technicalAreas: [],
    specializationPaths: [],
    specialization: null,
    specializationNote: null,
    source: null,
  };
}

/**
 * @param {{
 *   university: string, degree: string, country: string, city: string,
 *   specialization?: string, currentYear?: string, graduationYear?: string,
 *   budget?: string, accommodationPreference?: string,
 * }} studentInput
 * @param {{name, city, country, latitude, longitude}|null} resolvedUniversity
 *   The canonical record from src/lib/universityResolver.js, when the
 *   student selected one via the autocomplete — real coordinates/city/
 *   country flow into the university section instead of raw typed text.
 *   null (unresolved / free text) falls back to the same generic,
 *   non-fabricated templated summary this file has always used.
 */
export function buildMockPlannerResult(studentInput, resolvedUniversity = null) {
  const university = (studentInput.university || "").trim();
  const degree = (studentInput.degree || "").trim();
  const country = (studentInput.country || "").trim();
  const city = (studentInput.city || "").trim();
  const specialization = (studentInput.specialization || "").trim();
  const accommodationPreference = (studentInput.accommodationPreference || "").trim();

  const currency = lookupByCountry(CURRENCY_BY_COUNTRY, country, "£");
  const basePerWeek = Number(studentInput.budget) > 0 ? Number(studentInput.budget) : lookupByCountry(DEFAULT_WEEKLY_BUDGET_BY_COUNTRY, country, 220);
  const accommodationMonthly = roundTo5(basePerWeek * 4.33);
  const livingExpenses = buildLivingExpenses(accommodationMonthly, currency);

  const effectiveName = resolvedUniversity?.name || university;
  const effectiveCity = resolvedUniversity?.city || city;
  const effectiveCountry = resolvedUniversity?.country || country;

  return {
    student: {
      university: effectiveName, country: effectiveCountry, city: effectiveCity, degree,
      specialization: specialization || null,
      currentYear: studentInput.currentYear || null,
      graduationYear: studentInput.graduationYear || null,
      budget: Number(studentInput.budget) > 0 ? Number(studentInput.budget) : null,
      accommodationPreference: accommodationPreference || null,
    },
    university: {
      name: effectiveName,
      city: effectiveCity,
      country: effectiveCountry,
      latitude: resolvedUniversity?.latitude ?? null,
      longitude: resolvedUniversity?.longitude ?? null,
      summary: `${effectiveName || "Your university"} is located in ${effectiveCity || "your city"}${effectiveCountry ? `, ${effectiveCountry}` : ""}. It's a popular choice for students pursuing ${degree || "a range of"} programmes.`,
      keyFacts: [
        `Located in ${effectiveCity || "—"}${effectiveCountry ? `, ${effectiveCountry}` : ""}`,
        degree ? `Offers programmes in fields such as ${degree}` : "Offers a wide range of degree programmes",
        "Popular with international students",
      ],
    },
    residences: [],
    comparison: [],
    livingExpenses,
    degree: buildPendingDegree(degree || specialization),
    careers: [],
  };
}
