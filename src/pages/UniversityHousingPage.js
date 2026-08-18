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
import { getProperties, getPropertyBySlug, getCachedCityStats } from "../services/amberApi";
import { safeListingList } from "../services/amberMapper";
import { haversineKm, hasValidCoords } from "../lib/geoDistance";
import "./UniversityHousingPage.css";

const PAGE_LIMIT = 50;

// University -> City -> IVYHUTS properties in that city -> map. This page is
// deliberately a thin orchestration layer: it owns none of the property data
// itself. Every listing comes from the SAME existing Amber gateway every
// other page already uses (getProperties() -> /api/amber -> the one shared
// rate budget/cooldown/cache — see src/services/amberApi.js's own header),
// so this page can never become a second, uncoordinated source of Amber
// traffic. The only genuinely new data here is campusUniversities.json
// (a small, curated, non-Amber dataset — see src/lib/campusUniversityResolver.js).
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
  const [totalCount, setTotalCount] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [sortBy, setSortBy] = useState("distance");

  // Selecting a suggestion updates the URL (shareable link, item 17) without
  // a full page reload — React Router's setSearchParams is a client-side
  // history push, not a navigation. A Tier 2/3 (AI-discovered) selection
  // arrives with its full record already in hand (from
  // UniversitySearchBox.js's resolve/confirm response) — seed it directly so
  // the id-lookup effect above doesn't immediately re-fetch what we already have.
  const selectUniversity = (uni) => {
    if (!resolveCampusUniversityById(uni.id)) {
      resolvedForIdRef.current = uni.id;
      setDiscoveredUniversity(uni);
      setUniversityLookupState("idle");
    }
    setSearchParams({ university: uni.id });
  };
  const clearUniversity = () => {
    setSearchParams({});
    setDiscoveredUniversity(null);
    resolvedForIdRef.current = null;
    setUniversityLookupState("idle");
    setRawProperties([]);
    setTotalCount(null);
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

  // One request (or one small batch, for an override) per university/page —
  // no request loop, no per-marker fetch, no re-fetch on every render.
  // Re-selecting a university whose city/property was already fetched this
  // session costs zero new Amber calls: both getProperties() and
  // getPropertyBySlug() are backed by amberApi.js's own memory+IndexedDB
  // cache.
  useEffect(() => {
    if (!university) { setRawProperties([]); setTotalCount(null); return; }
    // A resolved university with no known city (rare — only possible for an
    // AI-assisted discovery whose Nominatim match had no city/town/village
    // in its address components) has nothing to search Amber for. Show the
    // "found, but no residences" state directly rather than attempting a
    // doomed fetch with an empty/undefined city.
    if (!university.city && !hasOverride) { setRawProperties([]); setTotalCount(0); setError(null); return; }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setPage(1);
    setTotalCount(null);
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
          setTotalCount(found.length);
          return;
        }
        const data = await getProperties(university.city, 1, PAGE_LIMIT, "MEDIUM", "university-housing");
        if (cancelled) return;
        setRawProperties(Array.isArray(data) ? data : []);
        // getProperties() already populated the city-stats cache entry from
        // this exact same response (see amberApi.js's rememberInventoryData)
        // — reading it back here is a cache-only lookup, not a second
        // network request, and gives the true city-wide count for the
        // "N properties found" line / "Load more" decision (item 10/19).
        const stats = await getCachedCityStats(university.city);
        if (!cancelled) setTotalCount(Number.isFinite(stats?.count) ? stats.count : null);
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
      if (more.length === 0) setTotalCount(rawProperties.length); // no more pages — the current count is the true total
    } catch (err) {
      // A failed "load more" must not lose what's already on screen.
    } finally {
      setLoadingMore(false); // always reset, even if stale — otherwise the NEW university's own loadMore stays permanently blocked
    }
  }, [university, page, loadingMore, hasOverride, rawProperties.length]);

  // Real distance only when BOTH the university and the property have real,
  // verified coordinates — never fabricated, never a city-centre guess.
  const properties = useMemo(() => {
    const listings = safeListingList(rawProperties);
    const universityHasCoords = hasValidCoords(university?.latitude, university?.longitude);
    return listings.map((p) => {
      const propertyHasCoords = hasValidCoords(p.coordinates?.lat, p.coordinates?.lng);
      const distanceKm = universityHasCoords && propertyHasCoords
        ? Math.round(haversineKm(university.latitude, university.longitude, p.coordinates.lat, p.coordinates.lng) * 10) / 10
        : null;
      return { ...p, distanceKm };
    });
  }, [rawProperties, university]);

  const sortedProperties = useMemo(() => {
    const sorted = [...properties];
    if (sortBy === "distance") {
      sorted.sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity));
    } else if (sortBy === "price_asc") {
      // priceWeekly (not price.from) — already availability-aware (a
      // sold-out property's cheapest room is never selected, see
      // amberMapper.js's normalizeResidencePricing/selectCheapestAvailableRoomType)
      // and duration-normalized so a monthly-priced property is never
      // ranked as if its raw number were a weekly one. A sold-out property
      // (priceWeekly: null) sorts to the end either direction, never
      // appearing as "cheapest".
      sorted.sort((a, b) => (a.priceWeekly ?? Infinity) - (b.priceWeekly ?? Infinity));
    } else if (sortBy === "price_desc") {
      sorted.sort((a, b) => (b.priceWeekly ?? -Infinity) - (a.priceWeekly ?? -Infinity));
    }
    return sorted;
  }, [properties, sortBy]);

  // Only a real, resolvable university unlocks distance-based sorting — an
  // unresolved page state has no reference point to sort against.
  useEffect(() => {
    if (!university && sortBy === "distance") setSortBy("price_asc");
  }, [university, sortBy]);

  const hasMore = !hasOverride && rawProperties.length > 0 && rawProperties.length % PAGE_LIMIT === 0 && (totalCount == null || rawProperties.length < totalCount);

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
            <p>Loading…</p>
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
                      : `${rawProperties.length}${hasMore ? "+" : ""} student propert${rawProperties.length === 1 ? "y" : "ies"} found in ${university.city}`}
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

            {!loading && !error && sortedProperties.length === 0 && (
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

            {!loading && !error && sortedProperties.length > 0 && (
              <div className="uh-split-layout">
                <PropertyListPanel
                  properties={sortedProperties}
                  selectedId={selectedId}
                  onSelectProperty={setSelectedId}
                  sortBy={sortBy}
                  onSortChange={setSortBy}
                  hasMore={hasMore}
                  loadingMore={loadingMore}
                  onLoadMore={loadMore}
                  university={university}
                />
                <UniversityHousingMap
                  university={university}
                  properties={sortedProperties}
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
