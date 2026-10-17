import React from "react";
import { render, screen, fireEvent, waitFor, within, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import AccommodationSearchExperience from "./AccommodationSearchExperience";
import {
  getLocationSearchInventory,
  getUniversityHousingInventory,
  getProperties,
  getPropertyBySlug,
} from "../../services/amberApi";
import { searchUniversityDiscovery } from "../../services/universityDiscoveryApi";
import { getLocationBoundary } from "../../services/boundaryApi";

// The integrated search experience (rendered by the homepage) is the unit
// under test — its data source and the Leaflet map are
// stubbed. The map stub records the exact `properties` array it was handed so
// tests can assert that the map and the list draw one shared result set.
jest.mock("../../services/amberApi", () => ({
  getLocationSearchInventory: jest.fn(),
  getUniversityHousingInventory: jest.fn(),
  getProperties: jest.fn(),
  getPropertyBySlug: jest.fn(),
}));
jest.mock("../../services/universityDiscoveryApi", () => ({
  searchUniversityDiscovery: jest.fn(),
  confirmUniversityCandidate: jest.fn(),
  resolveUniversityById: jest.fn().mockResolvedValue(null),
}));
jest.mock("../../services/boundaryApi", () => ({ getLocationBoundary: jest.fn() }));
jest.mock("../listing/WishlistHeart", () => () => null);
jest.mock("./UniversityHousingMap", () => {
  const mapRenders = [];
  function MockMap(props) {
    mapRenders.push(props);
    return <div data-testid="map" data-count={props.properties.length} />;
  }
  MockMap.mapRenders = mapRenders;
  return MockMap;
});
// eslint-disable-next-line import/first
import UniversityHousingMap from "./UniversityHousingMap";

function residence(id, city, overrides = {}) {
  return {
    propertyId: id,
    slug: `slug-${id}`,
    propertyName: `Residence ${id}`,
    city,
    country: "United Kingdom",
    latitude: 53.47,
    longitude: -2.24,
    price: { amount: 180, currency: "£" },
    priceDuration: "week",
    priceWeekly: 180,
    available: true,
    ...overrides,
  };
}

function inventory(residences, extra = {}) {
  return { status: residences.length ? "ready" : "building", residences, country: "United Kingdom", total: residences.length, page: 1, hasMore: false, ...extra };
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function renderAt(url) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <AccommodationSearchExperience />
    </MemoryRouter>
  );
}

const listedNames = () => screen.queryAllByRole("heading", { level: 4 }).map((h) => h.textContent);
const lastMapProps = () => UniversityHousingMap.mapRenders[UniversityHousingMap.mapRenders.length - 1];

beforeEach(() => {
  jest.clearAllMocks();
  UniversityHousingMap.mapRenders.length = 0;
  getLocationBoundary.mockResolvedValue(null);
});

function boundaryFor(name, geometryType = "Polygon") {
  return {
    key: `boundary:${name}`,
    name,
    geometry: geometryType === "Polygon"
      ? { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }
      : { type: "MultiPolygon", coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]], [[[5, 5], [6, 5], [6, 6], [5, 5]]]] },
    bounds: [[0, 0], [6, 6]],
  };
}

// Drives a new search through the search box, as a user would.
async function searchFor(query, record) {
  searchUniversityDiscovery.mockResolvedValue({ status: "resolved", data: record });
  fireEvent.click(screen.getByRole("button", { name: /Change/ }));
  fireEvent.change(screen.getByRole("textbox", { name: /Search a university/ }), { target: { value: query } });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
}
const MANCHESTER = { id: "city:UK:manchester", name: "Manchester", type: "CITY", city: "Manchester", country: "United Kingdom", countryCode: "UK" };
const GERMANY = { id: "country:Germany", name: "Germany", type: "COUNTRY", city: null, country: "Germany", countryCode: "Germany" };

test("city search lists every city property (including one without coordinates) and the map gets the same set", async () => {
  getLocationSearchInventory.mockResolvedValue(inventory([
    residence("a", "manchester"),
    residence("b", "manchester", { latitude: null, longitude: null }),
    residence("c", "manchester", { latitude: 53.72, longitude: -2.6, available: false }),
  ]));

  renderAt("/?city=Manchester&country=UK");

  expect(await screen.findByRole("heading", { level: 2, name: /Accommodation in Manchester/ })).toBeInTheDocument();
  await waitFor(() => expect(listedNames()).toHaveLength(3));
  expect(screen.getByText("3 student properties found in Manchester")).toBeInTheDocument();
  expect(getLocationSearchInventory).toHaveBeenCalledTimes(1);
  expect(getLocationSearchInventory).toHaveBeenCalledWith({ type: "city", city: "Manchester", country: "UK", page: 1 });
  expect(getUniversityHousingInventory).not.toHaveBeenCalled();
  expect(getProperties).not.toHaveBeenCalled();
  expect(getPropertyBySlug).not.toHaveBeenCalled();

  await waitFor(() => expect(lastMapProps()).toBeDefined());
  const map = lastMapProps();
  expect(map.university).toBeNull();
  expect(map.clusterMarkers).toBe(true);
  expect(map.properties.map((p) => p.name).sort()).toEqual([...listedNames()].sort());
  // No anchor point exists, so no distance is shown or fabricated.
  expect(screen.queryByText(/km away/)).not.toBeInTheDocument();
  // Sold-out state is preserved.
  expect(screen.getAllByText("Sold Out").length).toBeGreaterThan(0);
});

test("country search shows a country heading, pages through the full result set, and keeps map and list in sync", async () => {
  getLocationSearchInventory
    .mockResolvedValueOnce(inventory([residence("l1", "london"), residence("m1", "manchester")], { total: 3, hasMore: true }))
    .mockResolvedValueOnce(inventory([residence("e1", "edinburgh")], { total: 3, page: 2, hasMore: false }));

  renderAt("/?country=UK");

  expect(await screen.findByRole("heading", { level: 2, name: /Accommodation in the United Kingdom/ })).toBeInTheDocument();
  expect(await screen.findByText("Showing 2 of 3 student properties in the United Kingdom")).toBeInTheDocument();
  expect(getLocationSearchInventory).toHaveBeenCalledWith({ type: "country", city: null, country: "UK", page: 1 });

  fireEvent.click(screen.getByRole("button", { name: "Load more properties" }));

  await waitFor(() => expect(listedNames()).toHaveLength(3));
  expect(getLocationSearchInventory).toHaveBeenLastCalledWith({ type: "country", city: null, country: "UK", page: 2 });
  expect(screen.getByText("3 student properties found in the United Kingdom")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Load more properties" })).not.toBeInTheDocument();
  expect(lastMapProps().properties.map((p) => p.name).sort()).toEqual([...listedNames()].sort());
});

test("an empty city shows the empty state, not an error", async () => {
  getLocationSearchInventory.mockResolvedValue(inventory([]));
  renderAt("/?city=Leeds&country=UK");
  expect(await screen.findByText("We don't currently have properties in Leeds.")).toBeInTheDocument();
  expect(screen.queryByText(/couldn't load properties/i)).not.toBeInTheDocument();
});

test("a failed inventory request shows a recoverable error, not a false empty state", async () => {
  getLocationSearchInventory
    .mockRejectedValueOnce(new Error("Could not load property data right now."))
    .mockResolvedValueOnce(inventory([residence("a", "leeds")]));

  renderAt("/?city=Leeds&country=UK");

  expect(await screen.findByText(/We couldn't load properties right now/)).toBeInTheDocument();
  expect(screen.queryByText(/We don't currently have properties/)).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(listedNames()).toEqual(["Residence a"]));
});

test("a slower earlier search can never replace the results of a newer one", async () => {
  const slowLeeds = deferred();
  getLocationSearchInventory.mockImplementation(({ city }) => (
    city === "Leeds" ? slowLeeds.promise : Promise.resolve(inventory([residence("m1", "manchester")]))
  ));
  searchUniversityDiscovery.mockResolvedValue({
    status: "resolved",
    data: { id: "city:UK:manchester", name: "Manchester", type: "CITY", city: "Manchester", country: "United Kingdom", countryCode: "UK" },
  });

  renderAt("/?city=Leeds&country=UK");
  await screen.findByRole("heading", { level: 2, name: /Accommodation in Leeds/ });

  fireEvent.click(screen.getByRole("button", { name: /Change/ }));
  fireEvent.change(screen.getByRole("textbox", { name: /Search a university/ }), { target: { value: "Manchester" } });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));

  expect(await screen.findByRole("heading", { level: 2, name: /Accommodation in Manchester/ })).toBeInTheDocument();
  await waitFor(() => expect(listedNames()).toEqual(["Residence m1"]));
  expect(searchUniversityDiscovery).toHaveBeenCalledWith("Manchester", expect.objectContaining({ includeLocations: true }));

  await act(async () => { slowLeeds.resolve(inventory([residence("l1", "leeds")])); });

  expect(listedNames()).toEqual(["Residence m1"]);
  expect(lastMapProps().properties.map((p) => p.name)).toEqual(["Residence m1"]);
});

test("university search is unchanged: university-centred inventory, university marker and real distances", async () => {
  getUniversityHousingInventory.mockResolvedValue({
    status: "ready",
    residences: [residence("u1", "manchester", { latitude: 53.47, longitude: -2.24 })],
  });

  renderAt("/?university=university-of-manchester");

  const info = await screen.findByRole("heading", { level: 2, name: /University of Manchester/ });
  expect(within(info).getByText("University")).toBeInTheDocument();
  await waitFor(() => expect(listedNames()).toEqual(["Residence u1"]));
  expect(getUniversityHousingInventory).toHaveBeenCalledWith("Manchester", "MEDIUM", "university-housing");
  expect(getLocationSearchInventory).not.toHaveBeenCalled();
  expect(screen.getByText(/km away/)).toBeInTheDocument();
  await waitFor(() => expect(lastMapProps()).toBeDefined());
  const map = lastMapProps();
  expect(map.university?.id).toBe("university-of-manchester");
  expect(map.clusterMarkers).toBe(false);
});

// ── City / country boundary overlay ──

test("a city search fetches the city's boundary separately from inventory and hands it to the map", async () => {
  const london = boundaryFor("Greater London");
  getLocationBoundary.mockResolvedValue(london);
  getLocationSearchInventory.mockResolvedValue(inventory([residence("a", "london"), residence("b", "london")]));

  renderAt("/?city=London&country=UK");

  await waitFor(() => expect(lastMapProps()?.boundary).toBe(london));
  expect(getLocationBoundary).toHaveBeenCalledTimes(1);
  expect(getLocationBoundary).toHaveBeenCalledWith({ type: "city", city: "London", country: "UK" });
  expect(getLocationSearchInventory).toHaveBeenCalledTimes(1);
  expect(lastMapProps().properties).toHaveLength(2);
});

test("a country search fetches the country's boundary (MultiPolygon passed through intact)", async () => {
  const uk = boundaryFor("United Kingdom", "MultiPolygon");
  getLocationBoundary.mockResolvedValue(uk);
  getLocationSearchInventory.mockResolvedValue(inventory([residence("a", "london")]));

  renderAt("/?country=UK");

  await waitFor(() => expect(lastMapProps()?.boundary).toBe(uk));
  expect(getLocationBoundary).toHaveBeenCalledWith({ type: "country", city: null, country: "UK" });
  expect(lastMapProps().boundary.geometry.coordinates).toHaveLength(2);
});

test("changing location replaces the boundary: the old outline is cleared at once, city -> city -> country", async () => {
  const boundaries = { London: boundaryFor("Greater London"), Manchester: boundaryFor("Manchester"), Germany: boundaryFor("Germany", "MultiPolygon") };
  const manchesterBoundary = deferred();
  getLocationBoundary.mockImplementation(({ city, country }) => (
    city === "Manchester" ? manchesterBoundary.promise : Promise.resolve(boundaries[city || country])
  ));
  getLocationSearchInventory.mockImplementation(({ city, country }) => Promise.resolve(inventory([residence(`${city || country}-1`, city || country)])));

  renderAt("/?city=London&country=UK");
  await waitFor(() => expect(lastMapProps()?.boundary?.name).toBe("Greater London"));

  await searchFor("Manchester", MANCHESTER);
  await waitFor(() => expect(listedNames()).toEqual(["Residence Manchester-1"]));
  // Manchester's outline hasn't arrived yet — London's must already be gone.
  expect(lastMapProps().boundary).toBeNull();
  await act(async () => { manchesterBoundary.resolve(boundaries.Manchester); });
  expect(lastMapProps().boundary.name).toBe("Manchester");

  await searchFor("Germany", GERMANY);
  await waitFor(() => expect(lastMapProps()?.boundary?.name).toBe("Germany"));
  expect(listedNames()).toEqual(["Residence Germany-1"]);
});

test("an out-of-order boundary response for an earlier search can never be drawn over the current one", async () => {
  const slowLondon = deferred();
  getLocationBoundary.mockImplementation(({ city }) => (city === "London" ? slowLondon.promise : Promise.resolve(boundaryFor("Manchester"))));
  getLocationSearchInventory.mockImplementation(({ city }) => Promise.resolve(inventory([residence(`${city}-1`, city)])));

  renderAt("/?city=London&country=UK");
  await waitFor(() => expect(listedNames()).toEqual(["Residence London-1"]));

  await searchFor("Manchester", MANCHESTER);
  await waitFor(() => expect(lastMapProps()?.boundary?.name).toBe("Manchester"));

  await act(async () => { slowLondon.resolve(boundaryFor("Greater London")); });
  expect(lastMapProps().boundary.name).toBe("Manchester");
  expect(UniversityHousingMap.mapRenders.some((p) => p.boundary?.name === "Greater London")).toBe(false);
});

test("a missing or failed boundary leaves listings intact and causes no extra inventory request", async () => {
  getLocationBoundary.mockResolvedValue(null); // the client's contract for not_found / unavailable / network error
  getLocationSearchInventory.mockResolvedValue(inventory([residence("a", "dubai"), residence("b", "dubai")]));

  renderAt("/?city=Dubai&country=UAE");

  await waitFor(() => expect(listedNames()).toHaveLength(2));
  await waitFor(() => expect(getLocationBoundary).toHaveBeenCalledTimes(1));
  expect(getLocationSearchInventory).toHaveBeenCalledTimes(1);
  expect(getProperties).not.toHaveBeenCalled();
  expect(getPropertyBySlug).not.toHaveBeenCalled();
  expect(screen.queryByText(/couldn't load properties/i)).not.toBeInTheDocument();
  expect(lastMapProps().boundary).toBeNull();
  expect(lastMapProps().properties).toHaveLength(2);
});

test("a university search requests no boundary and passes none to the map", async () => {
  getUniversityHousingInventory.mockResolvedValue({ status: "ready", residences: [residence("u1", "manchester")] });

  renderAt("/?university=university-of-manchester");

  await waitFor(() => expect(listedNames()).toEqual(["Residence u1"]));
  expect(getLocationBoundary).not.toHaveBeenCalled();
  expect(lastMapProps().boundary == null).toBe(true);
});
