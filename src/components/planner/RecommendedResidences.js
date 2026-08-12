import React from "react";
import ResidenceCard from "./ResidenceCard";

// Section 3 — ONLY the top 3-5 recommended residences. This is not the
// Listings page: no pagination, no filters, no full inventory dump.
export default function RecommendedResidences({ residences, city, status = "ready" }) {
  return (
    <section className="sp-section" aria-labelledby="sp-residences-heading">
      <div className="sp-section-head">
        <h2 id="sp-residences-heading" className="sp-section-title">Recommended Residences</h2>
        <p className="sp-section-sub">Your best-matched student residences near {city || "your university"}.</p>
      </div>
      {status === "ready" ? (
        <div className="sp-residence-grid">
          {residences.map((residence) => (
            <ResidenceCard key={residence.id} residence={residence} city={city} />
          ))}
        </div>
      ) : (
        <div className="sp-building-note">
          We're still building accommodation recommendations for {city || "this city"} — check back shortly.
        </div>
      )}
    </section>
  );
}
