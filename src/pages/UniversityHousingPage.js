import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { GraduationCap, MapPin, ArrowRight } from "lucide-react";
import SiteNavbar from "../components/layout/SiteNavbar";
import SiteFooter from "../components/layout/SiteFooter";
import UniversitySearchBox from "../components/universityHousing/UniversitySearchBox";
import UniversityHousingMap from "../components/universityHousing/UniversityHousingMap";
import PropertyListPanel from "../components/universityHousing/PropertyListPanel";
import { resolveCampusUniversityById } from "../lib/campusUniversityResolver";
import { resolveUniversityById as resolveDiscoveredUniversityById } from "../services/universityDiscoveryApi";
import { getProperties, getPropertyBySlug, getUniversityHousingInventory } from "../services/amberApi";
import { safeListingList, safeResidenceListingList } from "../services/amberMapper";
import { haversineKm, hasValidCoords } from "../lib/geoDistance";
import { applyListingFilters, sortListings, deriveFilterOptions } from "../lib/listingFilters";
import useFilterState from "../hooks/useFilterState";
import PriceRangeSlider from "../components/filters/PriceRangeSlider";
import "./UniversityHousingPage.css";

// Milestone 22 (IVYHUTS_MILESTONE_22_UNIVERSITY_HOUSING_CANONICAL_UI.md):
// same BASE_SORT_OPTIONS/DISTANCE_SORT_OPTION split PropertyListingPage.js
// already uses — "distance" only makes sense (and is only offered) once a
// real anchor point (the resolved university's coordinates) exists.
const BASE_SORT_OPTIONS = [
  { value: "recommended", label: "Recommended" },
  { value: "price_asc", label: "Price: Low to High" },
  { value: "price_desc", label: "Price: High to Low" },
  { value: "rating_desc", label: "Rating: High to Low" },
];
const DISTANCE_SORT_OPTION = { value: "distance", label: "Distance from University" };

const PAGE_LIMIT = 50;

// University -> City -> IVYHUTS properties in that city -> map. This page is
// deliberately a thin orchestration layer: it owns none of the property data
// itself.
//
// Milestone 9 (IVYHUTS_MILESTONE_9_UNIVERSITY_HOUSING_MIGRATION_REPORT.md):
// normal (non-override) property discovery now reads the CANONICAL Mongo
// inventory (getUniversityHousingInventory() -> /api/university-housing/inventory
// -> api/_lib/accommodationInventoryService.js -> the same Mongo-first,
// controlled-refresh path Find Room's ?city= browse already uses) rather
// than a live Amber call per search — a normal city search now makes ZERO
// Amber listing requests. Amber remains reachable, unchanged, ONLY for: the
// per-university `accommodationOverride` slug list below (getPropertyBySlug,
// unrelated to general discovery) and the site-wide background refresh
// pipeline (cacheWarmer.js/attemptCityRefresh, entirely server-side). The
// only genuinely new NON-Amber data here is campusUniversities.json (a
// small, curated dataset — see src/lib/campusUniversityResolver.js).
export default function UniversityHousingPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const universityId = searchParams.get("university");

  // Resolving a URL's ?university=<id> now has two paths: Tier 1 (static
  // campusUniversities.json) resolves synchronously with zero I/O, exactly
  // as before. An id that ISN'T in Tier 1 may still be a real,
  // previously-discovered Tier 2/3 university (AI-assisted discovery — see
  // api/_lib/universityResolveService.js) whose canonicalId only exists in
  // the backend's discovery database, so that case falls through to one lookup call. Either way the
  // selection itself (clicking a search result) already has the full
  // record in hand via onSelect — this effect only exists for shareable
  // links / page reloads where only the id survives in the URL.
  const tier1University = useMemo(() => resolveCampusUniversityById(universityId), [universityId]);
  const [discoveredUniversity, setDiscoveredUniversity] = useState(null);
  const [universityLookupState, setUniversityLookupState] = useState("idle"); // idle | loading | not_found
  const university = tier1University || discoveredUniversity;
  // Tracks which id `discoveredUniversity` was resolved FOR — lets a
  // just-completed search/select seed this state directly (see
  // selectUniversity below) without the effect below immediately re-fetching
  // the exact same record it was just handed for free.
  const resolvedForIdRef = useRef(null);

  useEffect(() => {
    if (!universityId || tier1University) {
      setDiscoveredUniversity(null);
      setUniversityLookupState("idle");
      resolvedForIdRef.current = null;
      return;
    }
    if (resolvedForIdRef.current === universityId) return; // already have it — selectUniversity seeded it directly
    let cancelled = false;
    setDiscoveredUniversity(null);
    setUniversityLookupState("loading");
    resolveDiscoveredUniversityById(universityId).then((record) => {
      if (cancelled) return;
      if (record) {
        resolvedForIdRef.current = universityId;
        setDiscoveredUniversity(record);
        setUniversityLookupState("idle");
      } else {
        setUniversityLookupState("not_found");
      }
    });
    return () => { cancelled = true; };
  }, [universityId, tier1University]);

  const [rawProperties, setRawProperties] = useState([]);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const [selectedId, setSelectedId] = useState(null);

  // Milestone 22: filter state (query/price/roomType/etc.) is now the SAME
  // URL-backed hook Find Room already uses — one canonical filtering model,
  // not a second implementation (IVYHUTS_MILESTONE_22_UNIVERSITY_HOUSING_CANONICAL_UI.md).
  // toggleAmenity intentionally not destructured yet — no amenities filter
  // control exists on this page in this pass (see Milestone 22 report's
  // "remaining gaps"); applyListingFilters()/useFilterState() already fully
  // support it, so wiring an amenities checkbox list later needs no further
  // plumbing beyond destructuring it here.
  const { filters, setFilter, clearFilters } = useFilterState(searchParams, setSearchParams);

  // Selecting a suggestion updates the URL (shareable link, item 17) without
  // a full page reload — React Router's setSearchParams is a client-side
  // history push, not a navigation. A Tier 2/3 (AI-discovered) selection
  // arrives with its full record already in hand (from
  // UniversitySearchBox.js's resolve/confirm response) — seed it directly so
  // the id-lookup effect above doesn't immediately re-fetch what we already have.
  //
  // Merges into the existing params (rather than replacing them wholesale)
  // so an active filter isn't silently discarded just because the user
  // picked a different university — same "never silently discard user
  // intent" rule the rest of this codebase already follows.
  const selectUniversity = (uni) => {
    if (!resolveCampusUniversityById(uni.id)) {
      resolvedForIdRef.current = uni.id;
      setDiscoveredUniversity(uni);
      setUniversityLookupState("idle");
    }
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("university", uni.id);
      return next;
    });
  };
  const clearUniversity = () => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete("university");
      return next;
    });
    setDiscoveredUniversity(null);
    resolvedForIdRef.current = null;
    setUniversityLookupState("idle");
    setRawProperties([]);
    setSelectedId(null);
  };

  // A university's `accommodationOverride` (see campusUniversities.json /
  // campusUniversityResolver.js) is an explicit business rule — this
  // university's accommodation results must be ONLY these specific
  // properties, never a generic city-wide search. When present, fetch each
  // one directly by its known slug via getPropertyBySlug() — the SAME
  // function/cache PropertyDetailPage.js already uses (mirrors
  // api/_lib/accommodationIndex.js's getOverrideResidences() on the backend)
  // — instead of getProperties(city), so the result can never accidentally
  // include another Hatfield property just because it also appeared on
  // page 1 of the city listing.
  const overrideSlugs = university?.accommodationOverride?.propertySlugs;
  const hasOverride = Array.isArray(overrideSlugs) && overrideSlugs.length > 0;

  // Milestone 9: normal (non-override) property discovery now reads the
  // canonical Mongo inventory (getUniversityHousingInventory() ->
  // /api/university-housing/inventory -> accommodationInventoryService.js's
  // getCityInventory() -> the same Mongo-first, controlled-refresh path
  // Find Room's ?city= browse already relies on) instead of a live Amber
  // call — see IVYHUTS_MILESTONE_9_UNIVERSITY_HOUSING_MIGRATION_REPORT.md.
  // A normal city search now makes ZERO Amber listing requests; any refresh
  // this city needs happens via the existing background/bounded-first-look
  // mechanism inside the canonical service, entirely server-side. The
  // override branch below is UNCHANGED — an explicit, curated per-university
  // property allowlist is a different concept from general city discovery
  // and was never part of the pagination/rate-limit problem this migration
  // fixes (see the migration report's own scope note).
  useEffect(() => {
    if (!university) { setRawProperties([]); return; }
    // A resolved university with no known city (rare — only possible for an
    // AI-assisted discovery whose Nominatim match had no city/town/village
    // in its address components) has nothing to search Amber for. Show the
    // "found, but no residences" state directly rather than attempting a
    // doomed fetch with an empty/undefined city.
    if (!university.city && !hasOverride) { setRawProperties([]); setError(null); return; }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setPage(1);
    setSelectedId(null);

    (async () => {
      try {
        if (hasOverride) {
          // Per-slug .catch (audit fix, matches PropertyListingPage.js's own
          // override-fetch pattern) — one property removed/renamed on Amber
          // used to fail the whole Promise.all and show a generic error
          // banner instead of the other still-valid override properties.
          const items = await Promise.all(
            overrideSlugs.map((slug) => getPropertyBySlug(slug, "MEDIUM", "university-housing-override").catch(() => null))
          );
          if (cancelled) return;
          const found = items.filter(Boolean);
          setRawProperties(found);
          return;
        }
        const data = await getUniversityHousingInventory(university.city, "MEDIUM", "university-housing");
        if (cancelled) return;
        const residences = Array.isArray(data?.residences) ? data.residences : [];
        setRawProperties(residences);
      } catch (err) {
        if (cancelled) return;
        setError(err && err.isRateLimit
          ? { isRateLimit: true, retryAfterSeconds: err.retryAfterSeconds }
          : { message: (err && err.message) || String(err) });
        setRawProperties([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [university, hasOverride, overrideSlugs]);

  // Mirrors the `cancelled` flag the main fetch effect above uses — loadMore
  // is a separate async flow with no such guard of its own (audit fix). A
  // real race: click "Load more" for University A, then switch to
  // University B before A's page-2 request resolves. The main effect
  // correctly discards A's response once cancelled, replacing rawProperties
  // with B's page-1 data — but A's un-guarded loadMore would still land
  // afterward and merge INTO whatever rawProperties currently holds (B's
  // properties), silently attaching University A's properties under
  // University B's label, with distances computed against B's coordinates.
  const universityRef = useRef(university);
  useEffect(() => { universityRef.current = university; }, [university]);

  // Milestone 9: "Load more" no longer has anything further to fetch for
  // the normal (canonical-inventory) path — getUniversityHousingInventory()
  // already returns the city's COMPLETE known inventory in one response,
  // unlike the old page-limited live Amber call this replaced. Kept as a
  // real, working function (not deleted — this milestone is a data-path
  // migration, not a UI redesign) so the override-branch's old page-based
  // Amber path remains available if ever needed, but `hasMore` (below) now
  // always evaluates false for both branches, so the "Load more" button
  // never renders and this never actually runs in normal operation.
  const loadMore = useCallback(async () => {
    if (!university || loadingMore || hasOverride) return; // a fixed override list has no further pages to load
    const requestedUniversity = university;
    const nextPage = page + 1;
    setLoadingMore(true);
    try {
      const data = await getProperties(university.city, nextPage, PAGE_LIMIT, "LOW", "university-housing-load-more");
      if (universityRef.current !== requestedUniversity) return; // university changed mid-flight — discard, same as the main effect's `cancelled` guard
      const more = Array.isArray(data) ? data : [];
      setRawProperties((prev) => {
        const seen = new Set(prev.map((r) => r?.id ?? r?.canonical_name));
        const merged = [...prev];
        more.forEach((r) => { const key = r?.id ?? r?.canonical_name; if (key != null && !seen.has(key)) { seen.add(key); merged.push(r); } });
        return merged;
      });
      setPage(nextPage);
    } catch (err) {
      // A failed "load more" must not lose what's already on screen.
    } finally {
      setLoadingMore(false); // always reset, even if stale — otherwise the NEW university's own loadMore stays permanently blocked
    }
  }, [university, page, loadingMore, hasOverride]);

  // Real distance only when BOTH the university and the property have real,
  // verified coordinates — never fabricated, never a city-centre guess.
  // Milestone 9: the override branch still holds raw Amber items
  // (safeListingList, unchanged); the normal branch now holds canonical
  // Mongo residence docs, mapped via safeResidenceListingList — the SAME
  // output shape (see src/services/amberMapper.js), so every consumer below
  // (sorting, distance, cards, map) needs zero further changes.
  const properties = useMemo(() => {
    const listings = hasOverride ? safeListingList(rawProperties) : safeResidenceListingList(rawProperties);
    const universityHasCoords = hasValidCoords(university?.latitude, university?.longitude);
    return listings.map((p) => {
      const propertyHasCoords = hasValidCoords(p.coordinates?.lat, p.coordinates?.lng);
      const distanceKm = universityHasCoords && propertyHasCoords
        ? Math.round(haversineKm(university.latitude, university.longitude, p.coordinates.lat, p.coordinates.lng) * 10) / 10
        : null;
      return { ...p, distanceKm };
    });
  }, [rawProperties, university, hasOverride]);

  const universityHasCoords = hasValidCoords(university?.latitude, university?.longitude);

  // Only a real, resolvable university with coordinates unlocks
  // distance-based sorting — an unresolved/coordinate-less state has no
  // reference point to sort against, same rule PropertyListingPage.js's own
  // sortOptions already follows.
  const sortOptions = useMemo(
    () => (universityHasCoords ? [...BASE_SORT_OPTIONS, DISTANCE_SORT_OPTION] : BASE_SORT_OPTIONS),
    [universityHasCoords]
  );

  // Milestone 22: this page's own historical default was "distance" (its
  // one and only sort mode before this milestone) whenever a real anchor
  // point exists — preserved here as an EFFECTIVE default rather than a
  // URL write, so a shared/bookmarked link with no explicit ?sortBy= still
  // opens sorted by distance, without this page silently overriding a URL
  // the user (or Find Room's own default "recommended") explicitly set.
  const effectiveSortBy = filters.sortBy !== "recommended" ? filters.sortBy : (universityHasCoords ? "distance" : "recommended");

  // Milestone 22: filtering + sorting now delegate to the shared
  // src/lib/listingFilters.js module — the exact same predicate/comparators
  // Find Room uses, so the two pages can never silently disagree about what
  // "matches this filter" means.
  const filteredProperties = useMemo(
    () => sortListings(applyListingFilters(properties, filters), effectiveSortBy),
    [properties, filters, effectiveSortBy]
  );

  const filterOptions = useMemo(() => deriveFilterOptions(properties), [properties]);
  const filtersActive =
    filters.query || filters.minPrice || filters.maxPrice || filters.roomType ||
    filters.billsOnly || filters.near || filters.amenities.length > 0 ||
    filters.moveInMonth || filters.stayDuration || filters.sortBy !== "recommended";
  const priceBounds = useMemo(() => {
    const prices = properties.map((l) => l.priceWeekly ?? l.price?.from).filter((p) => Number.isFinite(p));
    if (!prices.length) return { min: 0, max: 1000 };
    return { min: Math.floor(Math.min(...prices)), max: Math.ceil(Math.max(...prices)) };
  }, [properties]);
  const priceCurrency = useMemo(() => properties.find((l) => l.price?.currency)?.price.currency || "£", [properties]);

  // Milestone 9: canonical inventory (the normal, non-override path) always
  // returns a city's COMPLETE known dataset in one response — there is no
  // further page to load, so "Load more" never has anything to do and
  // deliberately never renders. The override path already had no further
  // pages either (a fixed slug list). Both cases: hasMore is always false.
  const hasMore = false;

  return (
    <div className="uh-page">
      <SiteNavbar />

      <main className="uh-main">
        <div className="uh-hero">
          <p className="uh-eyebrow">Housing to Hiring</p>
          <h1 className="uh-hero-title">Find Your Student Home</h1>
          <p className="uh-hero-sub">Choose your university or school and discover every IVYHUTS property around your new city.</p>
          <div className="uh-search-wrap">
            <UniversitySearchBox selected={university} onSelect={selectUniversity} onClear={clearUniversity} autoFocus />
          </div>
        </div>

        {universityLookupState === "loading" && (
          <div className="uh-empty-state" aria-live="polite" aria-busy="true">
            <GraduationCap size={32} />
            <p>Locating university…</p>
          </div>
        )}

        {universityLookupState === "not_found" && (
          <div className="uh-empty-state">
            <GraduationCap size={32} />
            <p>We couldn't find that university or school link — it may be out of date. Search again below, or browse every city we cover.</p>
            <Link to="/find-rooms" className="btn btn-secondary">Browse All Cities</Link>
          </div>
        )}

        {!university && universityLookupState === "idle" ? (
          <div className="uh-empty-state">
            <GraduationCap size={32} />
            <p>Search for your university or school above to see accommodation nearby — or browse every city we cover.</p>
            <Link to="/find-rooms" className="btn btn-secondary">Browse All Cities</Link>
          </div>
        ) : university ? (
          <>
            <div className="uh-university-info">
              <div className="uh-university-info-body">
                <h2>{university.name} <span className="uh-university-info-type">{university.type === "SCHOOL" ? "School" : "University"}</span></h2>
                <p><MapPin size={14} /> {university.address || [university.city, university.country].filter(Boolean).join(", ") || "Location on map below"}</p>
              </div>
              <p className="uh-university-info-count">
                {loading
                  ? "Finding nearby accommodation…"
                  : error
                    ? "Unable to load properties right now."
                    : !university.city
                      ? "No IVYHUTS properties mapped to this location yet."
                      : `${filteredProperties.length}${hasMore ? "+" : ""} student propert${filteredProperties.length === 1 ? "y" : "ies"} found${filtersActive ? "" : ` in ${university.city}`}`}
              </p>
            </div>

            {error && (
              <div className="uh-error-banner">
                {error.isRateLimit ? (
                  <>We're briefly rate-limited — please try again in about {Math.ceil(error.retryAfterSeconds / 60)} minute{Math.ceil(error.retryAfterSeconds / 60) === 1 ? "" : "s"}.</>
                ) : (
                  <>We couldn't load properties right now. {error.message}</>
                )}
              </div>
            )}

            {loading && (
              <div className="uh-loading-skeleton" aria-live="polite" aria-busy="true">
                <div className="uh-loading-skeleton-map" />
                <div className="uh-loading-skeleton-list">
                  {Array.from({ length: 4 }).map((_, i) => <div key={i} className="uh-loading-skeleton-row" />)}
                </div>
              </div>
            )}

            {!loading && !error && properties.length === 0 && (
              <div className="uh-split-layout uh-split-layout-empty">
                <div className="uh-empty-state">
                  <p>{university.city
                    ? `We don't currently have properties in ${university.city}.`
                    : "This location isn't near any IVYHUTS city yet — but here's where it is:"}</p>
                  <Link to="/find-rooms" className="btn btn-secondary">Browse Other Cities</Link>
                </div>
                <UniversityHousingMap
                  university={university}
                  properties={[]}
                  selectedId={null}
                  onSelectProperty={() => {}}
                />
              </div>
            )}

            {/* Milestone 22: filter toolbar — only shown once there's real
                inventory to filter, reuses the shared filter model/URL state
                Find Room already relies on so the two pages can never drift. */}
            {!loading && !error && properties.length > 0 && (
              <div className="uh-filter-toolbar">
                <input
                  type="text"
                  className="uh-filter-search"
                  placeholder="Filter by property or area"
                  value={filters.query}
                  onChange={(e) => setFilter("query")(e.target.value)}
                  aria-label="Filter by property or area"
                />
                <PriceRangeSlider
                  min={priceBounds.min}
                  max={priceBounds.max}
                  valueMin={filters.minPrice ? Number(filters.minPrice) : null}
                  valueMax={filters.maxPrice ? Number(filters.maxPrice) : null}
                  currency={priceCurrency}
                  duration="week"
                  onChange={({ min, max }) => { setFilter("minPrice")(min); setFilter("maxPrice")(max); }}
                />
                {filterOptions.roomTypeOptions.length > 0 && (
                  <select value={filters.roomType} onChange={(e) => setFilter("roomType")(e.target.value)} aria-label="Room type">
                    <option value="">All room types</option>
                    {filterOptions.roomTypeOptions.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                )}
                <label className="uh-filter-checkbox">
                  <input type="checkbox" checked={filters.billsOnly} onChange={(e) => setFilter("billsOnly")(e.target.checked)} />
                  Bills Included
                </label>
                {filtersActive && (
                  <button type="button" className="btn btn-outline btn-sm" onClick={clearFilters}>Clear Filters</button>
                )}
              </div>
            )}

            {!loading && !error && properties.length > 0 && filteredProperties.length === 0 && (
              <div className="uh-split-layout uh-split-layout-empty">
                <div className="uh-empty-state">
                  <p>No properties match your filters.</p>
                  <button type="button" className="btn btn-secondary" onClick={clearFilters}>Clear Filters</button>
                </div>
                <UniversityHousingMap university={university} properties={[]} selectedId={null} onSelectProperty={() => {}} />
              </div>
            )}

            {!loading && !error && filteredProperties.length > 0 && (
              <div className="uh-split-layout">
                <PropertyListPanel
                  properties={filteredProperties}
                  selectedId={selectedId}
                  onSelectProperty={setSelectedId}
                  sortBy={effectiveSortBy}
                  onSortChange={setFilter("sortBy")}
                  sortOptions={sortOptions}
                  hasMore={hasMore}
                  loadingMore={loadingMore}
                  onLoadMore={loadMore}
                  university={university}
                />
                <UniversityHousingMap
                  university={university}
                  properties={filteredProperties}
                  selectedId={selectedId}
                  onSelectProperty={setSelectedId}
                />
              </div>
            )}

            <div className="uh-back-link">
              <Link to="/find-rooms">
                Looking for a different city? Browse all IVYHUTS destinations <ArrowRight size={14} />
              </Link>
            </div>
          </>
        ) : null}
      </main>

      <SiteFooter />
    </div>
  );
}
