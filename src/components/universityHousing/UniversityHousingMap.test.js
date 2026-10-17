import React from "react";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import L from "leaflet";
import fs from "fs";
import path from "path";
import UniversityHousingMap, { PropertyPreview, createClusterIcon, BOUNDARY_PANE, BOUNDARY_PANE_Z_INDEX, BOUNDARY_STYLE, BOUNDARY_CASING_STYLE } from "./UniversityHousingMap";

// react-leaflet 5 ships ESM only (not transformable under CRA's Jest), so
// its React wrappers are replaced with plain elements that record their
// props. Leaflet itself (icons, DomEvent) is the real library.
const mockMap = {
  zoomIn: jest.fn(),
  zoomOut: jest.fn(),
  setView: jest.fn(),
  fitBounds: jest.fn(),
  panTo: jest.fn(),
  getZoom: jest.fn(() => 12),
  getBounds: jest.fn(() => ({ contains: () => true })),
};
jest.mock("react-leaflet", () => {
  const React = require("react");
  return {
    MapContainer: ({ children, zoomControl }) => <div data-testid="map" data-zoom-control={String(zoomControl)}>{children}</div>,
    TileLayer: ({ attribution, className }) => <div data-testid="tiles" data-class={className} data-attribution={attribution} />,
    Marker: React.forwardRef(({ children, icon, title, position, eventHandlers }, _ref) => (
      <div data-testid="marker" data-title={title} data-icon-class={icon?.options?.className} data-icon-html={icon?.options?.html} data-position={position.join(",")}>
        <button type="button" onClick={() => eventHandlers?.click?.()}>select {title}</button>
        {children}
      </div>
    )),
    Popup: ({ children, className }) => <div data-testid="popup" data-class={className}>{children}</div>,
    Pane: ({ children, name, style }) => <div data-testid="pane" data-name={name} data-z-index={style?.zIndex} data-pointer-events={style?.pointerEvents}>{children}</div>,
    GeoJSON: ({ data, style, interactive }) => {
      mockGeoJsonRenders.push({ data, style, interactive });
      return <div data-testid="geojson" data-name={data.properties.name} data-geometry-type={data.geometry.type} data-color={style.color} data-fill={String(style.fill !== false)} />;
    },
    useMap: () => mockMap,
    useMapEvents: (handlers) => { Object.assign(mockMapEvents, handlers); return mockMap; },
  };
});
const mockGeoJsonRenders = [];
const mockMapEvents = {};
jest.mock("react-leaflet-cluster", () => {
  const React = require("react");
  return React.forwardRef(({ children, iconCreateFunction }, _ref) => (
    <div data-testid="cluster-group" data-has-icon-fn={String(typeof iconCreateFunction === "function")}>{children}</div>
  ));
});
jest.mock("../listing/WishlistHeart", () => () => <span data-testid="heart" />);

function listing(id, overrides = {}) {
  return {
    id,
    slug: `slug-${id}`,
    name: `Residence ${id}`,
    address: { locality: "London" },
    coordinates: { lat: 51.5, lng: -0.12 },
    image: `https://img.example/${id}.jpg`,
    price: { from: 199, currency: "£", duration: "week" },
    rooms: { types: ["Studio", "Ensuite"] },
    rating: { overall: 4.6000000000000005 },
    isSoldOut: false,
    distanceKm: null,
    ...overrides,
  };
}

function renderMap(props) {
  return render(
    <MemoryRouter>
      <UniversityHousingMap selectedId={null} onSelectProperty={() => {}} {...props} />
    </MemoryRouter>
  );
}

// CRA's Jest config resets mock implementations before every test, so the
// fake map's return values are re-established here.
beforeEach(() => {
  mockMap.getZoom.mockReturnValue(12);
  mockMap.getBounds.mockReturnValue({ contains: () => true });
  mockGeoJsonRenders.length = 0;
  for (const k of Object.keys(mockMapEvents)) delete mockMapEvents[k];
});

test("property markers are branded SVG pins (no emoji), one per listing WITH coordinates, with an accessible title", () => {
  renderMap({
    university: null,
    properties: [listing("a"), listing("b", { isSoldOut: true }), listing("c", { coordinates: null })],
    locationKey: "CITY|London|UK",
  });
  const markers = screen.getAllByTestId("marker");
  expect(markers).toHaveLength(2); // "c" has no coordinates: not plotted, never given fake ones
  for (const m of markers) {
    expect(m.dataset.iconClass).toBe("uh-pin uh-pin--property");
    expect(m.dataset.iconHtml).toMatch(/<svg/);
    expect(m.dataset.iconHtml).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
  }
  expect(markers.map((m) => m.dataset.title)).toEqual(["Residence a", "Residence b (sold out)"]);
  expect(markers[0].dataset.position).toBe("51.5,-0.12");
});

test("the selected property gets the distinct selected pin; marker clicks report the property id", () => {
  const onSelect = jest.fn();
  renderMap({ university: null, properties: [listing("a"), listing("b")], selectedId: "b", onSelectProperty: onSelect });
  const [a, b] = screen.getAllByTestId("marker");
  expect(a.dataset.iconClass).toBe("uh-pin uh-pin--property");
  expect(b.dataset.iconClass).toBe("uh-pin uh-pin--property-active");
  fireEvent.click(within(a).getByRole("button", { name: "select Residence a" }));
  expect(onSelect).toHaveBeenCalledWith("a");
});

test("clusters are used for city/country results with the branded icon function; cluster labels use the real child count", () => {
  renderMap({ university: null, properties: [listing("a"), listing("b")], clusterMarkers: true });
  expect(screen.getByTestId("cluster-group").dataset.hasIconFn).toBe("true");

  const small = createClusterIcon({ getChildCount: () => 7 });
  const medium = createClusterIcon({ getChildCount: () => 42 });
  const large = createClusterIcon({ getChildCount: () => 1315 });
  expect(small.options.className).toBe("uh-cluster uh-cluster--sm");
  expect(small.options.html).toContain(">7<");
  expect(medium.options.className).toBe("uh-cluster uh-cluster--md");
  expect(medium.options.html).toContain(">42<");
  expect(large.options.className).toBe("uh-cluster uh-cluster--lg");
  expect(large.options.html).toContain(">1315<");
  expect(large.options.iconSize).toEqual(L.point(54, 54));
});

test("university results keep the university marker and do not cluster (unchanged behaviour)", () => {
  renderMap({
    university: { id: "u", name: "University of Manchester", type: "UNIVERSITY", latitude: 53.46, longitude: -2.23, city: "Manchester", country: "UK" },
    properties: [listing("a", { coordinates: { lat: 53.47, lng: -2.24 }, distanceKm: 1.2 })],
  });
  expect(screen.queryByTestId("cluster-group")).not.toBeInTheDocument();
  const institution = screen.getAllByTestId("marker").find((m) => m.dataset.title === "University of Manchester");
  expect(institution.dataset.iconClass).toBe("uh-pin uh-pin--university");
});

test("branded controls replace Leaflet's zoom control and drive the map; fit and re-centre are offered", () => {
  renderMap({
    university: { id: "u", name: "University of Manchester", type: "UNIVERSITY", latitude: 53.46, longitude: -2.23 },
    properties: [listing("a", { coordinates: { lat: 53.47, lng: -2.24 }, distanceKm: 1.2 })],
  });
  expect(screen.getByTestId("map").dataset.zoomControl).toBe("false");
  fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
  fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
  expect(mockMap.zoomIn).toHaveBeenCalledTimes(1);
  expect(mockMap.zoomOut).toHaveBeenCalledTimes(1);
  mockMap.fitBounds.mockClear();
  fireEvent.click(screen.getByRole("button", { name: "Fit map to results" }));
  expect(mockMap.fitBounds).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Centre map on University of Manchester" }));
  expect(mockMap.setView).toHaveBeenLastCalledWith([53.46, -2.23], 14);
});

test("no re-centre control without a real anchor location (city/country search) — and no geolocation", () => {
  renderMap({ university: null, properties: [listing("a")] });
  expect(screen.queryByRole("button", { name: /Centre map on/ })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Fit map to results" })).toBeInTheDocument();
});

test("OpenStreetMap tiles and attribution are kept", () => {
  renderMap({ university: null, properties: [] });
  const tiles = screen.getByTestId("tiles");
  expect(tiles.dataset.attribution).toMatch(/OpenStreetMap/);
  expect(tiles.dataset.class).toBe("uh-map-tiles");
});

function renderPreview(property, university = null) {
  return render(<MemoryRouter><PropertyPreview property={property} university={university} /></MemoryRouter>);
}

test("preview shows image, name, area, room types, the stored price with its own duration, a rounded rating and the detail link", () => {
  renderPreview(listing("a"));
  expect(screen.getByText("Residence a")).toBeInTheDocument();
  expect(screen.getByText("London")).toBeInTheDocument();
  expect(screen.getByText("Studio · Ensuite")).toBeInTheDocument();
  expect(screen.getByText(/From £199/)).toHaveTextContent("From £199/week");
  expect(screen.getByText("4.6")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "View property" })).toHaveAttribute("href", "/property/slug-a");
  expect(screen.queryByText(/Sold out/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/Available/i)).not.toBeInTheDocument(); // availability is never asserted beyond the data
});

test("a monthly price keeps its monthly duration (never converted)", () => {
  renderPreview(listing("m", { price: { from: 1450, currency: "€", duration: "month" } }));
  expect(screen.getByText(/From €1450/)).toHaveTextContent("From €1450/month");
});

test("a sold-out property is labelled sold out and shows no bookable price", () => {
  renderPreview(listing("s", { isSoldOut: true }));
  expect(screen.getByText("Sold out")).toBeInTheDocument();
  expect(screen.queryByText(/From £/)).not.toBeInTheDocument();
});

test("missing optional data is hidden, not invented", () => {
  renderPreview(listing("x", { image: null, rooms: { types: [] }, rating: null, address: {}, price: { from: null, currency: "", duration: "" }, slug: null }));
  expect(screen.queryByRole("img")).not.toBeInTheDocument();
  expect(screen.getByText("Price on request")).toBeInTheDocument();
  expect(screen.queryByText(/★|\d\.\d/)).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Browse rooms" })).toHaveAttribute("href", "/find-rooms");
});

test("distance is shown only for a university search with a real distance", () => {
  renderPreview(listing("d", { distanceKm: 1.4 }), { name: "University of Manchester" });
  expect(screen.getByText("1.4 km from University of Manchester")).toBeInTheDocument();
});

// ── City / country boundary overlay ──

// Real New Zealand geometry from the live Nominatim capture used by
// scripts/verify-location-boundaries.js (a MultiPolygon: both main islands,
// Stewart Island, the Chatham Islands across the antimeridian, …).
const NOMINATIM_FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, "../../../scripts/fixtures/nominatim-boundaries.json"), "utf8"));
const NZ_GEOMETRY = NOMINATIM_FIXTURE["country:New Zealand"][0].geojson;

const LONDON_BOUNDARY = {
  key: "city|london|uk",
  name: "Greater London",
  geometry: { type: "Polygon", coordinates: [[[-0.51, 51.29], [0.33, 51.29], [0.33, 51.69], [-0.51, 51.69], [-0.51, 51.29]]] },
  bounds: [[51.29, -0.51], [51.69, 0.33]],
};
const NZ_BOUNDARY = { key: "country||new zealand", name: "New Zealand", geometry: NZ_GEOMETRY, bounds: [[-52.82, 165.55], [-34.2, 179.13]] };

const lastFit = () => mockMap.fitBounds.mock.calls[mockMap.fitBounds.mock.calls.length - 1];

test("city search draws the real city outline in the boundary pane with the brand style, under the property markers", () => {
  renderMap({ university: null, properties: [listing("a"), listing("b", { coordinates: { lat: 51.6, lng: -0.2 } })], locationKey: "CITY|London|UK", clusterMarkers: true, boundary: LONDON_BOUNDARY });

  const pane = screen.getByTestId("pane");
  expect(pane.dataset.name).toBe(BOUNDARY_PANE);
  expect(pane.dataset.pointerEvents).toBe("none");
  const layers = within(pane).getAllByTestId("geojson");
  expect(layers).toHaveLength(2); // white casing + plum outline/fill
  expect(layers.map((l) => l.dataset.name)).toEqual(["Greater London", "Greater London"]);
  expect(layers[1].dataset.color).toBe("#5E3A6B");
  expect(mockGeoJsonRenders.every((r) => r.interactive === false)).toBe(true);
  expect(mockGeoJsonRenders[1].data.geometry).toBe(LONDON_BOUNDARY.geometry);

  // Markers are untouched and live outside the boundary pane.
  expect(screen.getAllByTestId("marker")).toHaveLength(2);
  expect(within(pane).queryByTestId("marker")).not.toBeInTheDocument();
  expect(within(screen.getByTestId("cluster-group")).getAllByTestId("marker")).toHaveLength(2);
});

test("the boundary pane sits above tiles/overlays but below Leaflet's marker and popup panes (from leaflet.css itself)", () => {
  const css = fs.readFileSync(require.resolve("leaflet/dist/leaflet.css"), "utf8");
  const z = (pane) => Number(new RegExp(`\\.leaflet-${pane}-pane\\s*\\{\\s*z-index:\\s*(\\d+)`).exec(css)[1]);
  expect(BOUNDARY_PANE_Z_INDEX).toBeGreaterThan(z("tile"));
  expect(BOUNDARY_PANE_Z_INDEX).toBeGreaterThan(z("overlay"));
  expect(BOUNDARY_PANE_Z_INDEX).toBeLessThan(z("marker"));
  expect(BOUNDARY_PANE_Z_INDEX).toBeLessThan(z("popup"));
  // Translucent, never an opaque fill hiding roads/labels/markers.
  expect(BOUNDARY_STYLE.fillOpacity).toBeLessThanOrEqual(0.12);
  expect(BOUNDARY_CASING_STYLE.fill).toBe(false);
});

test("country MultiPolygon (real New Zealand data) renders every part through real Leaflet GeoJSON", () => {
  renderMap({ university: null, properties: [listing("a", { coordinates: { lat: -36.85, lng: 174.76 } })], locationKey: "COUNTRY||New Zealand", clusterMarkers: true, boundary: NZ_BOUNDARY });
  expect(screen.getAllByTestId("geojson")[1].dataset.geometryType).toBe("MultiPolygon");

  // The same data and options through the actual library the map uses.
  const layer = L.geoJSON(mockGeoJsonRenders[1].data, { style: BOUNDARY_STYLE, interactive: false });
  const polygons = layer.getLayers();
  expect(polygons).toHaveLength(1);
  expect(polygons[0]).toBeInstanceOf(L.Polygon);
  expect(polygons[0].getLatLngs()).toHaveLength(NZ_GEOMETRY.coordinates.length); // one entry per island part
  expect(polygons[0].options.fillOpacity).toBe(BOUNDARY_STYLE.fillOpacity);
  expect(polygons[0].options.interactive).toBe(false);
  const bounds = layer.getBounds();
  expect(bounds.contains([-36.85, 174.76])).toBe(true); // Auckland
  expect(bounds.contains([-43.53, 172.63])).toBe(true); // Christchurch
});

test("the map frames the boundary together with every property (a property outside the outline is never dropped)", () => {
  mockMap.fitBounds.mockClear();
  const outside = listing("far", { coordinates: { lat: 51.9, lng: -0.9 } });
  renderMap({ university: null, properties: [listing("a"), outside], locationKey: "CITY|London|UK", clusterMarkers: true, boundary: LONDON_BOUNDARY });
  const [bounds] = lastFit();
  expect(bounds.contains(L.latLngBounds(LONDON_BOUNDARY.bounds))).toBe(true);
  expect(bounds.contains([51.9, -0.9])).toBe(true);
  expect(screen.getAllByTestId("marker")).toHaveLength(2);
});

test("a boundary arriving after the first render re-frames once — unless the user already dragged the map", () => {
  mockMap.fitBounds.mockClear();
  const props = { university: null, properties: [listing("a")], locationKey: "CITY|London|UK", clusterMarkers: true };
  const { rerender } = renderMap({ ...props, boundary: null });
  const wrap = (p) => <MemoryRouter><UniversityHousingMap selectedId={null} onSelectProperty={() => {}} {...p} /></MemoryRouter>;

  mockMap.fitBounds.mockClear();
  rerender(wrap({ ...props, boundary: LONDON_BOUNDARY }));
  expect(mockMap.fitBounds).toHaveBeenCalledTimes(1);
  expect(lastFit()[0].contains(L.latLngBounds(LONDON_BOUNDARY.bounds))).toBe(true);

  // Re-rendering with the same boundary (a filter change) does not re-frame.
  rerender(wrap({ ...props, properties: [listing("a"), listing("b")], boundary: LONDON_BOUNDARY }));
  expect(mockMap.fitBounds).toHaveBeenCalledTimes(1);

  // New search; the user drags before its boundary arrives: the view is left alone.
  rerender(wrap({ ...props, locationKey: "CITY|Manchester|UK", boundary: null }));
  mockMapEvents.dragstart();
  mockMap.fitBounds.mockClear();
  rerender(wrap({ ...props, locationKey: "CITY|Manchester|UK", boundary: { ...LONDON_BOUNDARY, key: "city|manchester|uk", name: "Manchester" } }));
  expect(mockMap.fitBounds).not.toHaveBeenCalled();
});

test("changing the boundary replaces the outline (never two at once); removing it clears the overlay", () => {
  const props = { university: null, properties: [listing("a")], clusterMarkers: true };
  const wrap = (p) => <MemoryRouter><UniversityHousingMap selectedId={null} onSelectProperty={() => {}} {...p} /></MemoryRouter>;
  const { rerender } = renderMap({ ...props, locationKey: "CITY|London|UK", boundary: LONDON_BOUNDARY });
  rerender(wrap({ ...props, locationKey: "COUNTRY||New Zealand", boundary: NZ_BOUNDARY }));
  expect(screen.getAllByTestId("geojson").map((l) => l.dataset.name)).toEqual(["New Zealand", "New Zealand"]);
  rerender(wrap({ ...props, locationKey: "CITY|Dubai|UAE", boundary: null }));
  expect(screen.queryByTestId("geojson")).not.toBeInTheDocument();
  expect(screen.getAllByTestId("marker")).toHaveLength(1);
});

test("missing boundary: no overlay, markers and the existing point-based framing are unchanged", () => {
  mockMap.fitBounds.mockClear();
  renderMap({ university: null, properties: [listing("a"), listing("b", { coordinates: { lat: 51.6, lng: -0.2 } })], locationKey: "CITY|Dubai|UAE", clusterMarkers: true, boundary: null });
  expect(screen.queryByTestId("geojson")).not.toBeInTheDocument();
  expect(screen.getAllByTestId("marker")).toHaveLength(2);
  const [bounds] = lastFit();
  expect(bounds.getSouthWest()).toEqual(L.latLng(51.5, -0.2));
  expect(bounds.getNorthEast()).toEqual(L.latLng(51.6, -0.12));
});

test("a university search never draws a boundary, even if one is passed", () => {
  mockMap.setView.mockClear();
  renderMap({
    university: { id: "u", name: "University of Manchester", type: "UNIVERSITY", latitude: 53.46, longitude: -2.23 },
    properties: [listing("a", { coordinates: { lat: 53.47, lng: -2.24 }, distanceKm: 1.2 })],
    boundary: LONDON_BOUNDARY,
  });
  expect(screen.queryByTestId("geojson")).not.toBeInTheDocument();
  expect(screen.getAllByTestId("marker").find((m) => m.dataset.title === "University of Manchester")).toBeDefined();
});
