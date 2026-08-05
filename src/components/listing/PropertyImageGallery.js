import React, { useState } from "react";

export default function PropertyImageGallery({ images, alt, badge }) {
  const [index, setIndex] = useState(0);

  if (!images || images.length === 0) {
    return (
      <div className="listing-card-image listing-card-image-empty">
        {badge ? <span className="listing-card-badge">{badge}</span> : null}
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
      {badge ? <span className="listing-card-badge">{badge}</span> : null}
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