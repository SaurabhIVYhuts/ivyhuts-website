import React, { useEffect, useMemo, useRef } from "react";
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

// A property whose real distance from the university is beyond this radius
// no longer counts toward the initial viewport — it's still plotted (never
// hidden), it just can't drag the map out to country/continent level to fit
// it. 15km comfortably covers a real city's own spread (confirmed against
// this session's own city data: Manchester/Barcelona/etc. properties
// typically sit within a few km of the city centre) without being so tight
// that legitimate same-city properties get excluded from the initial fit.
const NEARBY_RADIUS_KM = 15;

// Keyed ONLY on a per-university identity (id/name + its own coordinates),
// never on the properties list itself — so the viewport is set once when a
// university is newly resolved, and never forcibly reset just because the
// user changed a filter or the map re-rendered with a different `properties`
// array. `anchorRef`/`nearbyRef` hold the CURRENT values for the effect to
// read when it does run, without making the effect re-run every time they
// change (that would reintroduce the "resets on every filter change" bug).
function FitBounds({ universityKey, anchor, nearbyPoints, fallbackPoints }) {
  const map = useMap();
  const anchorRef = useRef(anchor);
  const nearbyRef = useRef(nearbyPoints);
  const fallbackRef = useRef(fallbackPoints);
  anchorRef.current = anchor;
  nearbyRef.current = nearbyPoints;
  fallbackRef.current = fallbackPoints;

  useEffect(() => {
    const currentAnchor = anchorRef.current;
    const currentNearby = nearbyRef.current;
    const currentFallback = fallbackRef.current;

    if (currentAnchor) {
      // University is always the primary geographic focus. Nearby
      // properties (within NEARBY_RADIUS_KM) gently widen the view to keep
      // them visible; a distant/outlier property never gets to drag the
      // viewport out to fit it — that property remains plotted, just
      // outside the initial frame, exactly like this component already
      // does for any property with no coordinates at all.
      if (currentNearby.length > 0) {
        map.fitBounds(L.latLngBounds([currentAnchor, ...currentNearby]), { padding: [48, 48], maxZoom: 15 });
      } else {
        map.setView(currentAnchor, 13);
      }
    } else if (currentFallback.length === 1) {
      map.setView(currentFallback[0], 14);
    } else if (currentFallback.length > 1) {
      map.fitBounds(L.latLngBounds(currentFallback), { padding: [32, 32], maxZoom: 15 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [universityKey]);
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

  const anchor = universityHasCoords ? [university.latitude, university.longitude] : null;

  // Only properties within NEARBY_RADIUS_KM of the university drive the
  // initial viewport fit — this is what stops one distant/mistagged
  // property from dragging the map out to country/continent level (the
  // reported bug). distanceKm is already computed upstream (this page's own
  // haversineKm call) whenever the university has real coordinates, so no
  // new calculation/API call is introduced here — this only reads what
  // already exists on each listing.
  const nearbyPoints = useMemo(
    () => (universityHasCoords
      ? plottable.filter((p) => p.distanceKm == null || p.distanceKm <= NEARBY_RADIUS_KM).map((p) => [p.coordinates.lat, p.coordinates.lng])
      : []),
    [universityHasCoords, plottable]
  );

  // Used only when the university itself has no coordinates (rare — see
  // this component's own pre-existing comment on AI-discovered institutions
  // with no coordinate data) — falls back to fitting whatever property
  // markers exist, exactly like before.
  const fallbackPoints = useMemo(
    () => (universityHasCoords ? [] : plottable.map((p) => [p.coordinates.lat, p.coordinates.lng])),
    [universityHasCoords, plottable]
  );

  // Identifies WHICH university is currently resolved, independent of its
  // properties list — the one thing FitBounds keys its effect on, so
  // selecting a new university sets the viewport, but changing a filter
  // (which only changes `properties`, not this key) never does.
  const universityKey = university ? (university.id || university.name || JSON.stringify(anchor)) : null;

  const center = universityHasCoords
    ? anchor
    : plottable.length
      ? [plottable[0].coordinates.lat, plottable[0].coordinates.lng]
      : [51.5074, -0.1278]; // neutral fallback center only — never used as a fabricated pin, just where the empty map starts
  const initialZoom = universityHasCoords ? 14 : 13;

  return (
    <div className="uh-map-shell">
      <MapContainer center={center} zoom={initialZoom} scrollWheelZoom={false} className="uh-map-leaflet">
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <FitBounds universityKey={universityKey} anchor={anchor} nearbyPoints={nearbyPoints} fallbackPoints={fallbackPoints} />

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
