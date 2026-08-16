import React, { useMemo } from "react";
import { MapContainer, TileLayer, Marker, Popup, useMap } from "react-leaflet";
import L from "leaflet";
import { Link } from "react-router-dom";
import { Star } from "lucide-react";
import "leaflet/dist/leaflet.css";
import WishlistHeart from "../listing/WishlistHeart";
import { hasValidCoords } from "../../lib/geoDistance";

// Same provider/approach as the Student Planner's own map
// (src/components/planner/PlannerMap.js): react-leaflet + OpenStreetMap
// raster tiles, no API key, no per-marker network call — every coordinate
// here was already computed either by campusUniversities.json (university)
// or Amber's own location_coordinates field, surfaced additively via
// amberMapper.js's mapAmberPropertyToListing (properties). This component
// only draws them; it never fetches anything itself.
function buildIcon(emoji, variant) {
  const isInstitution = variant === "university" || variant === "school";
  return L.divIcon({
    className: `uh-map-divicon uh-map-divicon--${variant}`,
    html: `<span>${emoji}</span>`,
    iconSize: isInstitution ? [34, 34] : [28, 28],
    iconAnchor: isInstitution ? [17, 34] : [14, 28],
    popupAnchor: [0, -28],
  });
}
// Institution marker is emoji-differentiated by type ("SCHOOL" gets a school
// building, everything else — including an absent/unrecognized type, same
// "no implicit default" rule as the resolver — gets the graduation cap) but
// shares the same larger institution-marker size/style, visually distinct
// from residence pins either way (item 17/18).
const universityIcon = buildIcon("🎓", "university");
const schoolIcon = buildIcon("🏫", "school");
const propertyIcon = buildIcon("🏠", "property");
const propertyIconActive = buildIcon("🏠", "property-active");
const TYPE_LABELS = { UNIVERSITY: "University", SCHOOL: "School" };
function typeLabel(type) {
  return TYPE_LABELS[type] || TYPE_LABELS.UNIVERSITY;
}

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

export default function UniversityHousingMap({ university, properties, selectedId, onSelectProperty }) {
  const universityHasCoords = hasValidCoords(university?.latitude, university?.longitude);

  // Never fabricate a marker location — a property without real coordinates
  // simply isn't plotted; it still exists in the list panel.
  const plottable = useMemo(
    () => properties.filter((p) => hasValidCoords(p.coordinates?.lat, p.coordinates?.lng)),
    [properties]
  );

  const points = useMemo(() => [
    ...(universityHasCoords ? [[university.latitude, university.longitude]] : []),
    ...plottable.map((p) => [p.coordinates.lat, p.coordinates.lng]),
  ], [universityHasCoords, university, plottable]);

  const center = universityHasCoords
    ? [university.latitude, university.longitude]
    : plottable.length
      ? [plottable[0].coordinates.lat, plottable[0].coordinates.lng]
      : [51.5074, -0.1278]; // neutral fallback center only — never used as a fabricated pin, just where the empty map starts

  return (
    <div className="uh-map-shell">
      <MapContainer center={center} zoom={13} scrollWheelZoom={false} className="uh-map-leaflet">
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <FitBounds points={points} />

        {universityHasCoords && (
          <Marker position={[university.latitude, university.longitude]} icon={university.type === "SCHOOL" ? schoolIcon : universityIcon}>
            <Popup>
              <div className="uh-map-popup">
                <strong>{university.name}</strong>
                <span className="uh-map-popup-type">{typeLabel(university.type)}</span>
                <span>{university.address || [university.city, university.country].filter(Boolean).join(", ")}</span>
              </div>
            </Popup>
          </Marker>
        )}

        {plottable.map((p) => (
          <Marker
            key={p.id}
            position={[p.coordinates.lat, p.coordinates.lng]}
            icon={String(p.id) === String(selectedId) ? propertyIconActive : propertyIcon}
            eventHandlers={{ click: () => onSelectProperty?.(p.id) }}
          >
            <Popup>
              <div className="uh-map-popup uh-map-popup-property">
                {p.image && <img src={p.image} alt={p.name} className="uh-map-popup-image" loading="lazy" />}
                <strong>{p.name}</strong>
                <span>{p.address?.locality || university?.city}</span>
                <span className="uh-map-popup-row">
                  {p.isSoldOut ? (
                    <span className="uh-map-popup-soldout">Sold Out</span>
                  ) : (
                    p.price?.from != null && <>{p.price.currency}{p.price.from}{p.price.duration ? `/${p.price.duration}` : ""}</>
                  )}
                  {p.rating?.overall != null && (
                    <span className="uh-map-popup-rating"><Star size={12} fill="currentColor" /> {p.rating.overall}</span>
                  )}
                </span>
                {p.distanceKm != null && <span className="uh-map-popup-row">{p.distanceKm} km from {university?.name}</span>}
                <div className="uh-map-popup-actions">
                  {p.id != null && (
                    <WishlistHeart
                      property={{
                        propertyId: String(p.id),
                        slug: p.slug || null,
                        propertyName: p.name || null,
                        city: p.address?.locality || null,
                        image: p.image || null,
                        price: p.price?.from != null ? { amount: p.price.from, currency: p.price.currency || null } : null,
                      }}
                    />
                  )}
                  {p.slug ? (
                    <Link to={`/property/${encodeURIComponent(p.slug)}`} className="btn btn-outline btn-sm">View Property</Link>
                  ) : (
                    <Link to="/find-rooms" className="btn btn-outline btn-sm">Browse Rooms</Link>
                  )}
                </div>
              </div>
            </Popup>
          </Marker>
        ))}
      </MapContainer>
    </div>
  );
}
