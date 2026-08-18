// Shared constants + JSDoc shape reference for the accommodation provider
// orchestration layer (Milestone 23.3). Plain JS — this backend has no
// TypeScript build step, so the typedefs below are documentation only, not
// runtime-enforced.
//
// Deliberately parallels src/lib/property-intelligence/types.ts and
// providers/types.ts in the separate ivyhuts-crm repo (same provider set,
// same canonical property shape, same adapter status vocabulary) rather
// than sharing a package — these are two independent deployables with no
// shared build/publish step, so keeping the shapes in sync by convention is
// the smallest workable option today.

const PROVIDERS = ["uhomes", "uniacco", "university_living", "gradding_homes"];

// SEARCHED:       the provider was queried and returned a (possibly empty) result.
// NO_RESULTS:     SEARCHED, and specifically zero properties matched.
// UNAVAILABLE:    the provider was reachable-in-principle but could not serve
//                 this request right now (rate limit, timeout, upstream error).
// NOT_CONFIGURED: no real integration exists for this provider yet — the
//                 honest state for all four today (see registry.js/README.md).
// ERROR:          the adapter itself failed unexpectedly (a bug, not a
//                 modeled upstream condition) — never silently reported as
//                 zero results (see search.js's sanitizeAdapterResult).
const PROVIDER_STATUSES = ["SEARCHED", "NO_RESULTS", "UNAVAILABLE", "NOT_CONFIGURED", "ERROR"];

/**
 * @typedef {Object} CanonicalProperty
 * @property {string} provider
 * @property {string|null} providerPropertyId
 * @property {string} propertyId
 * @property {string} name
 * @property {string|null} url
 * @property {string|null} slug
 * @property {string|null} image
 * @property {string[]} images
 * @property {string|null} city
 * @property {string|null} country
 * @property {number|null} latitude
 * @property {number|null} longitude
 * @property {number|null} rent
 * @property {string|null} currency
 * @property {"week"|"month"|"night"|"unknown"} rentPeriod
 * @property {number|null} rentPerWeek - derived for cross-provider comparison; null unless rent+rentPeriod are both known
 * @property {string|null} roomType
 * @property {number|null} sharing
 * @property {"available"|"unavailable"|"unknown"} availability
 * @property {string[]} amenities
 * @property {string|null} sourceUpdatedAt
 * @property {number|null} distanceFromUniversityKm - filled in by search.js, straight-line only, never fabricated
 */

/**
 * @typedef {Object} ProviderSearchResult
 * @property {string} provider
 * @property {"SEARCHED"|"NO_RESULTS"|"UNAVAILABLE"|"NOT_CONFIGURED"|"ERROR"} status
 * @property {CanonicalProperty[]} properties
 * @property {string} [reason]
 */

module.exports = { PROVIDERS, PROVIDER_STATUSES };
