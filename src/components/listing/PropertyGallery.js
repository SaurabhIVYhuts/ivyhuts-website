import React, { useState } from "react";

const THUMB_LIMIT = 6;

export default function PropertyGallery({ images, videos, alt }) {
  const [index, setIndex] = useState(0);

  if (!images || images.length === 0) {
    return <div className="pg-empty">No photos available for this property yet.</div>;
  }

  const current = images[Math.min(index, images.length - 1)];
  const thumbs = images.slice(0, THUMB_LIMIT);
  const extraCount = Math.max(0, images.length - THUMB_LIMIT);

  const go = (delta) => setIndex((prev) => (prev + delta + images.length) % images.length);

  return (
    <div className="pg">
      <div className="pg-main">
        <img src={current.url} alt={current.caption || alt} loading="eager" />
        {images.length > 1 && (
          <>
            <button type="button" className="pg-nav pg-nav-prev" aria-label="Previous photo" onClick={() => go(-1)}>‹</button>
            <button type="button" className="pg-nav pg-nav-next" aria-label="Next photo" onClick={() => go(1)}>›</button>
            <span className="pg-counter">{index + 1} / {images.length}</span>
          </>
        )}
      </div>

      {thumbs.length > 1 && (
        <div className="pg-thumbs">
          {thumbs.map((img, i) => (
            <button
              type="button"
              key={img.url}
              className={`pg-thumb${i === index ? " active" : ""}`}
              onClick={() => setIndex(i)}
              aria-label={`View photo ${i + 1}`}
            >
              <img src={img.url} alt="" loading="lazy" />
              {i === THUMB_LIMIT - 1 && extraCount > 0 && (
                <span className="pg-thumb-more">+{extraCount}</span>
              )}
            </button>
          ))}
        </div>
      )}

      {videos && videos.length > 0 && (
        <div className="pg-videos">
          <span className="pg-videos-label">Videos</span>
          <div className="pg-videos-row">
            {videos.map((v) => (
              <a
                key={v.path}
                href={v.path}
                target="_blank"
                rel="noopener noreferrer"
                className="pg-video-link"
              >
                {v.thumbnail_url ? (
                  <img src={v.thumbnail_url} alt={v.caption || "Property video"} loading="lazy" />
                ) : (
                  <span className="pg-video-fallback">▶</span>
                )}
                <span className="pg-video-play">▶</span>
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
