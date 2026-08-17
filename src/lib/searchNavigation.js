// Turns a resolved search entity (from GlobalSearchBar / GET /api/search —
// see api/_lib/searchIndex.js for the exact shape) into the URL that
// actually loads its inventory. One normalized query structure per entity
// type, reused by every caller (homepage hero search, find-rooms in-page
// search) rather than each building its own ad hoc URL.
export function buildSearchUrl(entity) {
  if (!entity) return "/properties";
  switch (entity.type) {
    case "city":
      return `/properties?city=${encodeURIComponent(entity.value.city)}`;
    case "country":
      return `/properties?country=${encodeURIComponent(entity.value.country)}`;
    case "university":
      // A curated match (real campusUniversities.json id) resolves via the
      // usual ?university= param. An EXTRACTED match (a real university/
      // college name pulled from Amber's own nearby-place data — see
      // api/_lib/searchIndex.js's loadExtractedUniversities — but with no
      // hand-verified id/coordinates) has no canonical id to navigate with;
      // it instead goes straight to that city's listings pre-filtered by
      // the SAME "University / Area" proximity filter PropertyListingPage.js
      // already implements (?near=), seeded with this exact place name so
      // only properties actually near it show up.
      return entity.value.universityId
        ? `/properties?university=${encodeURIComponent(entity.value.universityId)}`
        : `/properties?city=${encodeURIComponent(entity.value.city)}&near=${encodeURIComponent(entity.value.near)}`;
    case "property":
      // A resolved property (we know its exact slug) goes straight to its
      // own page — that IS the search result, no need to route through a
      // filtered list first. A free-text submit that only fuzzy-matched a
      // property name (no confident single slug) instead uses
      // buildPropertyQueryUrl below.
      return entity.slug
        ? `/property/${encodeURIComponent(entity.slug)}`
        : buildPropertyQueryUrl(entity.label);
    default:
      return "/properties";
  }
}

// Fallback for a raw text submit that didn't resolve to one specific
// suggestion (e.g. the user typed and hit Enter before the dropdown
// finished, or typed something that only partially matches several
// properties) — PropertyListingPage resolves this further itself (see its
// `property` param handling).
export function buildPropertyQueryUrl(query) {
  return `/properties?property=${encodeURIComponent(query)}`;
}
