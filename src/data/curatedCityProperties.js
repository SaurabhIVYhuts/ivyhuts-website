// Amber's Partner API location filter doesn't recognize every city it
// actually has inventory in (see api/_lib/amberGateway.js's matchesCity
// comment, and fetchListings' fallback — which only scans the first page of
// Amber's unfiltered catalog, so it can miss real matches further in).
// Confirmed for Hatfield specifically: "Luna, Hatfield" exists in Amber's
// catalog, but no location_place_name value we could find (plain city name,
// county-qualified, postcode district, Amber's own site's location slug)
// gets their Partner API to surface it via search.
//
// A small manual allowlist of known canonical_names to backfill when a
// city's normal search comes back empty, keyed by lowercase city name —
// used by PropertyListingPage.js. Remove an entry once Amber's own search
// (or a proper full-catalog index) can find it unassisted.
export const CURATED_CITY_PROPERTIES = {
  hatfield: ["luna-hatfield-1905073461300"],
};
