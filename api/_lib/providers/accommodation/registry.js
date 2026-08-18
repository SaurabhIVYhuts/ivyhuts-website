const { PROVIDERS } = require("./types");
const uhomes = require("./uhomes");
const uniacco = require("./uniacco");
const universityLiving = require("./universityLiving");
const graddingHomes = require("./graddingHomes");

// The exhaustive provider list for Find Rooms search orchestration.
//
// AMBER IS DELIBERATELY NOT HERE. Amber is the existing, independent
// IVYHUTS property infrastructure (api/amber.js) — it must never become a
// CRM Competitive-Analysis/Find-Rooms provider (Milestone 23.2 Part 6,
// Milestone 23.3 Part 6). If you are looking for a fifth entry to add
// Amber here: don't — see search.js's own header comment for the same
// rule restated at the orchestration call site.
const REGISTRY = {
    uhomes,
    uniacco,
    university_living: universityLiving,
    gradding_homes: graddingHomes,
};

// Defensive — catches registry/PROVIDERS drift at require-time (e.g. a
// typo'd key, a forgotten entry) rather than silently searching the wrong
// provider set.
const registryKeys = Object.keys(REGISTRY).sort();
const expectedKeys = [...PROVIDERS].sort();
if (JSON.stringify(registryKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error(`Provider registry keys (${registryKeys.join(", ")}) do not match PROVIDERS (${expectedKeys.join(", ")}).`);
}

module.exports = { REGISTRY };
