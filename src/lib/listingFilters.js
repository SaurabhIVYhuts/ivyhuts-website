// Milestone 22 (IVYHUTS_MILESTONE_22_UNIVERSITY_HOUSING_CANONICAL_UI.md):
// ONE canonical filtering/sorting model, extracted from PropertyListingPage.js
// (Find Room) so University Housing can share it exactly rather than a second
// copy drifting out of sync (Part 18's explicit instruction). Operates on the
// shared "listing" shape both safeListingList()/safeResidenceListingList()
// (src/services/amberMapper.js) already produce — no new shape introduced.
import { classifyPetPolicy } from "./petPolicy";

const UNIVERSITY_RE = /university|college/i;
const AMENITY_OPTION_LIMIT = 16;

// Every clause is `!filters.X || ...` — an empty/default filters object is
// therefore always a full pass-through (Milestone 13's own proven guarantee
// for Find Room, now shared verbatim by University Housing).
export function applyListingFilters(listings, filters) {
  const q = (filters.query || "").toLowerCase().trim();
  return listings.filter((l) => {
    const haystack = [l.name, l.address?.locality, l.address?.country, ...(l.distances?.nearby || []).map((d) => d.place)]
      .join(" ")
      .toLowerCase();
    const textMatch = !q || haystack.includes(q);

    // Weekly-equivalent (see PropertyListingPage.js's own long-standing
    // comment on why raw price.from is unsafe to compare across durations).
    const price = l.priceWeekly ?? l.price?.from ?? 0;
    const minOk = !filters.minPrice || price >= Number(filters.minPrice);
    const maxOk = !filters.maxPrice || price <= Number(filters.maxPrice);

    const roomTypeOk = !filters.roomType || (l.rooms?.types || []).includes(filters.roomType);
    const billsOk = !filters.billsOnly || l.billsIncluded;
    const petOk = !filters.petPolicy || classifyPetPolicy(l.amenities?.all) === filters.petPolicy;
    const nearOk = !filters.near || (l.distances?.nearby || []).some((d) => d.place === filters.near);
    const amenitiesOk = (filters.amenities || []).every((a) => (l.amenities?.all || []).includes(a));
    const moveInOk = !filters.moveInMonth || (l.moveInOptions || []).includes(filters.moveInMonth);
    const stayDurationOk = !filters.stayDuration || (l.stayDurationOptions || []).includes(filters.stayDuration);

    return textMatch && minOk && maxOk && roomTypeOk && billsOk && petOk && nearOk && amenitiesOk && moveInOk && stayDurationOk;
  });
}

// `pinnedSlug` reproduces PropertyListingPage.js's `?property=` exact-match
// pin-to-top behavior — applied as a final stable sort after whatever the
// user's own sortBy already did, same as before.
export function sortListings(listings, sortBy, { pinnedSlug } = {}) {
  const sorted = [...listings];
  if (sortBy === "price_asc") sorted.sort((a, b) => (a.priceWeekly ?? a.price?.from ?? Infinity) - (b.priceWeekly ?? b.price?.from ?? Infinity));
  else if (sortBy === "price_desc") sorted.sort((a, b) => (b.priceWeekly ?? b.price?.from ?? -Infinity) - (a.priceWeekly ?? a.price?.from ?? -Infinity));
  else if (sortBy === "rating_desc") sorted.sort((a, b) => (b.rating?.overall ?? -1) - (a.rating?.overall ?? -1));
  else if (sortBy === "distance") sorted.sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity));
  if (pinnedSlug) sorted.sort((a, b) => (a.slug === pinnedSlug ? -1 : 0) - (b.slug === pinnedSlug ? -1 : 0));
  return sorted;
}

// Derives every filter dropdown's real option list from the CURRENT listing
// set (never hardcoded) — same rule PropertyListingPage.js already follows.
export function deriveFilterOptions(listings) {
  const roomTypeOptions = Array.from(new Set(listings.flatMap((l) => l.rooms?.types || []))).sort();
  const nearOptions = Array.from(new Set(
    listings.flatMap((l) => (l.distances?.nearby || []).filter((d) => UNIVERSITY_RE.test(d.place)).map((d) => d.place))
  )).sort();
  const amenityCounts = new Map();
  listings.forEach((l) => (l.amenities?.all || []).forEach((a) => amenityCounts.set(a, (amenityCounts.get(a) || 0) + 1)));
  const amenityOptions = Array.from(amenityCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, AMENITY_OPTION_LIMIT)
    .map(([name]) => name);
  const moveInOptions = Array.from(new Set(listings.flatMap((l) => l.moveInOptions || []))).sort((a, b) => new Date(a) - new Date(b));
  const stayDurationOptions = Array.from(new Set(listings.flatMap((l) => l.stayDurationOptions || []))).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  return { roomTypeOptions, nearOptions, amenityOptions, moveInOptions, stayDurationOptions };
}
