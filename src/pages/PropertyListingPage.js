import React, { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { getProperties } from "../services/amberApi";
import { safeListingList } from "../services/amberMapper";
import { addRecentSearch } from "../services/recentActivity";
import { findDestination, countryFullName } from "../data/destinations";
import SiteNavbar from "../components/layout/SiteNavbar";
import SiteFooter from "../components/layout/SiteFooter";
import ListingCard from "../components/listing/ListingCard";
import CompactPropertyCard from "../components/listing/CompactPropertyCard";
import "./PropertyListingPage.css";

const EMPTY_FILTERS = {
  query: "", minPrice: "", maxPrice: "", roomType: "", billsOnly: false,
  university: "", amenities: [], sortBy: "recommended",
};

const SORT_OPTIONS = [
  { value: "recommended", label: "Recommended" },
  { value: "price_asc", label: "Price: Low to High" },
  { value: "price_desc", label: "Price: High to Low" },
  { value: "rating_desc", label: "Rating: High to Low" },
];

const UNIVERSITY_RE = /university|college/i;
const AMENITY_OPTION_LIMIT = 16;

export default function PropertyListingPage() {
  const [searchParams] = useSearchParams();
  const city = searchParams.get("city");
  const navigate = useNavigate();

  const [rawProperties, setRawProperties] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [view, setView] = useState("list");
  const [descExpanded, setDescExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      if (city) addRecentSearch(city);
      try {
        const data = await getProperties(city);
        if (!cancelled) setRawProperties(Array.isArray(data) ? data : []);
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
  }, [city]);

  const listings = useMemo(() => safeListingList(rawProperties), [rawProperties]);

  const roomTypeOptions = useMemo(() => {
    const set = new Set();
    listings.forEach((l) => l.rooms.types.forEach((t) => set.add(t)));
    return Array.from(set).sort();
  }, [listings]);

  // Derived from each property's real nearby-places data — not hardcoded.
  const universityOptions = useMemo(() => {
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

  const destination = useMemo(() => findDestination(city), [city]);

  const filtersActive =
    filters.query || filters.minPrice || filters.maxPrice || filters.roomType ||
    filters.billsOnly || filters.university || filters.amenities.length > 0 ||
    filters.sortBy !== "recommended";

  const advancedFilterCount =
    (filters.minPrice ? 1 : 0) + (filters.maxPrice ? 1 : 0) + (filters.roomType ? 1 : 0) +
    (filters.university ? 1 : 0) + (filters.amenities.length > 0 ? 1 : 0);

  const filteredListings = useMemo(() => {
    const q = (filters.query || "").toLowerCase().trim();
    const filtered = listings.filter((l) => {
      const haystack = [l.name, l.address.locality, l.address.country, ...l.distances.nearby.map((d) => d.place)]
        .join(" ")
        .toLowerCase();
      const textMatch = !q || haystack.includes(q);

      const price = l.price.from ?? 0;
      const minOk = !filters.minPrice || price >= Number(filters.minPrice);
      const maxOk = !filters.maxPrice || price <= Number(filters.maxPrice);

      const roomTypeOk = !filters.roomType || l.rooms.types.includes(filters.roomType);
      const billsOk = !filters.billsOnly || l.billsIncluded;
      const universityOk = !filters.university || l.distances.nearby.some((d) => d.place === filters.university);
      const amenitiesOk = filters.amenities.every((a) => (l.amenities.all || []).includes(a));

      return textMatch && minOk && maxOk && roomTypeOk && billsOk && universityOk && amenitiesOk;
    });

    const sorted = [...filtered];
    if (filters.sortBy === "price_asc") sorted.sort((a, b) => (a.price.from ?? Infinity) - (b.price.from ?? Infinity));
    else if (filters.sortBy === "price_desc") sorted.sort((a, b) => (b.price.from ?? -Infinity) - (a.price.from ?? -Infinity));
    else if (filters.sortBy === "rating_desc") sorted.sort((a, b) => (b.rating?.overall ?? -1) - (a.rating?.overall ?? -1));
    return sorted;
  }, [listings, filters]);

  const setFilter = (key) => (value) => setFilters((prev) => ({ ...prev, [key]: value }));

  const toggleAmenity = (amenity) => {
    setFilters((prev) => ({
      ...prev,
      amenities: prev.amenities.includes(amenity)
        ? prev.amenities.filter((a) => a !== amenity)
        : [...prev.amenities, amenity],
    }));
  };

  const handleEnquire = (listing) => {
    const params = new URLSearchParams({ inventory: listing.id, property: listing.name });
    navigate(`/contact?${params.toString()}`);
  };

  const closeDetails = (e) => e.target.closest("details")?.removeAttribute("open");

  return (
    <>
      <SiteNavbar />

      <div className="listings-page">
        {/* FILTER TOOLBAR */}
        <div className="listings-toolbar">
          <input
            aria-label="Filter by property, area or university"
            placeholder="Filter by property, area or university"
            value={filters.query}
            onChange={(e) => setFilter("query")(e.target.value)}
            className="toolbar-search-input"
          />

          <details className="toolbar-dropdown">
            <summary>Filters{advancedFilterCount > 0 ? ` (${advancedFilterCount})` : ""}</summary>
            <div className="toolbar-panel">
              <div className="toolbar-panel-group">
                <span className="toolbar-panel-label">Budget</span>
                <div className="toolbar-panel-row">
                  <input
                    aria-label="Minimum price"
                    placeholder="Min £"
                    inputMode="numeric"
                    value={filters.minPrice}
                    onChange={(e) => setFilter("minPrice")(e.target.value.replace(/[^0-9]/g, ""))}
                  />
                  <input
                    aria-label="Maximum price"
                    placeholder="Max £"
                    inputMode="numeric"
                    value={filters.maxPrice}
                    onChange={(e) => setFilter("maxPrice")(e.target.value.replace(/[^0-9]/g, ""))}
                  />
                </div>
              </div>

              {roomTypeOptions.length > 0 && (
                <div className="toolbar-panel-group">
                  <span className="toolbar-panel-label">Room Type</span>
                  <select value={filters.roomType} onChange={(e) => setFilter("roomType")(e.target.value)}>
                    <option value="">All room types</option>
                    {roomTypeOptions.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
              )}

              {universityOptions.length > 0 && (
                <div className="toolbar-panel-group">
                  <span className="toolbar-panel-label">University</span>
                  <select value={filters.university} onChange={(e) => setFilter("university")(e.target.value)}>
                    <option value="">All universities</option>
                    {universityOptions.map((u) => <option key={u} value={u}>{u}</option>)}
                  </select>
                </div>
              )}

              {amenityOptions.length > 0 && (
                <div className="toolbar-panel-group">
                  <span className="toolbar-panel-label">Amenities</span>
                  <div className="toolbar-amenity-list">
                    {amenityOptions.map((a) => (
                      <label key={a} className="toolbar-amenity-item">
                        <input type="checkbox" checked={filters.amenities.includes(a)} onChange={() => toggleAmenity(a)} />
                        {a}
                      </label>
                    ))}
                  </div>
                </div>
              )}

              <button type="button" className="toolbar-panel-apply" onClick={closeDetails}>Apply</button>
            </div>
          </details>

          <details className="toolbar-dropdown">
            <summary>Sort: {SORT_OPTIONS.find((o) => o.value === filters.sortBy)?.label}</summary>
            <div className="toolbar-panel toolbar-sort-panel">
              {SORT_OPTIONS.map((o) => (
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
            Bills Included
          </label>

          {filtersActive && (
            <button type="button" className="toolbar-clear-btn" onClick={() => setFilters(EMPTY_FILTERS)}>
              Clear All
            </button>
          )}
        </div>

        {/* BREADCRUMB */}
        <nav aria-label="Breadcrumb" className="listings-breadcrumb">
          <Link to="/">Home</Link>
          {destination && <><span>/</span><span>{countryFullName(destination.country)}</span></>}
          <span>/</span>
          <span aria-current="page">{city || "All"}</span>
        </nav>

        {/* TITLE + COUNT + DESCRIPTION + VIEW TOGGLE */}
        <div className="listings-title-row">
          <div className="listings-title-col">
            <h1>
              Student Accommodation in {city || "All Cities"}
              <span className="listings-count">
                {loading ? " — searching…" : ` | ${filteredListings.length} propert${filteredListings.length === 1 ? "y" : "ies"}`}
              </span>
            </h1>
            {destination?.description && (
              <p className={`listings-city-desc${descExpanded ? "" : " clamped"}`}>
                {destination.description}{" "}
                <button type="button" className="listings-desc-toggle" onClick={() => setDescExpanded((s) => !s)}>
                  {descExpanded ? "Show Less" : "Read More"}
                </button>
              </p>
            )}
          </div>

          <div className="view-toggle" role="group" aria-label="Switch between list and grid view">
            <button type="button" aria-pressed={view === "list"} className={view === "list" ? "active" : ""} onClick={() => setView("list")}>
              List
            </button>
            <button type="button" aria-pressed={view === "grid"} className={view === "grid" ? "active" : ""} onClick={() => setView("grid")}>
              Grid
            </button>
          </div>
        </div>

        <div className="listings-layout">
          <div className="listings-main">
            {error && (
              <div className="listings-error">
                {error.isRateLimit ? (
                  <>
                    <strong>We're fetching too fast.</strong> Amber is briefly limiting requests —
                    please try again in about {Math.ceil(error.retryAfterSeconds / 60)} minute
                    {Math.ceil(error.retryAfterSeconds / 60) === 1 ? "" : "s"}.
                  </>
                ) : (
                  <><strong>We couldn't load properties right now.</strong> {error.message}</>
                )}
              </div>
            )}

            {loading && (
              <div className="listings-loading">Loading properties…</div>
            )}

            {!loading && !error && filteredListings.length === 0 && (
              <div className="listings-empty">
                <p>No properties match your filters.</p>
                <button type="button" className="toolbar-clear-btn" onClick={() => setFilters(EMPTY_FILTERS)}>
                  Clear Filters
                </button>
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
            <div className="listings-sidebar-card">
              <button type="button" className="listings-sidebar-map-btn" disabled>
                Map Coming Soon
              </button>
              <div className="listings-sidebar-item">
                <div className="listings-sidebar-title">Lowest Price Guarantee</div>
                <div className="listings-sidebar-text">We find you the lowest available weekly price.</div>
              </div>
            </div>
            <div className="listings-sidebar-card">
              <div className="listings-sidebar-item">
                <div className="listings-sidebar-title">Verified Properties</div>
                <div className="listings-sidebar-text">Only verified listings shown.</div>
              </div>
              <div className="listings-sidebar-item">
                <div className="listings-sidebar-title">24/7 Support</div>
                <div className="listings-sidebar-text">Always here for you.</div>
              </div>
            </div>
          </aside>
        </div>
      </div>

      <SiteFooter />
    </>
  );
}