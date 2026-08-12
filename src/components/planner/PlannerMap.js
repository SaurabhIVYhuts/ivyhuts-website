import React, { useMemo } from "react";
import { MapContainer, TileLayer, Marker, Popup, useMap } from "react-leaflet";
import L from "leaflet";
import { Link } from "react-router-dom";
import { Star } from "lucide-react";
import "leaflet/dist/leaflet.css";

// Section 4 (Milestone 4) — the real interactive map, replacing
// PlannerMapPlaceholder.js. Consumes ONLY the { university, residences }
// props already present on plannerResult — no fetch, no Amber, no
// /api/student-planner call, no AccommodationResidence import. Every
// coordinate rendered here was already computed server-side by
// accommodationIndex.js (residence.latitude/longitude) or
// src/data/universities.json (university.latitude/longitude); this
// component's only job is to draw them.
//
// Provider: react-leaflet + OpenStreetMap raster tiles (via leaflet, no API
// key). Chosen over Google/Mapbox because: no key/billing setup, no
// per-marker or per-geocode network call (tiles are fetched by z/x/y, not
// per marker — matches item 10's "no per-marker API calls" requirement
// exactly), OSM's tile usage policy allows this kind of light, cacheable
// traffic for free, and ODbL only requires the standard "© OpenStreetMap
// contributors" attribution already wired into the TileLayer below. If
// traffic ever grows past what OSM's fair-use tile policy comfortably
// supports, swap the TileLayer `url`/`attribution` for a paid tile host
// (MapTiler/Stadia/Mapbox) — no other code in this file would need to change.
function hasCoords(lat, lng) {
    return Number.isFinite(lat) && Number.isFinite(lng);
}

// Custom divIcon (not L.Icon/L.marker's default PNG) — sidesteps the
// well-known webpack/CRA broken-default-marker-image issue entirely, and
// lets the university pin be visually distinct from residence pins at a
// glance (item 8), matching the emoji vocabulary the rest of the planner
// page already uses.
function buildIcon(emoji, variant) {
    return L.divIcon({
        className: `sp-map-divicon sp-map-divicon--${variant}`,
        html: `<span>${emoji}</span>`,
        iconSize: variant === "university" ? [34, 34] : [28, 28],
        iconAnchor: variant === "university" ? [17, 34] : [14, 28],
        popupAnchor: [0, -28],
    });
}
const universityIcon = buildIcon("🎓", "university");
const residenceIcon = buildIcon("🏠", "residence");

// Fits the view to every marker actually being shown, run once per
// (university, residences) change — not a per-render effect loop.
function FitBounds({ points }) {
    const map = useMap();
    useMemo(() => {
        if (points.length === 1) {
            map.setView(points[0], 14);
        } else if (points.length > 1) {
            map.fitBounds(L.latLngBounds(points), { padding: [32, 32], maxZoom: 15 });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [JSON.stringify(points)]);
    return null;
}

export default function PlannerMap({ university, residences, status = "ready" }) {
    const universityHasCoords = hasCoords(university?.latitude, university?.longitude);
    // Never fabricate a location: a residence without real lat/lng is simply
    // not plotted (item 9) — it still exists in the cards/table above, just
    // not on this map.
    const plottableResidences = status === "ready" ? residences.filter((r) => hasCoords(r.latitude, r.longitude)) : [];

    const points = [
        ...(universityHasCoords ? [[university.latitude, university.longitude]] : []),
        ...plottableResidences.map((r) => [r.latitude, r.longitude]),
    ];

    return (
        <section className="sp-section" aria-labelledby="sp-map-heading">
            <div className="sp-section-head">
                <h2 id="sp-map-heading" className="sp-section-title">Where You'd Live</h2>
                <p className="sp-section-sub">University and recommended residences, at a glance.</p>
            </div>

            {!universityHasCoords ? (
                <div className="sp-map-unavailable">
                    Map unavailable — we don't have verified coordinates for {university?.name || "this university"} yet.
                </div>
            ) : (
                <div className="sp-map-shell">
                    <MapContainer
                        center={[university.latitude, university.longitude]}
                        zoom={14}
                        scrollWheelZoom={false}
                        className="sp-map-leaflet"
                    >
                        <TileLayer
                            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                        />
                        <FitBounds points={points} />

                        <Marker position={[university.latitude, university.longitude]} icon={universityIcon}>
                            <Popup>
                                <div className="sp-map-popup">
                                    <strong>{university.name || "University"}</strong>
                                    <span>{[university.city, university.country].filter(Boolean).join(", ")}</span>
                                </div>
                            </Popup>
                        </Marker>

                        {plottableResidences.map((r) => (
                            <Marker key={r.id} position={[r.latitude, r.longitude]} icon={residenceIcon}>
                                <Popup>
                                    <div className="sp-map-popup">
                                        <strong>{r.name}</strong>
                                        <span className="sp-map-popup-row">
                                            {r.distanceKm != null && <>{r.distanceKm} km away</>}
                                        </span>
                                        <span className="sp-map-popup-row">
                                            {r.price?.amount != null && <>{r.price.currency}{r.price.amount}/{r.price.duration}</>}
                                            {r.rating?.overall != null && (
                                                <span className="sp-map-popup-rating"><Star size={12} fill="currentColor" /> {r.rating.overall}</span>
                                            )}
                                        </span>
                                        {r.slug ? (
                                            <Link to={`/property/${r.slug}`} className="btn btn-outline btn-sm">View Residence</Link>
                                        ) : (
                                            <Link to="/find-rooms" className="btn btn-outline btn-sm">View Residence</Link>
                                        )}
                                    </div>
                                </Popup>
                            </Marker>
                        ))}
                    </MapContainer>
                </div>
            )}

            {status !== "ready" && universityHasCoords && (
                <p className="sp-building-note sp-map-building-note">Residence pins will appear once recommendations are ready.</p>
            )}
            {status === "ready" && universityHasCoords && plottableResidences.length === 0 && residences.length > 0 && (
                <p className="sp-map-note">None of your recommended residences have verified coordinates yet — see the cards above for details.</p>
            )}
        </section>
    );
}
