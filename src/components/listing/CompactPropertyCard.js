import React from "react";
import { useNavigate } from "react-router-dom";
import PropertyImageGallery from "./PropertyImageGallery";

export default function CompactPropertyCard({ listing }) {
  const { name, address, images, price, rating, badges, slug } = listing;
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
      <PropertyImageGallery images={images} alt={name} badge={badges[0]} />
      <div className="chp-body">
        <h3 className="chp-title">{name}</h3>
        <p className="chp-location">{[address.locality, address.country].filter(Boolean).join(", ")}</p>
        <div className="chp-footer">
          {price.from !== null ? (
            <span className="chp-price">From {price.currency}{price.from}/{price.duration || "wk"}</span>
          ) : (
            <span className="chp-price">Price on request</span>
          )}
          {rating && <span className="chp-rating">★ {rating.overall}</span>}
        </div>
      </div>
    </div>
  );
}