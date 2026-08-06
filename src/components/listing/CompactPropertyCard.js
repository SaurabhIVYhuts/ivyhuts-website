import React from "react";
import { useNavigate } from "react-router-dom";
import PropertyImageGallery from "./PropertyImageGallery";

export default function CompactPropertyCard({ listing }) {
  const { name, address, images, price, rating, badges, slug } = listing;
  const safeAddress = address || {};
  const safePrice = price || { from: null };
  const safeBadges = badges || [];
  const navigate = useNavigate();

  const goToDetails = () => {
    if (slug) navigate(`/property/${encodeURIComponent(slug)}`);
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      goToDetails();
    }
  };

  return (
    <div
      className="chp-card"
      role="link"
      tabIndex={slug ? 0 : -1}
      aria-label={`View details for ${name}`}
      onClick={goToDetails}
      onKeyDown={handleKeyDown}
    >
      <PropertyImageGallery images={images} alt={name} badge={safeBadges[0]} />
      <div className="chp-body">
        <h3 className="chp-title">{name}</h3>
        <p className="chp-location">{[safeAddress.locality, safeAddress.country].filter(Boolean).join(", ")}</p>
        <div className="chp-footer">
          {safePrice.from !== null ? (
            <span className="chp-price">From {safePrice.currency}{safePrice.from}/{safePrice.duration || "wk"}</span>
          ) : (
            <span className="chp-price">Price on request</span>
          )}
          {rating && <span className="chp-rating">★ {rating.overall}</span>}
        </div>
      </div>
    </div>
  );
}