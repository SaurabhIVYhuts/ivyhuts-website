import React, { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { getProperties, getPropertyBySlug, getPropertiesForCountry, getCityListings } from "../services/amberApi";
import { safeListingList, safeResidenceListingList } from "../services/amberMapper";
import { addRecentSearch } from "../services/recentActivity";
import { trackEvent } from "../lib/eventsApi";
import { DESTINATIONS, findDestination, countryFullName, countryIsoCode } from "../data/destinations";
import { CURATED_CITY_PROPERTIES } from "../data/curatedCityProperties";
import { USPS } from "../data/usps";
import { resolveCampusUniversityByNameOrId } from "../lib/campusUniversityResolver";
import { haversineKm, hasValidCoords } from "../lib/geoDistance";
import { classifyPetPolicy } from "../lib/petPolicy";
import useFilterState from "../hooks/useFilterState";
import SiteNavbar from "../components/layout/SiteNavbar";
import SiteFooter from "../components/layout/SiteFooter";
import TrustStrip from "../components/layout/TrustStrip";
import ListingCard from "../components/listing/ListingCard";
import CompactPropertyCard from "../components/listing/CompactPropertyCard";
import CityCard from "../components/cards/CityCard";
import PriceRangeSlider from "../components/filters/PriceRangeSlider";
import MobileFilterSheet from "../components/filters/MobileFilterSheet";
import MapListingRow from "../components/map/MapListingRow";
import "./PropertyListingPage.css";

// Leaflet + the clustering plugin are a genuinely large dependency (tens of
// KB gzipped) that only matters once someone actually opens map view —
// PropertyListingPage itself is EAGERLY imported by App.js (unlike most
// other pages), so importing PropertyMap normally here would ship that
// weight on every single page load, including the homepage. Lazy-loaded
// instead, so it's fetched only when `view === "map"` first renders it.
const PropertyMap = React.lazy(() => import("../components/map/PropertyMap"));

// A hand-picked spread across regions so the shortcut row isn't UK-heavy —
// every name here must exist in DESTINATIONS. Amsterdam/Tokyo swapped for
// Barcelona/Singapore when Netherlands/Japan were removed from DESTINATIONS
// for having zero real inventory (see destinations.js's own header comment).
const POPULAR_CITY_NAMES = ["London", "New York", "Toronto", "Sydney", "Dublin", "Berlin", "Barcelona", "Singapore"];

const BASE_SORT_OPTIONS = [
  { value: "recommended", label: "Recommended" },
  { value: "price_asc", label: "Price: Low to High" },
  { value: "price_desc", label: "Price: High to Low" },
  { value: "rating_desc", label: "Rating: High to Low" },
];
const DISTANCE_SORT_OPTION = { value: "distance", label: "Distance from University" };

const UNIVERSITY_RE = /university|college/i;
const AMENITY_OPTION_LIMIT = 16;
const COUNTRY_SEARCH_MAX_CITIES = 6;

/* ── SMALL INLINE ICONS (match the stroke-icon style used in the trust strip) ── */
const FilterIcon = () => (
  <svg viewBox="0 0 20 20" fill="none" width="15" height="15"><path d="M3 5h14M6 10h8M8.5 15h3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></svg>
);
const SortIcon = () => (
  <svg viewBox="0 0 20 20" fill="none" width="15" height="15"><path d="M6 4v12M6 4L3 7M6 4l3 3M14 16V4M14 16l3-3M14 16l-3-3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>
);
const ReceiptIcon = () => (
  <svg viewBox="0 0 20 20" fill="none" width="15" height="15"><path d="M5 3h10v14l-2-1.3L11 17l-2-1.3L7 17l-2-1.3V3z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/><path d="M7.5 7h5M7.5 10h5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>
);
const ListViewIcon = () => (
  <svg viewBox="0 0 20 20" fill="none" width="15" height="15"><path d="M4 5.5h12M4 10h12M4 14.5h12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></svg>
);
const GridViewIcon = () => (
  <svg viewBox="0 0 20 20" fill="none" width="15" height="15"><rect x="3.5" y="3.5" width="5.5" height="5.5" rx="1.2" stroke="currentColor" strokeWidth="1.5"/><rect x="11" y="3.5" width="5.5" height="5.5" rx="1.2" stroke="currentColor" strokeWidth="1.5"/><rect x="3.5" y="11" width="5.5" height="5.5" rx="1.2" stroke="currentColor" strokeWidth="1.5"/><rect x="11" y="11" width="5.5" height="5.5" rx="1.2" stroke="currentColor" strokeWidth="1.5"/></svg>
);
const MapViewIcon = () => (
  <svg viewBox="0 0 20 20" fill="none" width="15" height="15"><path d="M7 3.5L3 5v11.5l4-1.5 6 1.5 4-1.5V4l-4 1.5-6-1.5z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/><path d="M7 3.5v11.5M13 5v11.5" stroke="currentColor" strokeWidth="1.5"/></svg>
);

export default function PropertyListingPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const city = searchParams.get("city");
  const countryParam = searchParams.get("country");
  const universityParam = searchParams.get("university");
  const propertyParam = searchParams.get("property");
  const navigate = useNavigate();

  const { filters, setFilter, toggleAmenity, clearFilters } = useFilterState(searchParams, setSearchParams);

  const resolvedUniversity = useMemo(() => resolveCampusUniversityByNameOrId(universityParam), [universityParam]);

  // A search-bar `?property=` that didn't resolve to one exact slug (see
  // GlobalSearchBar/searchNavigation.js — an exact match goes straight to
  // /property/:slug instead) needs one lookup against the same search index
  // to find which city to load. Deliberately its own tiny effect, not part
  // of the main data-load effect below, so a slow/failed resolution never
  // blocks the (much more common) city/university/country paths.
  const [propertyResolution, setPropertyResolution] = useState(null);
  useEffect(() => {
    if (!propertyParam || city) { setPropertyResolution(null); return; }
    let cancelled = false;
    setPropertyResolution({ status: "loading" });
    fetch(`/api/search?q=${encodeURIComponent(propertyParam)}&limit=5`)
      .then((r) => r.json())
      .then((body) => {
        if (cancelled) return;
        const match = body?.data?.properties?.[0];
        if (match?.value?.city) setPropertyResolution({ status: "resolved", slug: match.slug, city: match.value.city, name: match.label });
        else setPropertyResolution({ status: "not_found" });
      })
      .catch(() => { if (!cancelled) setPropertyResolution({ status: "not_found" }); });
    return () => { cancelled = true; };
  }, [propertyParam, city]);

  // Grouped once from the static destinations list — no API call needed to
  // show "which countries/cities can I browse", only fetch real inventory
  // once a specific city is picked.
  const countryGroups = useMemo(() => {
    const map = new Map();
    DESTINATIONS.forEach((d) => {
      if (!map.has(d.country)) map.set(d.country, { country: d.country, flag: d.flag, cities: [] });
      map.get(d.country).cities.push(d);
    });
    return Array.from(map.values());
  }, []);
  const citiesInCountry = useMemo(
    () => (countryParam ? DESTINATIONS.filter((d) => d.country === countryParam) : []),
    [countryParam]
  );
  const popularCities = useMemo(
    () => POPULAR_CITY_NAMES.map((n) => findDestination(n)).filter(Boolean),
    []
  );

  const [destQuery, setDestQuery] = useState("");
  const filteredCountryGroups = useMemo(() => {
    const q = destQuery.trim().toLowerCase();
    if (!q) return countryGroups;
    return countryGroups.filter(
      (g) => countryFullName(g.country).toLowerCase().includes(q) || g.cities.some((c) => c.name.toLowerCase().includes(q))
    );
  }, [countryGroups, destQuery]);

  const [rawProperties, setRawProperties] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [descExpanded, setDescExpanded] = useState(false);
  const [mobileSheetOpen, setMobileSheetOpen] = useState(false);
  const [mobileSheetSection, setMobileSheetSection] = useState(null);
  const [mapSelectedId, setMapSelectedId] = useState(null);
  const [mapBoundsFilter, setMapBoundsFilter] = useState(null);
  const mapCardRefs = useRef({});

  // List/Grid/Map is URL-synced (?view=) so refresh/back-forward/share all
  // preserve it, same reasoning as the filter state above — "list" is the
  // implicit default and never appears in the URL, keeping ordinary links clean.
  const viewParam = searchParams.get("view");
  const view = viewParam === "map" || viewParam === "grid" ? viewParam : "list";
  function setView(next) {
    setSearchParams((prev) => {
      const next2 = new URLSearchParams(prev);
      if (next === "list") next2.delete("view");
      else next2.set("view", next);
      return next2;
    }, { replace: true });
  }

  // A bare country (no city/university/property) is a BROWSE affordance —
  // it should render instantly from the static destinations list, same as
  // the plain landing page, not gate on a network fetch. Real inventory for
  // that country still loads (see countryProperties below), just
  // progressively underneath the instant city picker rather than blocking
  // on it — a multi-city fan-out (getPropertiesForCountry) is inherently
  // slower than a single-city fetch, and making the whole page wait on it
  // was exactly what made "click a country" feel like a broken redirect.
  const isCountryBrowse = Boolean(countryParam && !city && !universityParam && !propertyParam);
  const hasActiveSearch = Boolean(city || universityParam || propertyParam);

  const [countryProperties, setCountryProperties] = useState([]);
  const [countryPropertiesLoading, setCountryPropertiesLoading] = useState(false);
  const [countryPropertiesError, setCountryPropertiesError] = useState(false);
  const [countryPropertiesRequested, setCountryPropertiesRequested] = useState(false);

  // Deliberately OPT-IN, not automatic on page load — a country page fans
  // out to several cities at once (see getPropertiesForCountry), which is
  // several real Amber requests. Auto-firing that on every country-browse
  // visit was real, unwanted Amber traffic for content the user may not
  // even scroll to; a click is an explicit signal they actually want it.
  // Resets whenever the country itself changes, so switching countries
  // doesn't show a stale country's properties or need a second click.
  useEffect(() => { setCountryPropertiesRequested(false); setCountryProperties([]); setCountryPropertiesError(false); }, [countryParam]);

  useEffect(() => {
    if (!isCountryBrowse || !countryPropertiesRequested) return;
    let cancelled = false;
    trackEvent("COUNTRY_SEARCHED", { country: countryParam, source: "listings-page" });
    setCountryPropertiesLoading(true);
    setCountryPropertiesError(false);
    const cityNames = DESTINATIONS.filter((d) => d.country === countryParam).map((d) => d.name);
    getPropertiesForCountry(cityNames, COUNTRY_SEARCH_MAX_CITIES, "listings-country")
      .then((breakdown) => {
        if (cancelled) return;
        setCountryProperties(safeListingList(breakdown.flatMap((b) => b.items)));
      })
      .catch(() => { if (!cancelled) setCountryPropertiesError(true); })
      .finally(() => { if (!cancelled) setCountryPropertiesLoading(false); });
    return () => { cancelled = true; };
  }, [isCountryBrowse, countryParam, countryPropertiesRequested]);

  useEffect(() => {
    if (!hasActiveSearch) {
      setLoading(false);
      setError(null);
      setRawProperties([]);
      return;
    }

    // A `?property=` search waits on the separate resolution effect above —
    // bail out without touching `loading` at all (rather than flipping it
    // true-then-false and back) so the skeleton doesn't flicker while that
    // lookup is still in flight; this effect re-runs once propertyResolution
    // actually changes.
    if (propertyParam && !city && (!propertyResolution || propertyResolution.status === "loading")) {
      return;
    }

    let cancelled = false;
    setMapBoundsFilter(null);
    setMapSelectedId(null);

    async function load() {
      setLoading(true);
      setError(null);
      try {
        if (city) {
          addRecentSearch(city);
          trackEvent("CITY_SEARCHED", { city, source: "listings-page" });
          // Mongo-first (see api/city-listings.js / getCityListings): reads
          // this site's already-indexed FULL city inventory — built up over
          // time from real traffic + the background full-catalog crawl —
          // instead of being capped at whatever one live, rate-limited Amber
          // call/page can return right now (confirmed live: Amber's own
          // location filter recognizes only a fraction of a big city's real
          // inventory, e.g. 38 of 200+ for London).
          const { residences } = await getCityListings(city, "MEDIUM", "listings-page");
          let listings = safeResidenceListingList(residences);

          // A brand-new city with nothing indexed yet at all (not "Amber's
          // filter under-recognizes it" — genuinely zero rows ever indexed)
          // — backfill known properties for the handful of cities where
          // that's confirmed, rather than showing an incorrect empty result.
          const curatedSlugs = listings.length === 0 ? CURATED_CITY_PROPERTIES[city.trim().toLowerCase()] : null;
          if (curatedSlugs?.length) {
            const curated = await Promise.all(curatedSlugs.map((slug) => getPropertyBySlug(slug).catch(() => null)));
            listings = safeListingList(curated.filter(Boolean));
          }
          if (!cancelled) setRawProperties(listings);
        } else if (universityParam) {
          if (!resolvedUniversity) {
            if (!cancelled) { setRawProperties([]); setError({ message: `We don't recognize "${universityParam}" yet — try its full name, or browse by city instead.` }); }
            return;
          }
          trackEvent("UNIVERSITY_SEARCHED", { university: resolvedUniversity.id, source: "listings-page" });
          // A university's accommodationOverride restricts its results to
          // specific known properties — same explicit business rule
          // UniversityHousingPage.js already enforces, reused here rather
          // than reimplemented so the two pages can never disagree about
          // which properties a university with an override should show.
          const overrideSlugs = resolvedUniversity?.accommodationOverride?.propertySlugs;
          if (Array.isArray(overrideSlugs) && overrideSlugs.length) {
            const items = await Promise.all(overrideSlugs.map((slug) => getPropertyBySlug(slug, "MEDIUM", "listings-university-override").catch(() => null)));
            if (!cancelled) setRawProperties(safeListingList(items.filter(Boolean)));
          } else {
            const data = await getProperties(resolvedUniversity.city, 1, 50, "MEDIUM", "listings-university");
            if (!cancelled) setRawProperties(safeListingList(Array.isArray(data) ? data : []));
          }
        } else if (propertyParam) {
          // The guard above this function already ensures propertyResolution
          // is settled (resolved or not_found) by the time we get here.
          if (propertyResolution.status !== "resolved") { if (!cancelled) setRawProperties([]); return; }
          trackEvent("PROPERTY_SEARCHED", { property: propertyParam, source: "listings-page" });
          const data = await getProperties(propertyResolution.city, 1, 50, "MEDIUM", "listings-property");
          if (!cancelled) setRawProperties(safeListingList(Array.isArray(data) ? data : []));
        }
      } catch (err) {
        if (!cancelled) {
          console.error("PropertyListingPage error:", err);
          setError(
            err && err.isRateLimit
              ? { isRateLimit: true, retryAfterSeconds: err.retryAfterSeconds }
              : { message: (err && err.message) || String(err) }
          );
          setRawProperties([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [city, universityParam, resolvedUniversity, propertyParam, propertyResolution, hasActiveSearch]);

  // `rawProperties` now always holds already-mapped "listing" shape objects
  // (each load() branch above maps at fetch time — via safeResidenceListingList
  // for the Mongo-backed city path, safeListingList for the raw-Amber paths)
  // so it's used directly here rather than re-mapped a second time.
  const baseListings = useMemo(() => (Array.isArray(rawProperties) ? rawProperties : []), [rawProperties]);

  // Real distance only when the resolved university has real coordinates —
  // never fabricated (same rule UniversityHousingPage/UniversityHousingMap
  // already enforce), and only computed when a university context is
  // actually active (a plain city/country search has no reference point).
  const listings = useMemo(() => {
    if (!resolvedUniversity || !hasValidCoords(resolvedUniversity.latitude, resolvedUniversity.longitude)) return baseListings;
    return baseListings.map((l) => {
      const propertyHasCoords = hasValidCoords(l.coordinates?.lat, l.coordinates?.lng);
      const distanceKm = propertyHasCoords
        ? Math.round(haversineKm(resolvedUniversity.latitude, resolvedUniversity.longitude, l.coordinates.lat, l.coordinates.lng) * 10) / 10
        : null;
      return { ...l, distanceKm };
    });
  }, [baseListings, resolvedUniversity]);

  const roomTypeOptions = useMemo(() => {
    const set = new Set();
    listings.forEach((l) => l.rooms.types.forEach((t) => set.add(t)));
    return Array.from(set).sort();
  }, [listings]);

  // Derived from each property's real nearby-places data — not hardcoded.
  const nearOptions = useMemo(() => {
    const set = new Set();
    listings.forEach((l) => l.distances.nearby.forEach((d) => {
      if (UNIVERSITY_RE.test(d.place)) set.add(d.place);
    }));
    return Array.from(set).sort();
  }, [listings]);

  // Derived from each property's real full amenity list, ranked by how common
  // they are across the current result set so the most useful ones surface first.
  const amenityOptions = useMemo(() => {
    const counts = new Map();
    listings.forEach((l) => (l.amenities.all || []).forEach((a) => counts.set(a, (counts.get(a) || 0) + 1)));
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, AMENITY_OPTION_LIMIT)
      .map(([name]) => name);
  }, [listings]);

  // Whether the current result set has ANY property with a real, stated pet
  // policy — same "only show a filter the current data can actually answer"
  // rule amenityOptions/nearOptions/etc. above already follow. Amber's own
  // amenity text for this is free-form (confirmed live: "Pet Friendly", "No
  // Pets Allowed", "Not Pet-Friendly", ... — 20+ real variants), so this
  // can't be a literal-string amenity checkbox like the generic ones above;
  // classifyPetPolicy normalizes all of them into just "allowed"/"not_allowed".
  const petPolicyAvailable = useMemo(
    () => listings.some((l) => classifyPetPolicy(l.amenities.all) != null),
    [listings]
  );

  const moveInOptions = useMemo(() => {
    const set = new Set();
    listings.forEach((l) => (l.moveInOptions || []).forEach((m) => set.add(m)));
    return Array.from(set).sort((a, b) => new Date(a) - new Date(b));
  }, [listings]);

  const stayDurationOptions = useMemo(() => {
    const set = new Set();
    listings.forEach((l) => (l.stayDurationOptions || []).forEach((d) => set.add(d)));
    return Array.from(set).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  }, [listings]);

  // Bounds/filter/sort all compare `priceWeekly` (amberMapper.js's
  // weekly-equivalent of price.from), not the raw amount — audit fix.
  // Listings genuinely bill in different periods (UK properties are usually
  // weekly, EU/Dubai ones often monthly), so comparing raw price.from mixed
  // a €900/month property (900) against a £200/week one (200) as if 900 were
  // the bigger number, when the monthly one is actually cheaper per week
  // (~£184-equivalent). Falls back to the raw amount only for the rare
  // unrankable-duration case (priceWeekly null — e.g. "term"/"semester"
  // billing, which has no real per-week conversion to fabricate).
  // Currency is NOT normalized the same way — there's no real FX rate in
  // this codebase to convert with, so mixed-currency comparison stays a
  // known, accepted limitation (see PriceRangeSlider.js's own header
  // comment), not something this fix invents an answer for.
  const priceBounds = useMemo(() => {
    const prices = listings.map((l) => l.priceWeekly ?? l.price.from).filter((p) => Number.isFinite(p));
    if (!prices.length) return { min: 0, max: 1000 };
    return { min: Math.floor(Math.min(...prices)), max: Math.ceil(Math.max(...prices)) };
  }, [listings]);
  const priceCurrency = useMemo(() => listings.find((l) => l.price.currency)?.price.currency || "£", [listings]);
  // Always "week" now — every value compared against priceBounds/filters is
  // a weekly-equivalent (or, for the rare unrankable case, the listing's own
  // raw amount/duration), so the slider must label what the numbers actually
  // mean rather than whichever duration the first listing happens to bill in.
  const priceDuration = "week";

  const sortOptions = useMemo(
    () => (resolvedUniversity && hasValidCoords(resolvedUniversity.latitude, resolvedUniversity.longitude)
      ? [...BASE_SORT_OPTIONS, DISTANCE_SORT_OPTION]
      : BASE_SORT_OPTIONS),
    [resolvedUniversity]
  );

  const destination = useMemo(() => findDestination(city), [city]);

  const pageContext = useMemo(() => {
    if (city) return { title: `Student Accommodation in ${city}`, breadcrumbLabel: city };
    if (universityParam) {
      return resolvedUniversity
        ? { title: `Student Accommodation near ${resolvedUniversity.name}`, breadcrumbLabel: resolvedUniversity.name }
        : { title: "Student Accommodation", breadcrumbLabel: universityParam };
    }
    if (propertyParam) return { title: `Results for "${propertyParam}"`, breadcrumbLabel: propertyParam };
    return null;
  }, [city, universityParam, resolvedUniversity, propertyParam]);

  const filtersActive =
    filters.query || filters.minPrice || filters.maxPrice || filters.roomType ||
    filters.billsOnly || filters.petPolicy || filters.near || filters.amenities.length > 0 ||
    filters.moveInMonth || filters.stayDuration || filters.sortBy !== "recommended";

  const advancedFilterCount =
    (filters.minPrice ? 1 : 0) + (filters.maxPrice ? 1 : 0) + (filters.roomType ? 1 : 0) +
    (filters.petPolicy ? 1 : 0) + (filters.near ? 1 : 0) + (filters.amenities.length > 0 ? 1 : 0) +
    (filters.moveInMonth ? 1 : 0) + (filters.stayDuration ? 1 : 0);

  const filteredListings = useMemo(() => {
    const q = (filters.query || "").toLowerCase().trim();
    const filtered = listings.filter((l) => {
      const haystack = [l.name, l.address.locality, l.address.country, ...l.distances.nearby.map((d) => d.place)]
        .join(" ")
        .toLowerCase();
      const textMatch = !q || haystack.includes(q);

      // Weekly-equivalent (see priceBounds above) — a raw price.from compare
      // here previously excluded genuinely-in-budget monthly-billed
      // properties (e.g. a real €900/month property, ~€184/week, wrongly
      // failing a maxPrice=300 filter meant as "≤£300/week" purely because
      // 900 &gt; 300 in raw terms).
      const price = l.priceWeekly ?? l.price.from ?? 0;
      const minOk = !filters.minPrice || price >= Number(filters.minPrice);
      const maxOk = !filters.maxPrice || price <= Number(filters.maxPrice);

      const roomTypeOk = !filters.roomType || l.rooms.types.includes(filters.roomType);
      const billsOk = !filters.billsOnly || l.billsIncluded;
      const nearOk = !filters.near || l.distances.nearby.some((d) => d.place === filters.near);
      const amenitiesOk = filters.amenities.every((a) => (l.amenities.all || []).includes(a));
      const petOk = !filters.petPolicy || classifyPetPolicy(l.amenities.all) === filters.petPolicy;
      const moveInOk = !filters.moveInMonth || (l.moveInOptions || []).includes(filters.moveInMonth);
      const stayDurationOk = !filters.stayDuration || (l.stayDurationOptions || []).includes(filters.stayDuration);

      return textMatch && minOk && maxOk && roomTypeOk && billsOk && petOk && nearOk && amenitiesOk && moveInOk && stayDurationOk;
    });

    const sorted = [...filtered];
    // Weekly-equivalent sort — see priceBounds' comment above. A raw
    // price.from sort previously ranked a €800/month property (800) behind a
    // £200/week one (200) even when the monthly property was actually
    // cheaper per week.
    if (filters.sortBy === "price_asc") sorted.sort((a, b) => (a.priceWeekly ?? a.price.from ?? Infinity) - (b.priceWeekly ?? b.price.from ?? Infinity));
    else if (filters.sortBy === "price_desc") sorted.sort((a, b) => (b.priceWeekly ?? b.price.from ?? -Infinity) - (a.priceWeekly ?? a.price.from ?? -Infinity));
    else if (filters.sortBy === "rating_desc") sorted.sort((a, b) => (b.rating?.overall ?? -1) - (a.rating?.overall ?? -1));
    else if (filters.sortBy === "distance") sorted.sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity));

    // Priority ranking (spec): an exact resolved property match floats to
    // the top regardless of sort — this IS the search result the user asked
    // for, everything else is context around it. A stable sort leaves every
    // other relative ordering untouched.
    if (propertyParam && propertyResolution?.status === "resolved" && propertyResolution.slug) {
      sorted.sort((a, b) => (a.slug === propertyResolution.slug ? -1 : 0) - (b.slug === propertyResolution.slug ? -1 : 0));
    }
    return sorted;
  }, [listings, filters, propertyParam, propertyResolution]);

  // "Search this area" (map view only) narrows the already-fetched result
  // set to the map's current visible bounds — see PropertyMap's own header
  // comment for why this is a client-side bounds filter rather than a new
  // geo-radius Amber query (Amber has no such endpoint).
  const boundsFilteredListings = useMemo(() => {
    if (!mapBoundsFilter) return filteredListings;
    return filteredListings.filter((l) => hasValidCoords(l.coordinates?.lat, l.coordinates?.lng) && mapBoundsFilter.contains([l.coordinates.lat, l.coordinates.lng]));
  }, [filteredListings, mapBoundsFilter]);

  // Marker click -> scroll the matching list card into view (list<->map
  // two-way sync, the other half — highlighting itself is the active-icon/
  // active-wrapper styling applied where each is rendered below).
  useEffect(() => {
    if (view !== "map" || mapSelectedId == null) return;
    const el = mapCardRefs.current[mapSelectedId];
    el?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [mapSelectedId, view]);

  const mapAnchor = useMemo(() => {
    if (!resolvedUniversity || !hasValidCoords(resolvedUniversity.latitude, resolvedUniversity.longitude)) return null;
    return { lat: resolvedUniversity.latitude, lng: resolvedUniversity.longitude, label: resolvedUniversity.name };
  }, [resolvedUniversity]);

  const handleEnquire = (listing) => {
    const params = new URLSearchParams({ inventory: listing.id, property: listing.name });
    navigate(`/contact?${params.toString()}`);
  };

  const closeDetails = (e) => e.target.closest("details")?.removeAttribute("open");

  function openMobileSheet(section) {
    setMobileSheetSection(section);
    setMobileSheetOpen(true);
  }

  return (
    <div className="properties-page-wrap">
      <div className="desktop-only">
        <SiteNavbar />
      </div>

      {!hasActiveSearch && !isCountryBrowse && (
        <div className="destination-browser">
          <div className="destination-browser-header">
            <p className="section-eyebrow">Find Rooms</p>
            <h1>Where are you headed?</h1>
            <p className="destination-browser-sub">
              Pick a country to see the cities we cover, then browse real, verified rooms — no enquiry needed to look.
            </p>
            <div className="destination-search-wrap">
              <svg className="destination-search-icon" viewBox="0 0 20 20" fill="none" width="19" height="19" aria-hidden="true">
                <circle cx="9" cy="9" r="6.2" stroke="currentColor" strokeWidth="1.8" />
                <path d="M13.6 13.6L17.5 17.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
              <input
                type="text"
                className="destination-search-input"
                placeholder="Search a country or city…"
                value={destQuery}
                onChange={(e) => setDestQuery(e.target.value)}
                aria-label="Search a country or city"
              />
              {destQuery && (
                <button
                  type="button"
                  className="destination-search-clear"
                  onClick={() => setDestQuery("")}
                  aria-label="Clear search"
                >
                  ×
                </button>
              )}
            </div>
          </div>

          <div className="destination-advisor-banner">
            <div>
              <strong>Not sure where to start?</strong>
              <span>Tell us your budget and course, and a real advisor will shortlist rooms for you — free.</span>
            </div>
            <Link to="/contact" className="btn btn-secondary" style={{ background: "rgba(255,255,255,0.14)", borderColor: "rgba(255,255,255,0.4)", color: "#fff" }}>
              Talk to an Advisor
            </Link>
          </div>

          {!destQuery && popularCities.length > 0 && (
            <div className="popular-cities-row">
              <span className="popular-cities-label">Popular right now</span>
              <div className="popular-cities-chips">
                {popularCities.map((c) => (
                  <Link key={c.name} to={`/properties?city=${encodeURIComponent(c.name)}`} className="popular-city-chip">
                    <span className="pill-flag" aria-hidden="true">
                      <img src={`https://flagcdn.com/${countryIsoCode(c.country).toLowerCase()}.svg`} alt="" loading="lazy" />
                    </span>
                    {c.name}
                  </Link>
                ))}
              </div>
            </div>
          )}

          {filteredCountryGroups.length > 0 ? (
            <div className="country-select-grid">
              {filteredCountryGroups.map((g) => (
                <Link
                  key={g.country}
                  to={{ search: `?country=${encodeURIComponent(g.country)}` }}
                  className="country-select-card"
                >
                  <div className="country-select-image">
                    <img src={g.cities[0]?.image} alt={countryFullName(g.country)} loading="lazy" />
                    <span className="country-select-flag" aria-hidden="true">
                      <img src={`https://flagcdn.com/${countryIsoCode(g.country).toLowerCase()}.svg`} alt="" loading="lazy" />
                    </span>
                  </div>
                  <div className="country-select-body">
                    <span className="country-select-name">{countryFullName(g.country)}</span>
                    <span className="country-select-count">{g.cities.length} {g.cities.length === 1 ? "city" : "cities"}</span>
                  </div>
                </Link>
              ))}
            </div>
          ) : (
            <div className="listings-empty">
              <p>No countries or cities match "{destQuery}".</p>
              <button type="button" className="toolbar-clear-btn" onClick={() => setDestQuery("")}>Clear search</button>
            </div>
          )}
        </div>
      )}
      {!hasActiveSearch && !isCountryBrowse && <TrustStrip />}

      {isCountryBrowse && (
        <div className="destination-browser country-browse">
          <nav aria-label="Breadcrumb" className="listings-breadcrumb">
            <Link to="/">Home</Link>
            <span>/</span>
            <span aria-current="page">{countryFullName(countryParam)}</span>
          </nav>
          <div className="destination-browser-header">
            <p className="section-eyebrow">{countryFullName(countryParam)}</p>
            <h1>Choose a city in {countryFullName(countryParam)}</h1>
          </div>

          {citiesInCountry.length > 0 ? (
            <ul className="country-cities-grid">
              {citiesInCountry.map((c) => <CityCard key={c.name} city={c} compact />)}
            </ul>
          ) : (
            <div className="listings-empty">
              <p>We don't have cities listed for this country yet.</p>
              <Link to="/properties" className="toolbar-clear-btn">Back to all countries</Link>
            </div>
          )}

          {/* Opt-in, not automatic — a country search fans out to several
              cities at once (see getPropertiesForCountry), which is several
              real Amber requests. This only fires on an explicit click, never
              just because the page loaded. */}
          <div className="country-properties-preview">
            <h3>Student accommodation across {countryFullName(countryParam)}</h3>
            {!countryPropertiesRequested && (
              <button type="button" className="btn btn-secondary" onClick={() => setCountryPropertiesRequested(true)}>
                Show properties across {countryFullName(countryParam)}
              </button>
            )}
            {countryPropertiesRequested && countryPropertiesLoading && (
              <div className="listings-map-loading">Loading properties…</div>
            )}
            {countryPropertiesRequested && !countryPropertiesLoading && countryPropertiesError && (
              <div className="listings-error"><strong>We couldn't load properties right now.</strong> Try a specific city above instead.</div>
            )}
            {countryPropertiesRequested && !countryPropertiesLoading && !countryPropertiesError && countryProperties.length === 0 && (
              <p className="listings-empty-hint">No properties found yet for this country's covered cities.</p>
            )}
            {countryPropertiesRequested && !countryPropertiesLoading && !countryPropertiesError && countryProperties.length > 0 && (
              <div className="listings-grid-view">
                {countryProperties.map((listing) => (
                  <CompactPropertyCard key={listing.id} listing={listing} />
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {hasActiveSearch && (
      <div className="listings-page">

        {/* MOBILE HEADER & FILTER PILLS */}
        <div className="mobile-only mobile-listings-header-wrap">
          <div className="mobile-listings-header">
            <button type="button" className="mobile-back-btn" onClick={() => navigate("/")}>
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 19l-7-7 7-7"/></svg>
            </button>
            <div className="mobile-search-box">
              <svg viewBox="0 0 20 20" fill="none" width="16" height="16"><circle cx="9" cy="9" r="6.2" stroke="currentColor" strokeWidth="1.8" /><path d="M13.6 13.6L17.5 17.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
              <input type="text" readOnly value={pageContext?.breadcrumbLabel || ""} />
              <button type="button" className="mobile-search-clear" onClick={() => navigate("/properties")}>×</button>
            </div>
            <button type="button" className="mobile-filter-btn" onClick={() => openMobileSheet(null)}>
              <FilterIcon />
            </button>
          </div>
          <div className="mobile-filter-pills">
            <button type="button" className="pill-btn" onClick={() => openMobileSheet("price")}>Price</button>
            <button type="button" className="pill-btn" onClick={() => openMobileSheet("roomType")}>Room Type</button>
            <button type="button" className="pill-btn" onClick={() => openMobileSheet("amenities")}>Amenities</button>
            <button type="button" className="pill-btn" onClick={() => openMobileSheet(null)}>More Filters</button>
            <button type="button" className={`pill-btn${view === "map" ? " active" : ""}`} onClick={() => setView(view === "map" ? "list" : "map")}>
              <MapViewIcon /> Map
            </button>
          </div>
        </div>

        {/* FILTER TOOLBAR (Desktop) */}
        <div className="listings-toolbar desktop-only">
          <input
            aria-label="Filter by property, area or university"
            placeholder="Filter by property, area or university"
            value={filters.query}
            onChange={(e) => setFilter("query")(e.target.value)}
            className="toolbar-search-input"
          />

          <details className="toolbar-dropdown">
            <summary><FilterIcon /> Filters{advancedFilterCount > 0 ? ` (${advancedFilterCount})` : ""}</summary>
            <div className="toolbar-panel">
              <div className="toolbar-panel-group">
                <span className="toolbar-panel-label">Budget</span>
                <PriceRangeSlider
                  min={priceBounds.min}
                  max={priceBounds.max}
                  valueMin={filters.minPrice ? Number(filters.minPrice) : null}
                  valueMax={filters.maxPrice ? Number(filters.maxPrice) : null}
                  currency={priceCurrency}
                  duration={priceDuration}
                  onChange={({ min, max }) => { setFilter("minPrice")(min); setFilter("maxPrice")(max); }}
                />
              </div>

              {nearOptions.length > 0 && (
                <div className="toolbar-panel-group">
                  <span className="toolbar-panel-label">University / Area</span>
                  <select value={filters.near} onChange={(e) => setFilter("near")(e.target.value)}>
                    <option value="">Anywhere</option>
                    {nearOptions.map((u) => <option key={u} value={u}>{u}</option>)}
                  </select>
                </div>
              )}

              {moveInOptions.length > 0 && (
                <div className="toolbar-panel-group">
                  <span className="toolbar-panel-label">Move-in Month</span>
                  <select value={filters.moveInMonth} onChange={(e) => setFilter("moveInMonth")(e.target.value)}>
                    <option value="">Any</option>
                    {moveInOptions.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                </div>
              )}

              {stayDurationOptions.length > 0 && (
                <div className="toolbar-panel-group">
                  <span className="toolbar-panel-label">Stay Duration</span>
                  <select value={filters.stayDuration} onChange={(e) => setFilter("stayDuration")(e.target.value)}>
                    <option value="">Any</option>
                    {stayDurationOptions.map((d) => <option key={d} value={d}>{d}</option>)}
                  </select>
                </div>
              )}

              {roomTypeOptions.length > 0 && (
                <div className="toolbar-panel-group">
                  <span className="toolbar-panel-label">Room Type</span>
                  <select value={filters.roomType} onChange={(e) => setFilter("roomType")(e.target.value)}>
                    <option value="">All room types</option>
                    {roomTypeOptions.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
              )}

              {(amenityOptions.length > 0 || petPolicyAvailable) && (
                <div className="toolbar-panel-group">
                  <span className="toolbar-panel-label">Amenities</span>
                  <div className="toolbar-amenity-list">
                    {petPolicyAvailable && (
                      <>
                        <label className="toolbar-amenity-item">
                          <input
                            type="checkbox"
                            checked={filters.petPolicy === "allowed"}
                            onChange={(e) => setFilter("petPolicy")(e.target.checked ? "allowed" : "")}
                          />
                          Pets Allowed
                        </label>
                        <label className="toolbar-amenity-item">
                          <input
                            type="checkbox"
                            checked={filters.petPolicy === "not_allowed"}
                            onChange={(e) => setFilter("petPolicy")(e.target.checked ? "not_allowed" : "")}
                          />
                          Pets Not Allowed
                        </label>
                      </>
                    )}
                    {amenityOptions.map((a) => (
                      <label key={a} className="toolbar-amenity-item">
                        <input type="checkbox" checked={filters.amenities.includes(a)} onChange={() => toggleAmenity(a)} />
                        {a}
                      </label>
                    ))}
                  </div>
                </div>
              )}

              <button type="button" className="toolbar-panel-apply" data-count={filteredListings.length} onClick={closeDetails}>Apply</button>
            </div>
          </details>

          <details className="toolbar-dropdown">
            <summary><SortIcon /> Sort: {sortOptions.find((o) => o.value === filters.sortBy)?.label || "Recommended"}</summary>
            <div className="toolbar-panel toolbar-sort-panel">
              {sortOptions.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  className={`toolbar-sort-option${filters.sortBy === o.value ? " active" : ""}`}
                  onClick={(e) => { setFilter("sortBy")(o.value); closeDetails(e); }}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </details>

          <label className="toolbar-checkbox">
            <input type="checkbox" checked={filters.billsOnly} onChange={(e) => setFilter("billsOnly")(e.target.checked)} />
            <ReceiptIcon /> Bills Included
          </label>

          {filtersActive && (
            <button type="button" className="toolbar-clear-btn" onClick={clearFilters}>
              Clear All
            </button>
          )}
        </div>

        {/* BREADCRUMB */}
        <nav aria-label="Breadcrumb" className="listings-breadcrumb">
          <Link to="/">Home</Link>
          {city && destination && <><span>/</span><span>{countryFullName(destination.country)}</span></>}
          <span>/</span>
          <span aria-current="page">{pageContext?.breadcrumbLabel || "All"}</span>
        </nav>

        {/* TITLE + COUNT + DESCRIPTION + VIEW TOGGLE */}
        <div className="listings-title-row">
          <div className="listings-title-col">
            <h1>
              {pageContext?.title || "Student Accommodation"}
              <span className="listings-count">
                {loading ? " — searching…" : ` | ${filteredListings.length} propert${filteredListings.length === 1 ? "y" : "ies"}`}
              </span>
            </h1>
            {city && destination?.description && (
              <p className={`listings-city-desc${descExpanded ? "" : " clamped"}`}>
                {destination.description}{" "}
                <button type="button" className="listings-desc-toggle" onClick={() => setDescExpanded((s) => !s)}>
                  {descExpanded ? "Show Less" : "Read More"}
                </button>
              </p>
            )}
          </div>

          <div className="view-toggle" role="group" aria-label="Switch between list, grid and map view">
            <button type="button" aria-pressed={view === "list"} className={view === "list" ? "active" : ""} onClick={() => setView("list")}>
              <ListViewIcon /> List
            </button>
            <button type="button" aria-pressed={view === "grid"} className={view === "grid" ? "active" : ""} onClick={() => setView("grid")}>
              <GridViewIcon /> Grid
            </button>
            <button type="button" aria-pressed={view === "map"} className={view === "map" ? "active" : ""} onClick={() => setView("map")}>
              <MapViewIcon /> Map
            </button>
          </div>
        </div>

        {view === "map" && (
          <div className="listings-map-layout">
            {error && (
              <div className="listings-error">
                {error.isRateLimit ? (
                  <>
                    <strong>We're briefly rate-limited.</strong> Please try again in about{" "}
                    {Math.ceil(error.retryAfterSeconds / 60)} minute
                    {Math.ceil(error.retryAfterSeconds / 60) === 1 ? "" : "s"}.
                  </>
                ) : (
                  <><strong>We couldn't load properties right now.</strong> {error.message}</>
                )}
              </div>
            )}
            {loading ? (
              <div className="listings-map-loading" aria-live="polite" aria-busy="true">Loading map…</div>
            ) : !error && (
              <>
                <div className="listings-map-list">
                  {/* Only shown once bounds-filtered — otherwise it would just
                      repeat the count the title row above already states. */}
                  {mapBoundsFilter && (
                    <div className="listings-map-list-count">
                      {boundsFilteredListings.length} propert{boundsFilteredListings.length === 1 ? "y" : "ies"} in this area
                    </div>
                  )}
                  {boundsFilteredListings.length === 0 ? (
                    <div className="listings-empty">
                      <p>No stays found</p>
                      <p className="listings-empty-hint">Nothing matches your filters in this area.</p>
                      {mapBoundsFilter && (
                        <button type="button" className="toolbar-clear-btn" onClick={() => setMapBoundsFilter(null)}>Reset map area</button>
                      )}
                    </div>
                  ) : boundsFilteredListings.map((listing) => (
                    <div key={listing.id} ref={(el) => { mapCardRefs.current[listing.id] = el; }}>
                      <MapListingRow
                        listing={listing}
                        active={String(listing.id) === String(mapSelectedId)}
                        onSelect={setMapSelectedId}
                      />
                    </div>
                  ))}
                </div>
                <div className="listings-map-panel">
                  <Suspense fallback={<div className="listings-map-loading">Loading map…</div>}>
                    <PropertyMap
                      anchor={mapAnchor}
                      properties={boundsFilteredListings}
                      selectedId={mapSelectedId}
                      onSelectProperty={setMapSelectedId}
                      onSearchThisArea={(bounds) => setMapBoundsFilter(bounds)}
                    />
                  </Suspense>
                  <button type="button" className="listings-map-close mobile-only" onClick={() => setView("list")}>
                    Close Map
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {view !== "map" && (
        <div className="listings-layout">
          <div className="listings-main">
            {error && (
              <div className="listings-error">
                {error.isRateLimit ? (
                  <>
                    <strong>We're briefly rate-limited.</strong> Please try again in about{" "}
                    {Math.ceil(error.retryAfterSeconds / 60)} minute
                    {Math.ceil(error.retryAfterSeconds / 60) === 1 ? "" : "s"}.
                  </>
                ) : (
                  <><strong>We couldn't load properties right now.</strong> {error.message}</>
                )}
              </div>
            )}

            {loading && (
              <div className={`listings-skeleton listings-skeleton--${view}`} aria-live="polite" aria-busy="true">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div className="listing-skeleton-card" key={i}>
                    <div className="listing-skeleton-image" />
                    <div className="listing-skeleton-body">
                      <div className="listing-skeleton-top">
                        <div className="listing-skeleton-top-text">
                          <div className="listing-skeleton-line" style={{ width: "72%", height: 16 }} />
                          <div className="listing-skeleton-line" style={{ width: "48%" }} />
                        </div>
                        <div className="listing-skeleton-rating" />
                      </div>

                      <div className="listing-skeleton-line" style={{ width: "60%" }} />

                      <div className="listing-skeleton-chips">
                        <span className="listing-skeleton-chip" style={{ width: 78 }} />
                        <span className="listing-skeleton-chip" style={{ width: 96 }} />
                      </div>

                      <div className="listing-skeleton-line" style={{ width: "40%" }} />

                      <div className="listing-skeleton-chips">
                        <span className="listing-skeleton-chip" />
                        <span className="listing-skeleton-chip" />
                        <span className="listing-skeleton-chip" />
                        <span className="listing-skeleton-chip" style={{ width: 48 }} />
                      </div>

                      <div className="listing-skeleton-footer">
                        <div className="listing-skeleton-price">
                          <div className="listing-skeleton-line" style={{ width: 36, height: 10 }} />
                          <div className="listing-skeleton-line" style={{ width: 84, height: 18 }} />
                        </div>
                        <div className="listing-skeleton-btn" />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {!loading && !error && propertyParam && propertyResolution?.status === "not_found" && (
              <div className="listings-empty">
                <p>We couldn't find a property matching "{propertyParam}" yet.</p>
                <p className="listings-empty-hint">It may not be in our search index yet — try its city or university instead.</p>
              </div>
            )}

            {!loading && !error && filteredListings.length === 0 && !(propertyParam && propertyResolution?.status === "not_found") && (
              <div className="listings-empty">
                <p>No stays found</p>
                <p className="listings-empty-hint">We couldn't find properties matching your search. Try:</p>
                <ul className="listings-empty-suggestions">
                  {(filters.minPrice || filters.maxPrice) && <li>expanding your budget</li>}
                  {filtersActive && <li>removing a filter</li>}
                  <li>searching another city</li>
                </ul>
                {filtersActive && (
                  <button type="button" className="toolbar-clear-btn" onClick={clearFilters}>
                    Clear Filters
                  </button>
                )}
              </div>
            )}

            {!loading && view === "list" && filteredListings.map((listing) => (
              <ListingCard key={listing.id} listing={listing} onEnquire={handleEnquire} />
            ))}

            {!loading && view === "grid" && (
              <div className="listings-grid-view">
                {filteredListings.map((listing) => (
                  <CompactPropertyCard key={listing.id} listing={listing} />
                ))}
              </div>
            )}

          </div>

          <aside className="listings-sidebar">
            {!loading && filteredListings.length > 0 && (
              <button type="button" className="explore-map-widget" onClick={() => setView("map")} aria-label="Explore properties on a map">
                <div className="explore-map-widget-preview">
                  <span className="explore-map-widget-pin explore-map-widget-pin--1">{priceCurrency}{Math.round(priceBounds.min)}</span>
                  <span className="explore-map-widget-pin explore-map-widget-pin--2">{priceCurrency}{Math.round((priceBounds.min + priceBounds.max) / 2)}</span>
                  <span className="explore-map-widget-pin explore-map-widget-pin--3">{priceCurrency}{Math.round(priceBounds.max)}</span>
                </div>
                <span className="explore-map-widget-label">
                  <MapViewIcon /> Explore on Map
                </span>
              </button>
            )}
            <div className="listings-sidebar-card">
              {USPS.map((u) => (
                <div className="listings-sidebar-row" key={u.key}>
                  {React.cloneElement(u.icon, { width: 22, height: 22 })}
                  <div>
                    <div className="listings-sidebar-title">{u.label}</div>
                    <div className="listings-sidebar-text">{u.sub}</div>
                  </div>
                </div>
              ))}
            </div>
          </aside>
        </div>
        )}
      </div>
      )}

      <MobileFilterSheet
        open={mobileSheetOpen}
        onClose={() => setMobileSheetOpen(false)}
        filters={filters}
        setFilter={setFilter}
        toggleAmenity={toggleAmenity}
        clearFilters={clearFilters}
        nearOptions={nearOptions}
        roomTypeOptions={roomTypeOptions}
        amenityOptions={amenityOptions}
        petPolicyAvailable={petPolicyAvailable}
        moveInOptions={moveInOptions}
        stayDurationOptions={stayDurationOptions}
        priceBounds={priceBounds}
        priceCurrency={priceCurrency}
        priceDuration={priceDuration}
        resultCount={filteredListings.length}
        initialFocusSection={mobileSheetSection}
      />

      {/* FOOTER (Desktop only for properties page) */}
      <div className="desktop-only">
        <SiteFooter />
      </div>

    </div>
  );
}
