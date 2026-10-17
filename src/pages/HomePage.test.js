import React from "react";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import App from "../App";
import {
  getLocationSearchInventory,
  getUniversityHousingInventory,
  getProperties,
  getInventoryStats,
} from "../services/amberApi";
import { searchUniversityDiscovery } from "../services/universityDiscoveryApi";

// The homepage is now the canonical accommodation search. Rendered through
// the real App router so links, redirects and URL state are exercised for
// real; only the network-facing services and the Leaflet map are stubbed.
jest.mock("../services/amberApi", () => ({
  getLocationSearchInventory: jest.fn(),
  getUniversityHousingInventory: jest.fn(),
  getProperties: jest.fn(),
  getPropertyBySlug: jest.fn(),
  getCityListings: jest.fn(),
  getCountryListings: jest.fn(),
  getInventoryStats: jest.fn(),
  getCachedCityStats: jest.fn(),
  lazyFetchCityStats: jest.fn(),
}));
jest.mock("../services/universityDiscoveryApi", () => ({
  searchUniversityDiscovery: jest.fn(),
  confirmUniversityCandidate: jest.fn(),
  resolveUniversityById: jest.fn().mockResolvedValue(null),
}));
jest.mock("../components/universityHousing/UniversityHousingMap", () => {
  const mapRenders = [];
  function MockMap(props) {
    mapRenders.push(props);
    return <div data-testid="map" />;
  }
  MockMap.mapRenders = mapRenders;
  return MockMap;
});
// eslint-disable-next-line import/first
import UniversityHousingMap from "../components/universityHousing/UniversityHousingMap";

function residence(id, city, overrides = {}) {
  return {
    propertyId: id, slug: `slug-${id}`, propertyName: `Residence ${id}`, city, country: "United Kingdom",
    latitude: 51.5, longitude: -0.12, price: { amount: 220, currency: "£" }, priceDuration: "week",
    priceWeekly: 220, available: true, ...overrides,
  };
}
function inventory(residences, extra = {}) {
  return { status: "ready", residences, country: "United Kingdom", total: residences.length, page: 1, hasMore: false, ...extra };
}

function renderAppAt(url) {
  window.history.pushState({}, "", url);
  return render(<App />);
}
// Property rows inside the search results section only (the homepage has
// other h4 headings — steps, footer columns).
const listedNames = () => {
  const results = screen.queryByRole("region", { name: "Accommodation search results" });
  return results ? within(results).queryAllByRole("heading", { level: 4 }).map((h) => h.textContent) : [];
};

beforeEach(() => {
  jest.clearAllMocks();
  UniversityHousingMap.mapRenders.length = 0;
  getProperties.mockResolvedValue([]);
  getInventoryStats.mockResolvedValue({ ready: true, total: 4281, soldOut: 1060, remaining: 3221, stale: false });
  try { window.localStorage.clear(); } catch { /* ignore */ }
});

test("the hero shows the live Total / Sold Out / Remaining counts from the shared stats endpoint, without disturbing search", async () => {
  renderAppAt("/");

  const hero = await screen.findByRole("region", { name: /From Housing to Hiring/ });
  const stats = within(hero).getByRole("list", { name: "Live IVYHUTS inventory" });
  await waitFor(() => expect(within(stats).getAllByRole("listitem").map((c) => c.textContent)).toEqual([
    "4,281Total Inventory",
    "1,060Sold Out",
    "3,221Remaining",
  ]), { timeout: 3000 });

  // One site-wide stats request; it never triggers an inventory/listing fetch.
  expect(getInventoryStats).toHaveBeenCalledTimes(1);
  expect(getLocationSearchInventory).not.toHaveBeenCalled();
  expect(getUniversityHousingInventory).not.toHaveBeenCalled();

  // The rest of the hero is intact.
  expect(within(hero).getByText("A Venture By IIM Alums")).toBeInTheDocument();
  expect(within(hero).getByRole("link", { name: /Talk to an Advisor/ })).toHaveAttribute("href", "/contact");
  expect(within(hero).getAllByRole("textbox", { name: /Search a university, school, city or country/ })).toHaveLength(1);
  expect(within(hero).getByRole("link", { name: "London" })).toBeInTheDocument();
});

test("the simplified hero has no description, trust row or photo credit", async () => {
  renderAppAt("/");

  const hero = await screen.findByRole("region", { name: /From Housing to Hiring/ });
  expect(within(hero).queryByText(/Find verified student homes/)).not.toBeInTheDocument();
  expect(within(hero).queryByRole("list", { name: /Why students book with IVYHUTS/ })).not.toBeInTheDocument();
  for (const usp of [/100% Verified/i, /No Visa No Pay/i, /No Hidden Fees/i, /24\/7 Support/i]) {
    expect(within(hero).queryByText(usp)).not.toBeInTheDocument();
  }
  expect(within(hero).queryByText(/Shixart1985/)).not.toBeInTheDocument();
  expect(within(hero).queryByRole("img")).not.toBeInTheDocument();
});

test("homepage renders the search-first hero, one search box, FAQ and footer — and loads no inventory until a search is made", async () => {
  renderAppAt("/");

  expect(await screen.findByRole("heading", { level: 1, name: /From Housing to Hiring/ })).toBeInTheDocument();
  expect(screen.getAllByRole("textbox", { name: /Search a university, school, city or country/ })).toHaveLength(1);
  expect(screen.getByRole("heading", { name: /Popular Cities/i })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: /Frequently Asked Questions/ })).toBeInTheDocument();
  expect(screen.getAllByRole("link", { name: "Find Accommodation" }).some((a) => a.getAttribute("href") === "/#find-accommodation")).toBe(true);
  expect(screen.queryAllByRole("link", { name: /University Housing/ })).toHaveLength(0);

  expect(getLocationSearchInventory).not.toHaveBeenCalled();
  expect(getUniversityHousingInventory).not.toHaveBeenCalled();
  expect(screen.queryByTestId("map")).not.toBeInTheDocument();
});

test("a popular-destination city card opens the integrated city search on the homepage", async () => {
  getLocationSearchInventory.mockResolvedValue(inventory([residence("a", "london"), residence("b", "london", { latitude: null, longitude: null })]));
  renderAppAt("/");

  const grid = await screen.findByRole("region", { name: /Popular Cities Across The Globe/ });
  const londonCard = within(grid).getByRole("link", { name: /accommodation in London, United Kingdom/ });
  expect(londonCard).toHaveAttribute("href", "/?city=London&country=UK");
  fireEvent.click(londonCard);

  expect(await screen.findByRole("heading", { level: 2, name: /Accommodation in London/ })).toBeInTheDocument();
  await waitFor(() => expect(listedNames().sort()).toEqual(["Residence a", "Residence b"]));
  expect(getLocationSearchInventory).toHaveBeenCalledTimes(1);
  expect(getLocationSearchInventory).toHaveBeenCalledWith({ type: "city", city: "London", country: "UK", page: 1 });
  expect(window.location.pathname).toBe("/");
  expect(window.location.search).toBe("?city=London&country=UK");
  await waitFor(() => expect(UniversityHousingMap.mapRenders.length).toBeGreaterThan(0));
  const mapProps = UniversityHousingMap.mapRenders[UniversityHousingMap.mapRenders.length - 1];
  expect(mapProps.properties.map((p) => p.name).sort()).toEqual(["Residence a", "Residence b"]);
});

test("a country card opens a whole-country search (not a capital-city search)", async () => {
  getLocationSearchInventory.mockResolvedValue(inventory([residence("l1", "london"), residence("m1", "manchester")]));
  renderAppAt("/");

  const section = await screen.findByRole("region", { name: /Study Destinations by Country/ });
  fireEvent.click(within(section).getByRole("link", { name: /United Kingdom/ }));

  expect(await screen.findByRole("heading", { level: 2, name: /Accommodation in the United Kingdom/ })).toBeInTheDocument();
  expect(getLocationSearchInventory).toHaveBeenCalledWith({ type: "country", city: null, country: "UK", page: 1 });
});

test("the retired /university-housing route redirects to the homepage, keeping the search", async () => {
  getLocationSearchInventory.mockResolvedValue(inventory([residence("e1", "leeds")]));
  renderAppAt("/university-housing?city=Leeds&country=UK");

  expect(await screen.findByRole("heading", { level: 2, name: /Accommodation in Leeds/ })).toBeInTheDocument();
  expect(window.location.pathname).toBe("/");
  expect(window.location.search).toBe("?city=Leeds&country=UK");
  expect(getLocationSearchInventory).toHaveBeenCalledWith({ type: "city", city: "Leeds", country: "UK", page: 1 });
});

test("a bare /university-housing link lands on the homepage search anchor", async () => {
  renderAppAt("/university-housing");
  expect(await screen.findByRole("heading", { level: 1, name: /From Housing to Hiring/ })).toBeInTheDocument();
  expect(window.location.pathname).toBe("/");
  expect(window.location.hash).toBe("#find-accommodation");
});

test("a university link (old Find Room ?university=) opens the university-centred search on the homepage", async () => {
  getUniversityHousingInventory.mockResolvedValue({ status: "ready", residences: [residence("u1", "manchester", { latitude: 53.47, longitude: -2.24 })] });
  renderAppAt("/properties?university=university-of-manchester");

  expect(await screen.findByRole("heading", { level: 2, name: /University of Manchester/ })).toBeInTheDocument();
  expect(window.location.pathname).toBe("/");
  await waitFor(() => expect(listedNames()).toEqual(["Residence u1"]));
  expect(getUniversityHousingInventory).toHaveBeenCalledWith("Manchester", "MEDIUM", "university-housing");
  expect(screen.getByText(/km away/)).toBeInTheDocument();
});

test("the hero search accepts a pasted Google Maps link and resolves it through the location-aware resolver", async () => {
  searchUniversityDiscovery.mockResolvedValue({
    status: "resolved",
    data: { id: "country:Germany", name: "Germany", type: "COUNTRY", city: null, country: "Germany", countryCode: "Germany" },
  });
  getLocationSearchInventory.mockResolvedValue(inventory([residence("b1", "berlin", { country: "Germany" })], { country: "Germany" }));
  renderAppAt("/");

  const url = "https://www.google.com/maps/place/Germany/@51.1657,10.4515,6z";
  fireEvent.change(await screen.findByRole("textbox", { name: /Search a university/ }), { target: { value: url } });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));

  expect(await screen.findByRole("heading", { level: 2, name: /Accommodation in Germany/ })).toBeInTheDocument();
  expect(searchUniversityDiscovery).toHaveBeenCalledWith(url, expect.objectContaining({ includeLocations: true }));
  expect(getLocationSearchInventory).toHaveBeenCalledWith({ type: "country", city: null, country: "Germany", page: 1 });
  expect(window.location.search).toBe("?country=Germany");
});
