import React, { useEffect, useRef } from "react";
import { X } from "lucide-react";
import PriceRangeSlider from "./PriceRangeSlider";
import "./MobileFilterSheet.css";

// The one mobile filter UI, bound to the EXACT same filters/setFilter/
// toggleAmenity/clearFilters the desktop toolbar uses (both come from
// PropertyListingPage's shared useFilterState hook) — no separate mobile
// filtering logic, which is what left the old mobile pills/inline block
// silently disconnected from real state. Every option list here (nearOptions/
// roomTypeOptions/amenityOptions/moveInOptions/stayDurationOptions) is
// derived from the ACTUAL current result set, same as the desktop toolbar —
// a section simply doesn't render if the current results have no data for it.
export default function MobileFilterSheet({
  open, onClose,
  filters, setFilter, toggleAmenity, clearFilters,
  nearOptions = [], roomTypeOptions = [], amenityOptions = [], moveInOptions = [], stayDurationOptions = [], petPolicyAvailable = false,
  priceBounds, priceCurrency = "", priceDuration = "",
  resultCount = 0,
  initialFocusSection = null,
}) {
  const sheetRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    if (initialFocusSection && sheetRef.current) {
      const el = sheetRef.current.querySelector(`[data-section="${initialFocusSection}"]`);
      if (el) el.scrollIntoView({ block: "start" });
    }
  }, [open, initialFocusSection]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="mfs-overlay" role="dialog" aria-modal="true" aria-label="Filters" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="mfs-sheet" ref={sheetRef}>
        <div className="mfs-header">
          <h2>Filters</h2>
          <button type="button" className="mfs-close" onClick={onClose} aria-label="Close filters">
            <X size={20} />
          </button>
        </div>

        <div className="mfs-body">
          {nearOptions.length > 0 && (
            <section className="mfs-section" data-section="near">
              <h3>University / Area</h3>
              <select value={filters.near} onChange={(e) => setFilter("near")(e.target.value)}>
                <option value="">Anywhere</option>
                {nearOptions.map((u) => <option key={u} value={u}>{u}</option>)}
              </select>
            </section>
          )}

          <section className="mfs-section" data-section="price">
            <h3>Budget</h3>
            <PriceRangeSlider
              min={priceBounds.min}
              max={priceBounds.max}
              valueMin={filters.minPrice ? Number(filters.minPrice) : null}
              valueMax={filters.maxPrice ? Number(filters.maxPrice) : null}
              currency={priceCurrency}
              duration={priceDuration}
              onChange={({ min, max }) => { setFilter("minPrice")(min); setFilter("maxPrice")(max); }}
            />
          </section>

          {moveInOptions.length > 0 && (
            <section className="mfs-section" data-section="moveIn">
              <h3>Move-in Month</h3>
              <select value={filters.moveInMonth} onChange={(e) => setFilter("moveInMonth")(e.target.value)}>
                <option value="">Any</option>
                {moveInOptions.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </section>
          )}

          {stayDurationOptions.length > 0 && (
            <section className="mfs-section" data-section="stayDuration">
              <h3>Stay Duration</h3>
              <select value={filters.stayDuration} onChange={(e) => setFilter("stayDuration")(e.target.value)}>
                <option value="">Any</option>
                {stayDurationOptions.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </section>
          )}

          {roomTypeOptions.length > 0 && (
            <section className="mfs-section" data-section="roomType">
              <h3>Room Type</h3>
              <select value={filters.roomType} onChange={(e) => setFilter("roomType")(e.target.value)}>
                <option value="">All room types</option>
                {roomTypeOptions.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </section>
          )}

          {(amenityOptions.length > 0 || petPolicyAvailable) && (
            <section className="mfs-section" data-section="amenities">
              <h3>Amenities</h3>
              <div className="mfs-amenity-grid">
                {petPolicyAvailable && (
                  <>
                    <label className="mfs-amenity-chip">
                      <input
                        type="checkbox"
                        checked={filters.petPolicy === "allowed"}
                        onChange={(e) => setFilter("petPolicy")(e.target.checked ? "allowed" : "")}
                      />
                      Pets Allowed
                    </label>
                    <label className="mfs-amenity-chip">
                      <input
                        type="checkbox"
                        checked={filters.petPolicy === "not_allowed"}
                        onChange={(e) => setFilter("petPolicy")(e.target.checked ? "not_allowed" : "")}
                      />
                      Pets Not Allowed
                    </label>
                  </>
                )}
                {amenityOptions.map((a) => (
                  <label key={a} className="mfs-amenity-chip">
                    <input type="checkbox" checked={filters.amenities.includes(a)} onChange={() => toggleAmenity(a)} />
                    {a}
                  </label>
                ))}
              </div>
            </section>
          )}

          <section className="mfs-section" data-section="bills">
            <label className="mfs-checkbox-row">
              <input type="checkbox" checked={filters.billsOnly} onChange={(e) => setFilter("billsOnly")(e.target.checked)} />
              Bills Included
            </label>
          </section>
        </div>

        <div className="mfs-footer">
          <button type="button" className="mfs-clear-btn" onClick={clearFilters}>Clear All</button>
          <button type="button" className="mfs-apply-btn" onClick={onClose}>
            Show {resultCount} Propert{resultCount === 1 ? "y" : "ies"}
          </button>
        </div>
      </div>
    </div>
  );
}
