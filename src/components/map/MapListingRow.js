import React from "react";
import { Link } from "react-router-dom";
import { Star, MapPin } from "lucide-react";
import WishlistHeart from "../listing/WishlistHeart";
import "./MapListingRow.css";

// A compact row purpose-built for the find-rooms map view's side list —
// the full ListingCard (built for a scannable full-width list/grid) is too
// tall/heavy once it's competing with a map for half the screen. Same
// pattern already proven for University Housing's own list+map split
// (src/components/universityHousing/PropertyListPanel.js's PropertyRow):
// clicking the row SELECTS/highlights the matching map marker, with a
// separate explicit "View Property" link for navigation — not a
// click-to-navigate card like CompactPropertyCard. Reuses WishlistHeart and
// the existing /property/:slug route as-is.
export default function MapListingRow({ listing, active, onSelect }) {
  const { id, name, address, image, price, rating, badges, slug, distanceKm, isSoldOut } = listing;

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
      className={`mlr-row${active ? " mlr-row--active" : ""}`}
      role="button"
      tabIndex={0}
      onClick={() => onSelect?.(id)}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect?.(id); } }}
      aria-pressed={active}
      aria-label={`Highlight ${name} on the map`}
    >
      <div className="mlr-image">
        {image ? <img src={image} alt={name} loading="lazy" /> : <div className="mlr-image-placeholder" />}
        {badges?.[0] && <span className="mlr-badge">{badges[0]}</span>}
        {wishlistSnapshot && <div className="mlr-heart"><WishlistHeart property={wishlistSnapshot} /></div>}
      </div>
      <div className="mlr-body">
        <h4 className="mlr-name">{name}</h4>
        <p className="mlr-location"><MapPin size={11} /> {address?.locality || "—"}</p>
        {distanceKm != null && <p className="mlr-distance">{distanceKm} km away</p>}
        <div className="mlr-footer">
          <span className="mlr-price">
            {isSoldOut ? (
              <span className="mlr-price--soldout">Sold Out</span>
            ) : price?.from != null ? (
              <>From {price.currency}{price.from}{price.duration ? <span className="mlr-duration">/{price.duration}</span> : null}</>
            ) : (
              "Price on request"
            )}
          </span>
          {rating?.overall != null && <span className="mlr-rating"><Star size={11} fill="currentColor" /> {rating.overall}</span>}
        </div>
        {slug && (
          <Link to={`/property/${encodeURIComponent(slug)}`} className="btn btn-outline btn-sm mlr-view" onClick={(e) => e.stopPropagation()}>
            View Property
          </Link>
        )}
      </div>
    </div>
  );
}
