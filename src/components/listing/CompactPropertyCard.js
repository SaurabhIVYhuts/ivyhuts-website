import React from "react";
import { useNavigate } from "react-router-dom";
import PropertyImageGallery from "./PropertyImageGallery";
import WishlistHeart from "./WishlistHeart";
import ShareButton from "./ShareButton";

export default function CompactPropertyCard({ listing }) {
  const { id, name, address, images, price, rating, badges, slug, isSoldOut } = listing;
  const safeAddress = address || {};
  const safePrice = price || { from: null };
  const safeBadges = badges || [];
  const navigate = useNavigate();

  const wishlistSnapshot = id != null ? {
    propertyId: String(id),
    slug: slug || null,
    propertyName: name || null,
    city: safeAddress.locality || null,
    image: images?.[0]?.url || null,
    price: safePrice.from != null ? { amount: safePrice.from, currency: safePrice.currency || null } : null,
  } : null;

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
      <div className="chp-image-container">
        <PropertyImageGallery
          images={images}
          alt={name}
          badges={safeBadges.slice(0, 2)}
        />
        {wishlistSnapshot && (
          <div className="chp-floating-heart">
            <WishlistHeart property={wishlistSnapshot} />
          </div>
        )}
        {slug && (
          <div className="chp-floating-share">
            <ShareButton
              url={`${window.location.origin}/property/${encodeURIComponent(slug)}`}
              title={name}
              text={`Check out ${name} on IVYhuts`}
            />
          </div>
        )}
      </div>
      <div className="chp-body">
        <h3 className="chp-title">{name}</h3>
        <p className="chp-location">{[safeAddress.locality, safeAddress.country].filter(Boolean).join(", ")}</p>
        <div className="chp-footer">
          {isSoldOut ? (
            <span className="chp-price chp-price--soldout">Sold Out</span>
          ) : safePrice.from !== null ? (
            <span className="chp-price">From <strong style={{color: '#000', fontSize: '1.05rem'}}>{safePrice.currency}{safePrice.from}</strong>/{safePrice.duration || "wk"}</span>
          ) : (
            <span className="chp-price">Price on request</span>
          )}
          {rating && <span className="chp-rating">★ {rating.overall}</span>}
        </div>
      </div>
    </div>
  );
}