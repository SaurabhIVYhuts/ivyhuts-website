import { getLocationBoundary, boundaryKey, _resetBoundaryCache } from "./boundaryApi";

const POLYGON = { type: "Polygon", coordinates: [[[-0.5, 51.3], [0.3, 51.3], [0.3, 51.7], [-0.5, 51.3]]] };
const found = { ok: true, status: "found", name: "Greater London", geometry: POLYGON, bounds: [[51.3, -0.5], [51.7, 0.3]], attribution: "© OpenStreetMap contributors (ODbL)" };
const respond = (body) => Promise.resolve({ json: () => Promise.resolve(body) });

beforeEach(() => {
  _resetBoundaryCache();
  global.fetch = jest.fn();
});
afterAll(() => { delete global.fetch; });

test("requests the boundary endpoint with the search's type/city/country and returns renderable data", async () => {
  global.fetch.mockReturnValue(respond(found));
  const b = await getLocationBoundary({ type: "city", city: "London", country: "UK" });
  expect(global.fetch).toHaveBeenCalledWith("/api/location-boundary?type=city&city=London&country=UK");
  expect(b).toEqual({ key: boundaryKey({ type: "city", city: "London", country: "UK" }), name: "Greater London", geometry: POLYGON, bounds: found.bounds, attribution: found.attribution });
});

test("caching: repeated and concurrent lookups for the same location make one request", async () => {
  global.fetch.mockReturnValue(respond(found));
  const [a, b] = await Promise.all([
    getLocationBoundary({ type: "city", city: "London", country: "UK" }),
    getLocationBoundary({ type: "city", city: "london", country: "uk" }),
  ]);
  await getLocationBoundary({ type: "city", city: "London", country: "UK" });
  expect(global.fetch).toHaveBeenCalledTimes(1);
  expect(a).toBe(b);
  await getLocationBoundary({ type: "country", country: "UK" });
  expect(global.fetch).toHaveBeenCalledTimes(2); // a different location is a different entry
});

test("not_found and unavailable resolve to null and are cached (briefly) rather than retried every render", async () => {
  global.fetch.mockReturnValueOnce(respond({ ok: true, status: "not_found" })).mockReturnValueOnce(respond({ ok: true, status: "unavailable" }));
  expect(await getLocationBoundary({ type: "city", city: "Dubai", country: "UAE" })).toBeNull();
  expect(await getLocationBoundary({ type: "city", city: "Dubai", country: "UAE" })).toBeNull();
  expect(await getLocationBoundary({ type: "country", country: "Germany" })).toBeNull();
  expect(await getLocationBoundary({ type: "country", country: "Germany" })).toBeNull();
  expect(global.fetch).toHaveBeenCalledTimes(2);
});

test("never rejects: network errors, bad JSON, invalid geometry/bounds and a missing fetch all resolve to null", async () => {
  global.fetch.mockReturnValueOnce(Promise.reject(new Error("offline")));
  expect(await getLocationBoundary({ type: "country", country: "A" })).toBeNull();
  global.fetch.mockReturnValueOnce(Promise.resolve({ json: () => Promise.reject(new SyntaxError("bad")) }));
  expect(await getLocationBoundary({ type: "country", country: "B" })).toBeNull();
  global.fetch.mockReturnValueOnce(respond({ ...found, geometry: { type: "Point", coordinates: [0, 0] } }));
  expect(await getLocationBoundary({ type: "country", country: "C" })).toBeNull();
  global.fetch.mockReturnValueOnce(respond({ ...found, bounds: null }));
  expect(await getLocationBoundary({ type: "country", country: "D" })).toBeNull();
  delete global.fetch;
  await expect(getLocationBoundary({ type: "country", country: "E" })).resolves.toBeNull();
});
