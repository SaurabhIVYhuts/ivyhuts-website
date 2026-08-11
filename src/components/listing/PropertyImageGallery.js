import React, { useState } from "react";

const VerifiedIcon = () => (
  <svg viewBox="0 0 20 20" fill="none" width="11" height="11"><circle cx="10" cy="10" r="8.5" stroke="currentColor" strokeWidth="1.6"/><path d="M6.5 10.2l2.2 2.2 4.3-4.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>
);

// `badge` (single string) is kept for back-compat; `badges` (array, up to 2)
// is the preferred prop and takes priority when both are passed.
// The wishlist heart used to render here as a top-right image overlay; it
// now lives in the card body instead (ListingCard/CompactPropertyCard,
// below the rating), so this component no longer takes a wishlist prop.
export default function PropertyImageGallery({ images, alt, badge, badges, showVerified = true }) {
  const [index, setIndex] = useState(0);
  const shownBadges = (badges && badges.length ? badges : badge ? [badge] : []).slice(0, 2);

  const badgeRow = shownBadges.length > 0 && (
    <div className="listing-card-badge-row">
      {shownBadges.map((b) => <span key={b} className="listing-card-badge">{b}</span>)}
    </div>
  );
  const verifiedBadge = showVerified && (
    <span className="listing-card-badge listing-card-badge-verified"><VerifiedIcon /> Verified</span>
  );
  const rightOverlay = verifiedBadge && (
    <div className="listing-card-right-overlay">
      {verifiedBadge}
    </div>
  );

  if (!images || images.length === 0) {
    return (
      <div className="listing-card-image">
        {badgeRow}
        {rightOverlay}
        <div className="listing-card-image-empty">
          <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="3" y="5" width="18" height="14" rx="2" />
            <circle cx="8.5" cy="10" r="1.5" />
            <path d="M21 15l-5-5-9 9" />
          </svg>
          <span>Photo unavailable</span>
        </div>
      </div>
    );
  }

  const showControls = images.length > 1;
  const current = images[Math.min(index, images.length - 1)];

  const go = (delta) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIndex((prev) => (prev + delta + images.length) % images.length);
  };

  return (
    <div className="listing-card-image">
      {badgeRow}
      {rightOverlay}
      <img src={current.url} alt={alt} loading="lazy" />
      {showControls && (
        <>
          <button
            type="button"
            aria-label="Previous image"
            className="listing-gallery-nav listing-gallery-prev"
            onClick={go(-1)}
          >
            ‹
          </button>
          <button
            type="button"
            aria-label="Next image"
            className="listing-gallery-nav listing-gallery-next"
            onClick={go(1)}
          >
            ›
          </button>
          <div className="listing-gallery-dots">
            {images.map((img, i) => (
              <span
                key={img.url}
                className={`listing-gallery-dot${i === index ? " active" : ""}`}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}