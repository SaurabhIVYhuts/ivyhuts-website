// URLs for the homepage's integrated accommodation search
// (src/components/universityHousing/AccommodationSearchExperience.js).
// The search keeps its state in the URL, so "open a search" anywhere on the
// site is just a homepage link in the same shape the search box writes.
export const SEARCH_ANCHOR_ID = "find-accommodation";
export const SEARCH_ANCHOR_HREF = `/#${SEARCH_ANCHOR_ID}`;

export function citySearchHref(cityName, countryCode) {
  const params = { city: cityName };
  if (countryCode) params.country = countryCode;
  return `/?${new URLSearchParams(params).toString()}`;
}

export function countrySearchHref(countryCode) {
  return `/?${new URLSearchParams({ country: countryCode }).toString()}`;
}
