import React from "react";
import { Link } from "react-router-dom";
import { Star, MapPin } from "lucide-react";
import WishlistHeart from "../listing/WishlistHeart";

// A compact property row purpose-built for this page's list+map split view.
// Deliberately its own small component rather than reusing ListingCard.js
// (too large for a side-panel row) or repurposing CompactPropertyCard.js
// (whose whole card is a click-to-navigate link — this page needs a click
// to SELECT/highlight the matching map marker instead, with a separate
// explicit "View Property" action for navigation, per the map/list sync
// requirement). Every other piece is reused as-is: WishlistHeart (identical
// behavior to every other card in the app) and the existing
// /property/:slug route (no second property-detail implementation).
function PropertyRow({ property, active, onSelect }) {
  const { id, name, address, image, price, rating, badges, slug, distanceKm, isSoldOut } = property;

  const wishlistSnapshot = id != null ? {
    propertyId: String(id),
    slug: slug || null,
    propertyName: name || null,
    city: address?.locality || null,
    image: image || null,
    price: price?.from != null ? { amount: price.from, currency: price.currency || null } : null,
  } : null;

  return (
    <div
      className={`uh-property-row${active ? " uh-property-row--active" : ""}`}
      role="button"
      tabIndex={0}
      onClick={() => onSelect?.(id)}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect?.(id); } }}
      aria-pressed={active}
      aria-label={`Highlight ${name} on the map`}
    >
      <div className="uh-property-row-image">
        {image ? <img src={image} alt={name} loading="lazy" /> : <div className="uh-property-row-image-placeholder" />}
        {isSoldOut
          ? <span className="uh-property-row-badge uh-property-row-badge--soldout">Sold Out</span>
          : badges?.[0] && <span className="uh-property-row-badge">{badges[0]}</span>}
        {wishlistSnapshot && (
          <div className="uh-property-row-heart"><WishlistHeart property={wishlistSnapshot} /></div>
        )}
      </div>
      <div className="uh-property-row-body">
        <h4 className="uh-property-row-name">{name}</h4>
        <p className="uh-property-row-location"><MapPin size={12} /> {address?.locality || "—"}</p>
        {distanceKm != null && <p className="uh-property-row-distance">{distanceKm} km away</p>}
        <div className="uh-property-row-footer">
          <span className={`uh-property-row-price${isSoldOut ? " uh-property-row-price--soldout" : ""}`}>
            {isSoldOut
              ? "Sold Out"
              : price?.from != null
                ? <>From {price.currency}{price.from}{price.duration ? <span className="uh-property-row-duration">/{price.duration}</span> : null}</>
                : "Price on request"}
          </span>
          {rating?.overall != null && <span className="uh-property-row-rating"><Star size={12} fill="currentColor" /> {rating.overall}</span>}
        </div>
        {slug && (
          <Link to={`/property/${encodeURIComponent(slug)}`} className="btn btn-outline btn-sm uh-property-row-view" onClick={(e) => e.stopPropagation()}>
            View Property
          </Link>
        )}
      </div>
    </div>
  );
}

// Milestone 22: default kept as a fallback for any caller that doesn't pass
// its own `sortOptions` (none currently do — UniversityHousingPage.js always
// passes the shared BASE_SORT_OPTIONS/DISTANCE_SORT_OPTION list, matching
// Find Room's own sort menu) — never hardcode a second sort-option list.
const DEFAULT_SORT_OPTIONS = [
  { value: "recommended", label: "Recommended" },
  { value: "distance", label: "Distance from university" },
  { value: "price_asc", label: "Price: Low to High" },
  { value: "price_desc", label: "Price: High to Low" },
  { value: "rating_desc", label: "Rating: High to Low" },
];

export default function PropertyListPanel({
  properties, selectedId, onSelectProperty, sortBy, onSortChange, sortOptions,
  hasMore, loadingMore, onLoadMore, university,
}) {
  const options = sortOptions || DEFAULT_SORT_OPTIONS;
  return (
    <div className="uh-list-panel">
      <div className="uh-list-panel-toolbar">
        <span className="uh-list-panel-count">{properties.length} propert{properties.length === 1 ? "y" : "ies"}</span>
        <label className="uh-list-panel-sort">
          Sort
          <select value={sortBy} onChange={(e) => onSortChange(e.target.value)}>
            {options.filter((o) => o.value !== "distance" || university).map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="uh-list-panel-scroll">
        {properties.map((p) => (
          <PropertyRow
            key={p.id}
            property={p}
            active={String(p.id) === String(selectedId)}
            onSelect={onSelectProperty}
          />
        ))}
      </div>

      {hasMore && (
        <button type="button" className="btn btn-secondary uh-load-more" onClick={onLoadMore} disabled={loadingMore}>
          {loadingMore ? "Loading more…" : "Load more properties"}
        </button>
      )}
    </div>
  );
}
