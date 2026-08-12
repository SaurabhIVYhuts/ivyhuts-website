import React from "react";
import { Link } from "react-router-dom";
import { MapPin, Footprints, Star } from "lucide-react";

// Deliberately compact — NOT a replacement for ListingCard.js. No amenity
// list, no image gallery, no wishlist heart. Just enough to compare
// residences at a glance inside the planner report.
export default function ResidenceCard({ residence, city }) {
  const { name, image, price, distanceKm, walkingMinutes, rating, roomType, badge } = residence;

  return (
    <div className="sp-residence-card">
      <div className="sp-residence-card-image">
        <img src={image} alt={name} loading="lazy" />
        {badge && <span className="sp-residence-badge">{badge}</span>}
      </div>
      <div className="sp-residence-card-body">
        <h4 className="sp-residence-name">{name}</h4>

        <div className="sp-residence-meta-row">
          <span className="sp-residence-meta"><MapPin size={13} /> {distanceKm} km</span>
          <span className="sp-residence-meta"><Footprints size={13} /> {walkingMinutes} min walk</span>
        </div>

        <div className="sp-residence-meta-row">
          <span className="sp-residence-room-type">{roomType}</span>
          {rating?.overall != null && (
            <span className="sp-residence-rating"><Star size={13} fill="currentColor" /> {rating.overall}</span>
          )}
        </div>

        <div className="sp-residence-footer">
          <span className="sp-residence-price">
            {price.currency}{price.amount}
            <span className="sp-residence-price-duration">/{price.duration}</span>
          </span>
          {/* Mock slug — not real inventory, so this points at the working
              /find-rooms search instead of the 404-prone /property/:slug.
              Swap to `Link to={`/property/${residence.slug}`}` once a real
              accommodation index backs the planner. */}
          <Link to={`/find-rooms?city=${encodeURIComponent(city || "")}`} className="btn btn-outline btn-sm">
            View
          </Link>
        </div>
      </div>
    </div>
  );
}
