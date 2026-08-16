import React, { useEffect, useMemo, useRef, useState } from "react";
import { MapContainer, TileLayer, Marker, Popup, useMap, useMapEvents } from "react-leaflet";
import MarkerClusterGroup from "react-leaflet-cluster";
import L from "leaflet";
import { Link } from "react-router-dom";
import { Star } from "lucide-react";
import "leaflet/dist/leaflet.css";
import "leaflet.markercluster/dist/MarkerCluster.css";
import "leaflet.markercluster/dist/MarkerCluster.Default.css";
import WishlistHeart from "../listing/WishlistHeart";
import { hasValidCoords } from "../../lib/geoDistance";
import "./PropertyMap.css";

// Generalizes the proven approach already shipped in
// src/components/universityHousing/UniversityHousingMap.js (react-leaflet +
// free OSM tiles, coordinates never fabricated — see hasValidCoords guard —
// two-way selectedId sync) into a reusable component for the main
// properties/find-rooms search, adding price-pill markers and clustering.
// UniversityHousingMap.js itself is left untouched to avoid any regression
// risk to that page; this is a new sibling, not a refactor of it.

function buildAnchorIcon() {
  return L.divIcon({
    className: "pm-anchor-icon",
    html: `<span>🎓</span>`,
    iconSize: [34, 34],
    iconAnchor: [17, 34],
    popupAnchor: [0, -30],
  });
}

function buildPriceIcon(priceLabel, active) {
  return L.divIcon({
    className: `pm-price-icon${active ? " pm-price-icon--active" : ""}`,
    html: `<span>${priceLabel}</span>`,
    iconSize: undefined,
    iconAnchor: [30, 18],
    popupAnchor: [0, -20],
  });
}

// Leaflet measures its container's pixel size once, at construction — if
// that size isn't final yet (a lazy-loaded component settling into a CSS
// grid/flex layout, a mobile full-screen overlay whose transition hasn't
// finished, a tab/panel that was `display:none` a moment ago), the map
// renders with the wrong size or blank grey tiles until something nudges
// it. `invalidateSize()` re-measures and redraws; calling it once
// immediately and once again shortly after covers both "already correctly
// sized" (a harmless no-op) and "just became visible/resized" (the actual
// fix) without needing to know which case this mount is.
function InvalidateSizeOnMount() {
  const map = useMap();
  useEffect(() => {
    map.invalidateSize();
    const t = setTimeout(() => map.invalidateSize(), 250);
    return () => clearTimeout(t);
  }, [map]);
  return null;
}

function FitBounds({ points }) {
  const map = useMap();
  useEffect(() => {
    if (points.length === 1) map.setView(points[0], 14);
    else if (points.length > 1) map.fitBounds(L.latLngBounds(points), { padding: [40, 40], maxZoom: 15 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(points)]);
  return null;
}

// Reports the map's own bounds after every user pan/zoom — PropertyMap never
// decides what to do with them (filtering already-fetched results vs
// fetching more, see Architecture decision #2 in the plan doc); that's the
// caller's call entirely, this is just the sensor.
function BoundsWatcher({ onMove }) {
  const map = useMapEvents({ moveend: () => onMove(map.getBounds()) });
  return null;
}

function PropertyPreview({ property, viewHref, compact }) {
  const p = property;
  const wishlistSnapshot = p.id != null ? {
    propertyId: String(p.id), slug: p.slug || null, propertyName: p.name || null,
    city: p.address?.locality || null, image: p.image || null,
    price: p.price?.from != null ? { amount: p.price.from, currency: p.price.currency || null } : null,
  } : null;

  return (
    <div className={`pm-preview${compact ? " pm-preview--compact" : ""}`}>
      {p.image && <img src={p.image} alt={p.name} className="pm-preview-image" loading="lazy" />}
      <div className="pm-preview-body">
        <strong className="pm-preview-name">{p.name}</strong>
        <span className="pm-preview-locality">{p.address?.locality}</span>
        <span className="pm-preview-row">
          {p.price?.from != null && <>From {p.price.currency}{p.price.from}{p.price.duration ? `/${p.price.duration}` : ""}</>}
          {p.rating?.overall != null && <span className="pm-preview-rating"><Star size={12} fill="currentColor" /> {p.rating.overall}</span>}
        </span>
        <div className="pm-preview-actions">
          {wishlistSnapshot && <WishlistHeart property={wishlistSnapshot} />}
          {p.slug && <Link to={viewHref} className="btn btn-outline btn-sm">View Property</Link>}
        </div>
      </div>
    </div>
  );
}

export default function PropertyMap({
  anchor,
  properties,
  selectedId,
  onSelectProperty,
  onSearchThisArea,
  className = "",
}) {
  const anchorHasCoords = anchor && hasValidCoords(anchor.lat, anchor.lng);
  // Never fabricate a marker location — a property without real coordinates
  // simply isn't plotted here; it still exists in the list panel alongside this map.
  const plottable = useMemo(
    () => properties.filter((p) => hasValidCoords(p.coordinates?.lat, p.coordinates?.lng)),
    [properties]
  );

  const points = useMemo(() => [
    ...(anchorHasCoords ? [[anchor.lat, anchor.lng]] : []),
    ...plottable.map((p) => [p.coordinates.lat, p.coordinates.lng]),
  ], [anchorHasCoords, anchor, plottable]);

  const center = anchorHasCoords
    ? [anchor.lat, anchor.lng]
    : plottable.length ? [plottable[0].coordinates.lat, plottable[0].coordinates.lng] : [51.5074, -0.1278]; // neutral fallback only — never a fabricated pin

  // "Search this area" only appears once the user has actually moved the
  // map — the initial fitBounds-driven moveend must not itself trigger it,
  // since the starting view already matches the current result set.
  const [showSearchArea, setShowSearchArea] = useState(false);
  const pendingBoundsRef = useRef(null);
  const ignoreNextMoveRef = useRef(true);

  useEffect(() => {
    // A new points set means FitBounds is about to re-frame the map — the
    // moveend that produces must be ignored the same way the very first one is.
    ignoreNextMoveRef.current = true;
    setShowSearchArea(false);
  }, [points.length]);

  function handleMove(bounds) {
    if (ignoreNextMoveRef.current) { ignoreNextMoveRef.current = false; return; }
    pendingBoundsRef.current = bounds;
    setShowSearchArea(true);
  }

  const selectedProperty = plottable.find((p) => String(p.id) === String(selectedId));

  return (
    <div className={`pm-shell ${className}`}>
      <MapContainer center={center} zoom={13} scrollWheelZoom className="pm-leaflet">
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <InvalidateSizeOnMount />
        <FitBounds points={points} />
        <BoundsWatcher onMove={handleMove} />

        {anchorHasCoords && (
          <Marker position={[anchor.lat, anchor.lng]} icon={buildAnchorIcon()}>
            <Popup><div className="pm-popup"><strong>{anchor.label}</strong></div></Popup>
          </Marker>
        )}

        <MarkerClusterGroup chunkedLoading showCoverageOnHover={false} maxClusterRadius={50} spiderfyOnMaxZoom>
          {plottable.map((p) => {
            const active = String(p.id) === String(selectedId);
            const priceLabel = p.price?.from != null ? `${p.price.currency || ""}${p.price.from}` : "—";
            return (
              <Marker
                key={p.id}
                position={[p.coordinates.lat, p.coordinates.lng]}
                icon={buildPriceIcon(priceLabel, active)}
                eventHandlers={{ click: () => onSelectProperty?.(p.id) }}
              >
                <Popup className="pm-popup-wrap desktop-only">
                  <PropertyPreview property={p} viewHref={`/property/${encodeURIComponent(p.slug)}`} />
                </Popup>
              </Marker>
            );
          })}
        </MarkerClusterGroup>
      </MapContainer>

      {showSearchArea && onSearchThisArea && (
        <button
          type="button"
          className="pm-search-area-btn"
          onClick={() => { onSearchThisArea(pendingBoundsRef.current); setShowSearchArea(false); }}
        >
          Search this area
        </button>
      )}

      {/* Mobile compact preview renders as a bottom sheet instead of a
          Leaflet popup (which is too fiddly to tap accurately on a small
          screen) — desktop gets the in-map Popup above instead. */}
      {selectedProperty && (
        <div className="pm-mobile-preview mobile-only">
          <PropertyPreview property={selectedProperty} viewHref={`/property/${encodeURIComponent(selectedProperty.slug)}`} compact />
        </div>
      )}
    </div>
  );
}
