import React, { useCallback, useEffect, useMemo, useRef } from "react";
import { MapContainer, TileLayer, Marker, Popup, GeoJSON, Pane, useMap, useMapEvents } from "react-leaflet";
import MarkerClusterGroup from "react-leaflet-cluster";
import L from "leaflet";
import { Link } from "react-router-dom";
import { Star, Plus, Minus, Maximize2, LocateFixed, MapPin } from "lucide-react";
import "leaflet/dist/leaflet.css";
import "leaflet.markercluster/dist/MarkerCluster.css";
import "./UniversityHousingMap.css";
import WishlistHeart from "../listing/WishlistHeart";
import { hasValidCoords } from "../../lib/geoDistance";

// Same provider/approach as the Student Planner's own map
// (src/components/planner/PlannerMap.js): react-leaflet + OpenStreetMap
// raster tiles, no API key, no per-marker network call — every coordinate
// here was already computed either by campusUniversities.json (university)
// or Amber's own location_coordinates field, surfaced additively via
// amberMapper.js's mapAmberPropertyToListing (properties). This component
// only draws them; it never fetches anything itself.
//
// Visual layer (brand-styled, see UniversityHousingMap.css): the OSM tiles
// are softened with a CSS filter (same tiles, same attribution — no new
// provider), markers are inline-SVG pins (lucide icon paths) instead of
// emoji, clusters use a plum icon whose number is the cluster's real child
// count, and the default zoom buttons are replaced by MapControls below.

// lucide-react icon geometry (house / graduation-cap / school), inlined
// because Leaflet divIcons take an HTML string, not a React element.
const svg = (inner) =>
  `<svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${inner}</svg>`;
const HOUSE_SVG = svg('<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>');
const GRAD_CAP_SVG = svg('<path d="M21.42 10.922a1 1 0 0 0-.019-1.838L12.83 5.18a2 2 0 0 0-1.66 0L2.6 9.08a1 1 0 0 0 0 1.832l8.57 3.908a2 2 0 0 0 1.66 0z"/><path d="M22 10v6"/><path d="M6 12.5V16a6 3 0 0 0 12 0v-3.5"/>');
const SCHOOL_SVG = svg('<path d="M14 22v-4a2 2 0 1 0-4 0v4"/><path d="m18 10 3.447 1.724a1 1 0 0 1 .553.894V20a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-7.382a1 1 0 0 1 .553-.894L6 10"/><path d="M18 5v17"/><path d="m4 6 7.106-3.553a2 2 0 0 1 1.788 0L20 6"/><path d="M6 5v17"/><circle cx="12" cy="9" r="2"/>');

// Circular pins, anchored at their centre so the pin sits exactly on the
// real coordinate. Built once at module load — never per render.
function buildIcon(innerSvg, variant, size) {
  return L.divIcon({
    className: `uh-pin uh-pin--${variant}`,
    html: `<span class="uh-pin-body">${innerSvg}</span>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -size / 2 - 2],
  });
}
// Institution marker is differentiated by type ("SCHOOL" gets a school
// building, everything else — including an absent/unrecognized type, same
// "no implicit default" rule as the resolver — gets the graduation cap) but
// shares the same larger institution-marker size/style, visually distinct
// from residence pins either way (item 17/18).
const universityIcon = buildIcon(GRAD_CAP_SVG, "university", 46);
const schoolIcon = buildIcon(SCHOOL_SVG, "school", 46);
const propertyIcon = buildIcon(HOUSE_SVG, "property", 34);
const propertyIconActive = buildIcon(HOUSE_SVG, "property-active", 42);
const TYPE_LABELS = { UNIVERSITY: "University", SCHOOL: "School" };
function typeLabel(type) {
  return TYPE_LABELS[type] || TYPE_LABELS.UNIVERSITY;
}

// Cluster icon: plum disc + halo, white count. The number is
// markercluster's own getChildCount() — the real number of property
// markers inside that cluster, never an estimate. Three size tiers only.
export function createClusterIcon(cluster) {
  const count = cluster.getChildCount();
  const tier = count < 10 ? "sm" : count < 100 ? "md" : "lg";
  const size = tier === "sm" ? 40 : tier === "md" ? 46 : 54;
  return L.divIcon({
    className: `uh-cluster uh-cluster--${tier}`,
    html: `<span class="uh-cluster-body" title="${count} properties"><span>${count}</span></span>`,
    iconSize: L.point(size, size),
  });
}

// City/country boundary overlay (data: src/services/boundaryApi.js — the
// real OSM administrative outline, never a circle or bounding box). Drawn
// in its own pane ABOVE the tiles and Leaflet's default overlay pane (400)
// but BELOW markers/clusters (600) and popups (700), so the selected area
// reads clearly while every pin stays on top. Non-interactive: clicks and
// drags pass straight through to the map. A white casing under the plum
// line keeps the edge legible on any tile colour at every zoom; the fill is
// faint so roads, labels and pins stay readable. Leaflet writes these as SVG
// attributes, which can't read CSS custom properties — #5E3A6B is
// --brand-purple (src/styles/global.css).
export const BOUNDARY_PANE = "uh-boundary";
export const BOUNDARY_PANE_Z_INDEX = 450;
export const BOUNDARY_CASING_STYLE = { color: "#FFFFFF", weight: 5, opacity: 0.8, fill: false, lineJoin: "round", lineCap: "round" };
export const BOUNDARY_STYLE = { color: "#5E3A6B", weight: 2.25, opacity: 0.9, fillColor: "#5E3A6B", fillOpacity: 0.07, lineJoin: "round", lineCap: "round" };

function BoundaryLayer({ boundary }) {
  const data = useMemo(
    () => (boundary ? { type: "Feature", properties: { name: boundary.name }, geometry: boundary.geometry } : null),
    [boundary]
  );
  // The pane stays mounted; only its contents change. GeoJSON's `data` is
  // read once by react-leaflet, so a new boundary is keyed to remount.
  return (
    <Pane name={BOUNDARY_PANE} style={{ zIndex: BOUNDARY_PANE_Z_INDEX, pointerEvents: "none" }}>
      {data && <GeoJSON key={`${boundary.key}|casing`} data={data} style={BOUNDARY_CASING_STYLE} interactive={false} />}
      {data && <GeoJSON key={boundary.key} data={data} style={BOUNDARY_STYLE} interactive={false} />}
    </Pane>
  );
}

// A boundary usually arrives after the first fit (it's a separate request
// from the inventory). When it does, frame it — once per boundary — unless
// the user has already dragged the map for this search, so a late response
// never yanks the view away from where they are looking.
function FitToBoundary({ boundary, locationKey, fitRef }) {
  const map = useMap();
  const userMovedRef = useRef(false);
  useMapEvents({ dragstart: () => { userMovedRef.current = true; } });
  useEffect(() => { userMovedRef.current = false; }, [locationKey]);
  const boundaryKey = boundary?.key || null;
  useEffect(() => {
    if (!boundaryKey || userMovedRef.current) return;
    fitRef.current(map);
  }, [boundaryKey, map, fitRef]);
  return null;
}

// A property whose real distance from the university is beyond this radius
// no longer counts toward the initial viewport — it's still plotted (never
// hidden), it just can't drag the map out to country/continent level to fit
// it. 15km comfortably covers a real city's own spread (confirmed against
// this session's own city data: Manchester/Barcelona/etc. properties
// typically sit within a few km of the city centre) without being so tight
// that legitimate same-city properties get excluded from the initial fit.
const NEARBY_RADIUS_KM = 15;

// The one framing rule, shared by the initial fit and the "fit to results"
// control: the university (when it has coordinates) plus its nearby
// properties; otherwise (city/country) the searched area's boundary, when
// known, together with every plotted property — a property outside the
// outline is still framed, never dropped; otherwise every plotted property.
function fitView(map, anchor, nearbyPoints, fallbackPoints, boundaryBounds = null) {
  if (anchor) {
    // University is always the primary geographic focus. Nearby
    // properties (within NEARBY_RADIUS_KM) gently widen the view to keep
    // them visible; a distant/outlier property never gets to drag the
    // viewport out to fit it — that property remains plotted, just
    // outside the initial frame, exactly like this component already
    // does for any property with no coordinates at all.
    if (nearbyPoints.length > 0) {
      map.fitBounds(L.latLngBounds([anchor, ...nearbyPoints]), { padding: [48, 48], maxZoom: 15 });
    } else {
      map.setView(anchor, 13);
    }
  } else if (boundaryBounds) {
    const bounds = L.latLngBounds(boundaryBounds);
    fallbackPoints.forEach((p) => bounds.extend(p));
    map.fitBounds(bounds, { padding: [32, 32], maxZoom: 15 });
  } else if (fallbackPoints.length === 1) {
    map.setView(fallbackPoints[0], 14);
  } else if (fallbackPoints.length > 1) {
    map.fitBounds(L.latLngBounds(fallbackPoints), { padding: [40, 40], maxZoom: 15 });
  }
}

// Keyed ONLY on a per-university identity (id/name + its own coordinates),
// never on the properties list itself — so the viewport is set once when a
// university is newly resolved, and never forcibly reset just because the
// user changed a filter or the map re-rendered with a different `properties`
// array. `anchorRef`/`nearbyRef` hold the CURRENT values for the effect to
// read when it does run, without making the effect re-run every time they
// change (that would reintroduce the "resets on every filter change" bug).
function FitBounds({ universityKey, anchor, nearbyPoints, fallbackPoints, boundaryBounds }) {
  const map = useMap();
  const anchorRef = useRef(anchor);
  const nearbyRef = useRef(nearbyPoints);
  const fallbackRef = useRef(fallbackPoints);
  const boundaryRef = useRef(boundaryBounds);
  anchorRef.current = anchor;
  nearbyRef.current = nearbyPoints;
  fallbackRef.current = fallbackPoints;
  boundaryRef.current = boundaryBounds;

  useEffect(() => {
    fitView(map, anchorRef.current, nearbyRef.current, fallbackRef.current, boundaryRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [universityKey]);
  return null;
}

// Branded replacement for Leaflet's default zoom control (disabled on the
// MapContainer): zoom in/out, fit to results, and — only when a university
// with real coordinates is the search anchor — re-centre on it. No
// geolocation: nothing here ever asks for or guesses the user's position.
function MapControls({ onFitResults, canFit, anchor, anchorLabel }) {
  const map = useMap();
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current) return;
    // Clicks/scrolls on the controls must not pan or zoom the map beneath.
    L.DomEvent.disableClickPropagation(ref.current);
    L.DomEvent.disableScrollPropagation(ref.current);
  }, []);
  return (
    <div ref={ref} className="uh-map-controls" role="group" aria-label="Map controls">
      <button type="button" className="uh-map-control" aria-label="Zoom in" title="Zoom in" onClick={() => map.zoomIn()}>
        <Plus size={18} aria-hidden="true" />
      </button>
      <button type="button" className="uh-map-control" aria-label="Zoom out" title="Zoom out" onClick={() => map.zoomOut()}>
        <Minus size={18} aria-hidden="true" />
      </button>
      {canFit && (
        <button type="button" className="uh-map-control uh-map-control--gap" aria-label="Fit map to results" title="Fit map to results" onClick={() => onFitResults(map)}>
          <Maximize2 size={16} aria-hidden="true" />
        </button>
      )}
      {anchor && (
        <button
          type="button"
          className="uh-map-control"
          aria-label={`Centre map on ${anchorLabel}`}
          title={`Centre on ${anchorLabel}`}
          onClick={() => map.setView(anchor, Math.max(map.getZoom(), 14))}
        >
          <LocateFixed size={17} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

// When the selection changes (e.g. a listing row was clicked), make sure its
// marker is actually visible: expand the cluster hiding it, or pan to it if
// it's off-screen. A marker that's already visible (the usual case after a
// marker click) leaves the viewport alone.
function FollowSelection({ selectedId, markerRefs, clusterRef }) {
  const map = useMap();
  useEffect(() => {
    if (selectedId == null) return;
    const marker = markerRefs.current.get(String(selectedId));
    if (!marker) return; // no coordinates, or filtered out — nothing to show
    const cluster = clusterRef.current;
    const visibleParent = cluster && typeof cluster.getVisibleParent === "function" ? cluster.getVisibleParent(marker) : marker;
    if (visibleParent && visibleParent !== marker && typeof cluster.zoomToShowLayer === "function") {
      cluster.zoomToShowLayer(marker);
    } else if (!map.getBounds().contains(marker.getLatLng())) {
      map.panTo(marker.getLatLng());
    }
  }, [selectedId, map, markerRefs, clusterRef]);
  return null;
}

// The marker popup's content: built only from the already-loaded listing —
// no fetch. Optional fields are omitted when the data is missing; a price is
// shown exactly as stored (amount + its own duration), and a sold-out
// property is always labelled sold out, never priced as bookable.
export function PropertyPreview({ property: p, university }) {
  const roomTypes = Array.isArray(p.rooms?.types) ? p.rooms.types.filter(Boolean) : [];
  const locality = p.address?.locality || null;
  return (
    <div className="uh-preview">
      {p.image && (
        <div className="uh-preview-media">
          <img src={p.image} alt="" className="uh-preview-image" loading="lazy" />
        </div>
      )}
      <div className="uh-preview-body">
        {p.isSoldOut && <span className="uh-preview-status uh-preview-status--soldout">Sold out</span>}
        <strong className="uh-preview-name">{p.name}</strong>
        {locality && (
          <span className="uh-preview-meta"><MapPin size={12} aria-hidden="true" /> {locality}</span>
        )}
        {roomTypes.length > 0 && (
          <span className="uh-preview-meta">
            {roomTypes.slice(0, 2).join(" · ")}{roomTypes.length > 2 ? ` +${roomTypes.length - 2} more` : ""}
          </span>
        )}
        <div className="uh-preview-row">
          {!p.isSoldOut && (
            p.price?.from != null ? (
              <span className="uh-preview-price">
                From {p.price.currency}{p.price.from}
                {p.price.duration ? <span className="uh-preview-duration">/{p.price.duration}</span> : null}
              </span>
            ) : (
              <span className="uh-preview-price uh-preview-price--na">Price on request</span>
            )
          )}
          {p.rating?.overall != null && (
            <span className="uh-preview-rating"><Star size={12} fill="currentColor" aria-hidden="true" /> {Math.round(p.rating.overall * 10) / 10}</span>
          )}
        </div>
        {p.distanceKm != null && university?.name && (
          <span className="uh-preview-meta">{p.distanceKm} km from {university.name}</span>
        )}
        <div className="uh-preview-actions">
          {p.slug ? (
            <Link to={`/property/${encodeURIComponent(p.slug)}`} className="btn btn-primary btn-sm uh-preview-cta">View property</Link>
          ) : (
            <Link to="/find-rooms" className="btn btn-outline btn-sm uh-preview-cta">Browse rooms</Link>
          )}
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
        </div>
      </div>
    </div>
  );
}

// City/country searches have no institution anchor: `locationKey` identifies
// the search instead (so the viewport fits that search's real property
// coordinates once, like a university does), and `clusterMarkers` groups a
// large city/country result set with the same clustering Find Room's map
// (src/components/map/PropertyMap.js) uses. The map only ever draws the
// `properties` it is given — it never loads inventory itself.
//
// `boundary` ({key, name, geometry, bounds} from src/services/boundaryApi.js)
// outlines a city/country search's area. It is drawing and framing only:
// it never filters, hides or reorders a property. Ignored for a university
// search, whose map is unchanged.
export default function UniversityHousingMap({ university, properties, selectedId, onSelectProperty, locationKey = null, clusterMarkers = false, boundary = null }) {
  const universityHasCoords = hasValidCoords(university?.latitude, university?.longitude);
  const areaBoundary = university ? null : boundary;
  const boundaryBounds = areaBoundary?.bounds || null;

  // Never fabricate a marker location — a property without real coordinates
  // simply isn't plotted; it still exists in the list panel.
  const plottable = useMemo(
    () => properties.filter((p) => hasValidCoords(p.coordinates?.lat, p.coordinates?.lng)),
    [properties]
  );

  const anchor = useMemo(
    () => (universityHasCoords ? [university.latitude, university.longitude] : null),
    [universityHasCoords, university]
  );

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

  // Used only when the university itself has no coordinates (or for a
  // city/country search) — fits whatever property markers exist.
  const fallbackPoints = useMemo(
    () => (universityHasCoords ? [] : plottable.map((p) => [p.coordinates.lat, p.coordinates.lng])),
    [universityHasCoords, plottable]
  );

  const fitResults = useCallback(
    (map) => fitView(map, anchor, nearbyPoints, fallbackPoints, boundaryBounds),
    [anchor, nearbyPoints, fallbackPoints, boundaryBounds]
  );
  const fitResultsRef = useRef(fitResults);
  fitResultsRef.current = fitResults;

  // Identifies WHICH university is currently resolved, independent of its
  // properties list — the one thing FitBounds keys its effect on, so
  // selecting a new university sets the viewport, but changing a filter
  // (which only changes `properties`, not this key) never does.
  const universityKey = university ? (university.id || university.name || JSON.stringify(anchor)) : locationKey;

  const center = universityHasCoords
    ? anchor
    : plottable.length
      ? [plottable[0].coordinates.lat, plottable[0].coordinates.lng]
      : [51.5074, -0.1278]; // neutral fallback center only — never used as a fabricated pin, just where the empty map starts
  const initialZoom = universityHasCoords ? 14 : 13;

  // Live Leaflet marker instances by property id, for FollowSelection.
  const markerRefs = useRef(new Map());
  const clusterRef = useRef(null);

  // Rebuilt only when the plotted set, the selection or the anchor changes —
  // react-leaflet then updates just the props that differ (e.g. the one
  // marker whose icon switches to/from "selected").
  const propertyMarkers = useMemo(() => plottable.map((p) => {
    const isSelected = String(p.id) === String(selectedId);
    return (
      <Marker
        key={p.id}
        position={[p.coordinates.lat, p.coordinates.lng]}
        icon={isSelected ? propertyIconActive : propertyIcon}
        title={`${p.name}${p.isSoldOut ? " (sold out)" : ""}`}
        zIndexOffset={isSelected ? 1000 : 0}
        riseOnHover
        ref={(marker) => {
          if (marker) markerRefs.current.set(String(p.id), marker);
          else markerRefs.current.delete(String(p.id));
        }}
        eventHandlers={{ click: () => onSelectProperty?.(p.id) }}
      >
        <Popup className="uh-popup" minWidth={240} maxWidth={280} autoPanPaddingTopLeft={[16, 16]} autoPanPaddingBottomRight={[64, 16]}>
          <PropertyPreview property={p} university={university} />
        </Popup>
      </Marker>
    );
  }), [plottable, selectedId, onSelectProperty, university]);

  return (
    <div className="uh-map-shell">
      <MapContainer center={center} zoom={initialZoom} scrollWheelZoom={false} zoomControl={false} className="uh-map-leaflet">
        <TileLayer
          className="uh-map-tiles"
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <BoundaryLayer boundary={areaBoundary} />
        <FitBounds universityKey={universityKey} anchor={anchor} nearbyPoints={nearbyPoints} fallbackPoints={fallbackPoints} boundaryBounds={boundaryBounds} />
        <FitToBoundary boundary={areaBoundary} locationKey={locationKey} fitRef={fitResultsRef} />
        <MapControls
          onFitResults={fitResults}
          canFit={Boolean(anchor) || plottable.length > 0 || Boolean(boundaryBounds)}
          anchor={anchor}
          anchorLabel={university?.name || "the university"}
        />
        <FollowSelection selectedId={selectedId} markerRefs={markerRefs} clusterRef={clusterRef} />

        {universityHasCoords && (
          <Marker
            position={[university.latitude, university.longitude]}
            icon={university.type === "SCHOOL" ? schoolIcon : universityIcon}
            title={university.name}
            zIndexOffset={500}
          >
            <Popup className="uh-popup uh-popup--institution" maxWidth={260}>
              <div className="uh-map-popup">
                <strong>{university.name}</strong>
                <span className="uh-map-popup-type">{typeLabel(university.type)}</span>
                <span>{university.address || [university.city, university.country].filter(Boolean).join(", ")}</span>
              </div>
            </Popup>
          </Marker>
        )}

        {clusterMarkers
          ? (
            <MarkerClusterGroup
              ref={clusterRef}
              chunkedLoading
              showCoverageOnHover={false}
              maxClusterRadius={50}
              spiderfyOnMaxZoom
              iconCreateFunction={createClusterIcon}
            >
              {propertyMarkers}
            </MarkerClusterGroup>
          )
          : propertyMarkers}
      </MapContainer>
    </div>
  );
}
