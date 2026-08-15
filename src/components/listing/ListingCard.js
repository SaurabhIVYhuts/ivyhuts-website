import React from "react";
import { useNavigate } from "react-router-dom";
import PropertyImageGallery from "./PropertyImageGallery";
import WishlistHeart from "./WishlistHeart";
import ShareButton from "./ShareButton";

const AMENITY_LIMIT = 6;

const CheckBadgeIcon = () => (
  <svg viewBox="0 0 20 20" fill="none" width="11" height="11"><circle cx="10" cy="10" r="8.5" stroke="currentColor" strokeWidth="1.6"/><path d="M6.5 10.2l2.2 2.2 4.3-4.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>
);

export default function ListingCard({ listing, onEnquire }) {
  const { id, name, address, images, price, distances, amenities, badges, rooms, rating, social, slug } = listing;
  const navigate = useNavigate();

  const wishlistSnapshot = id != null ? {
    propertyId: String(id),
    slug: slug || null,
    propertyName: name || null,
    city: address?.locality || null,
    image: images?.[0]?.url || null,
    price: price?.from != null ? { amount: price.from, currency: price.currency || null } : null,
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

  const distanceLine = [
    distances.cityCentre ? `${distances.cityCentre} to city centre` : null,
    distances.nearby[0] ? `${distances.nearby[0].distance} to ${distances.nearby[0].place}` : null,
  ].filter(Boolean).join(" • ");
  const extraNearbyCount = Math.max(0, distances.nearby.length - 1);

  const roomLine = [
    rooms.count ? `${rooms.count} room option${rooms.count > 1 ? "s" : ""}` : null,
    ...rooms.types.slice(0, 2),
  ].filter(Boolean).join(" • ");

  return (
    <div
      className="listing-card"
      role="link"
      tabIndex={slug ? 0 : -1}
      aria-label={`View details for ${name}`}
      onClick={goToDetails}
      onKeyDown={handleKeyDown}
    >
      <PropertyImageGallery
        images={images}
        alt={name}
        badges={badges.slice(0, 2)}
      />

      <div className="listing-card-body">
        <div className="listing-card-top">
          <div>
            <h3 className="listing-card-title">{name}</h3>
            {address.full ? <p className="listing-card-address">{address.full}</p> : null}
          </div>
          {rating && (
            <div className="listing-card-rating" title="Average student rating">
              <span className="listing-card-rating-star">★</span>
              {rating.overall}
            </div>
          )}
        </div>

        {wishlistSnapshot && (
          <div className="listing-card-wishlist-row">
            {slug && (
              <ShareButton
                className="share-btn--on-light"
                url={`${window.location.origin}/property/${encodeURIComponent(slug)}`}
                title={name}
                text={`Check out ${name} on IVYhuts`}
              />
            )}
            <WishlistHeart property={wishlistSnapshot} className="wishlist-heart-btn--on-light" />
          </div>
        )}

        {distanceLine && (
          <div className="listing-card-distances">
            {distanceLine}
            {extraNearbyCount > 0 && <span className="listing-card-distances-more"> • +{extraNearbyCount} nearby</span>}
          </div>
        )}

        {badges.length > 2 && (
          <div className="listing-chip-row">
            {badges.slice(2, 5).map((b) => {
              const isCashback = b.toLowerCase().includes("cashback");
              return (
                <span key={b} className={`listing-chip ${isCashback ? "listing-chip-blue" : "listing-chip-green"}`}>
                  <CheckBadgeIcon /> {b}
                </span>
              );
            })}
          </div>
        )}

        {roomLine && <div className="listing-card-meta-row">{roomLine}</div>}

        {amenities.shown.length > 0 && (
          <div className="listing-chip-row">
            {amenities.shown.slice(0, AMENITY_LIMIT).map((a) => (
              <span key={a} className="listing-chip">{a}</span>
            ))}
            {(amenities.shown.length - AMENITY_LIMIT + amenities.moreCount) > 0 && (
              <span className="listing-chip listing-chip-more">
                +{amenities.shown.length - AMENITY_LIMIT + amenities.moreCount} more
              </span>
            )}
          </div>
        )}

        {social.shortlisted && <p className="listing-card-social">{social.shortlisted}</p>}

        <div className="listing-card-footer">
          <div className="listing-card-price">
            {price.from !== null ? (
              <>
                <span className="listing-price-label">From</span>
                <span className="listing-price-value">
                  {price.original && (
                    <span className="listing-price-original">
                      {price.currency}{price.original}
                    </span>
                  )}
                  {price.currency}{price.from}
                  {price.duration ? <span className="listing-price-duration"> / {price.duration}</span> : null}
                </span>
              </>
            ) : (
              <span className="listing-price-label">Price on request</span>
            )}
          </div>

          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={(e) => { e.stopPropagation(); onEnquire(listing); }}
          >
            Enquire
          </button>
        </div>
      </div>
    </div>
  );
}