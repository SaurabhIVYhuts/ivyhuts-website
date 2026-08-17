// Parses a pasted Google Maps URL (or a short-link's resolved canonical URL)
// into a location CANDIDATE — never a trusted university record on its own.
// The name/coordinates extracted here are only ever handed to the EXISTING
// university resolver (api/_lib/universityResolveService.js's
// resolveGoogleMapsCandidate(), reached through the normal
// /api/universities/resolve endpoint) for independent verification — this
// module does no verification itself, only safe, deterministic string/URL
// parsing. See api/_lib/googleMapsParser.js for the server-side twin (same
// logic/shape, duplicated rather than cross-imported — same precedent as
// this file's own geoDistance.js vs api/_lib/accommodationIndex.js's private
// haversineKm, and campusUniversityResolver.js's frontend/backend split).
//
// ── Universal, multi-signal parsing (this is NOT a single-format parser) ──
// A Google Maps URL can take several distinct shapes, each carrying its
// location evidence in a different place. This module classifies the URL's
// shape (urlType) FIRST, then extracts name/coordinates using the
// extraction strategy appropriate to that shape — it never assumes every
// Google Maps URL looks like a /place/<name>/@<lat>,<lng>/ URL. Supporting a
// URL shape Google introduces in the future means adding a new urlType
// branch here — it should never require touching the university resolver,
// the search UI, or any per-institution logic anywhere in this codebase.
//
// Recognized urlType values:
//   "place"      /maps/place/<name>/@<lat>,<lng>,<zoom>[/data=...]
//                 the most information-rich shape — a name AND (usually) a
//                 precise per-place coordinate embedded in `data=`.
//   "search"     /maps/search/?api=1&query=<name-or-lat,lng>
//                 the documented Google Maps Search URL API format — the
//                 `query` param is either a place name or a raw coordinate
//                 pair; this module tells the two apart deterministically
//                 (a bare `<lat>,<lng>` pattern) rather than guessing.
//   "directions" /maps/dir/?api=1&destination=<name-or-lat,lng> (or the
//                 legacy path form /maps/dir/<origin>/<destination>/@...)
//                 ONLY the destination is ever treated as location evidence
//                 — never the origin/waypoints, and never the route's
//                 bounding-box viewport center (see below).
//   "location"   everything else recognized as a Google Maps host+path: a
//                 bare /maps/@<lat>,<lng>,<zoom> (coordinate-only, no name),
//                 the legacy maps.google.com/maps?q=<name-or-coords> form,
//                 or any other /maps path without a more specific strategy.
//
// ── Coordinate priority (multi-signal, never "just take the first pair") ──
// Google Maps URLs frequently carry MORE THAN ONE coordinate pair — e.g. a
// /place/ URL's /@<lat>,<lng>/ is the MAP VIEWPORT center (wherever the map
// happened to be panned/zoomed when the link was generated — can
// legitimately be a meaningful distance from the actual place), while a
// `!3d<lat>!4d<lng>` pair inside `data=` is the precise place PIN. This
// module always prefers, in order:
//   1. the precise `!3d<lat>!4d<lng>` place-pin pattern, if present at all
//      (checked FIRST, regardless of urlType — Google embeds this in
//      /place/ URLs, and occasionally in /search/ or /dir/ URLs too)
//   2. a urlType-appropriate query-parameter coordinate pair (`search`'s
//      `query=<lat>,<lng>`, `directions`'s `destination=<lat>,<lng>`, the
//      legacy `q=`/`ll=` pair)
//   3. the `/@<lat>,<lng>/` viewport center — EXCEPT for "directions" URLs,
//      where it is deliberately never used (see below)
// Every extracted pair still passes the SAME range/finite/non-null-island
// validation as before this milestone (validCoordPair(), built on the
// existing hasValidCoords()) — no second validator.
//
// ── Why "directions" never falls back to the viewport ──
// For a route between two points, `/@<lat>,<lng>,<zoom>/` is the map's
// bounding-box center for the WHOLE ROUTE, not the destination's own
// location — it can be many kilometers from either endpoint. Trusting it as
// "the university's coordinate" would silently feed a wrong location into
// the proximity cross-check in resolveGoogleMapsCandidate(). A directions
// URL therefore only ever contributes a NAME (the destination) unless a
// precise `!3d/!4d` pin also happens to be present — the true coordinate is
// then obtained the same way a plain name search already gets one: via the
// existing university resolver's own Nominatim geocoding.
//
// ── placeId — preserved, never depended upon ──
// Some /place/ URLs embed a stable Google "topic" identifier as
// `!16z<base64>`, which decodes to a `/m/...` or `/g/...` Knowledge-Graph-
// style id. When present and well-formed, it's surfaced as `placeId` purely
// for traceability/future use — nothing in this codebase's resolution logic
// requires it, and every code path here still works correctly when it's
// null (the common case: most Google Maps URL shapes don't carry one).
//
// Only an explicit host allow-list is recognized (google.com/maps,
// www.google.com/maps, maps.google.com, goo.gl/maps, maps.app.goo.gl) — this
// module never fetches the URL itself, so there is no SSRF surface here.
// Short links (goo.gl/maps/*, maps.app.goo.gl/*) carry no coordinates in the
// URL text; resolving one is handled server-side by
// api/_lib/googleMapsShortLinkResolver.js — this module still just reports
// isShortLink:true rather than resolving it itself.
import { hasValidCoords } from "./geoDistance";

// Generous enough for a real Google Maps URL (which can carry a long `data=`
// parameter) while still bounding parsing work on adversarial input.
export const MAX_URL_LENGTH = 2000;

const FULL_HOSTS = new Set(["google.com", "www.google.com", "maps.google.com"]);

function classifyHost(url) {
  const host = url.hostname.toLowerCase();
  if (host === "maps.app.goo.gl") return "short";
  if (host === "goo.gl") return url.pathname.toLowerCase().startsWith("/maps") ? "short" : null;
  if (host === "maps.google.com") return "full";
  if (FULL_HOSTS.has(host)) return url.pathname.toLowerCase().startsWith("/maps") ? "full" : null;
  return null;
}

// Classifies a "full" Google Maps URL's SHAPE, so the right extraction
// strategy can be chosen below. Checked in specificity order — a URL is
// "place" if `/place/` appears anywhere in its path, checked before
// `/dir/`/`/search/`, since Google never mixes those shapes in one real URL
// but this ordering is defensive regardless.
function classifyUrlType(url) {
  const path = url.pathname.toLowerCase();
  if (path.includes("/place/")) return "place";
  if (path.includes("/dir/") || path.endsWith("/dir")) return "directions";
  if (path.includes("/search/") || path.endsWith("/search")) return "search";
  return "location";
}

// A real Google Maps coordinate pair, range-checked AND excluding (0,0)
// ("Null Island" — never a legitimately-linked institution location, and a
// common zero-value/parsing-failure sentinel). The one deliberate addition
// on top of the existing hasValidCoords() range check — reused, not
// replaced, so this stays the only coordinate validator in play.
function validCoordPair(lat, lng) {
  return hasValidCoords(lat, lng) && !(lat === 0 && lng === 0);
}

function coordsFromString(str, source) {
  const m = /^(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)$/.exec(String(str || "").trim());
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  return validCoordPair(lat, lng) ? { latitude: lat, longitude: lng, coordSource: source } : null;
}

function isCoordPairString(str) {
  return /^-?\d+(?:\.\d+)?,\s*-?\d+(?:\.\d+)?$/.test(String(str || "").trim());
}

// Google Maps' own "precise pin" marker, embedded in the URL as
// `!3d<lat>!4d<lng>` — the actual place coordinate, and MORE precise than
// the `@lat,lng,zoom` viewport center (which is just wherever the map was
// centered/panned when the link was generated, and can legitimately be a
// meaningful distance from the pin — e.g. Campus Velbert/Heiligenhaus's `@`
// longitude is ~6.897 while its real pin is ~6.968, several km apart).
// Always preferred over `@lat,lng` when both are present — see the
// coordinate-priority note in this file's header.
function extractPrecisePin(href) {
  const m = /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/.exec(href);
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  return validCoordPair(lat, lng) ? { latitude: lat, longitude: lng, coordSource: "precise" } : null;
}

function extractViewportCenter(href) {
  const m = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(href);
  if (!m) return null;
  return coordsFromString(`${m[1]},${m[2]}`, "viewport");
}

function extractQueryCoords(url) {
  const q = url.searchParams.get("q") || url.searchParams.get("ll");
  return q ? coordsFromString(q, "query") : null;
}

// Google's stable "topic"/Knowledge-Graph identifier, embedded as
// `!16z<base64>` — decodes to a `/m/<id>` or `/g/<id>` string. Some
// real-world links use the base64url alphabet (`-`/`_`) instead of standard
// base64 (`+`/`/`) for this segment, so both are normalized before
// decoding. Returns null (never throws) if the segment is absent or doesn't
// decode to the expected shape — this is opportunistic metadata, never a
// required signal (see this file's header).
const PLACE_TOPIC_RE = /!16z([A-Za-z0-9+/_-]+={0,2})/;
function extractPlaceId(href) {
  const m = PLACE_TOPIC_RE.exec(href);
  if (!m) return null;
  try {
    const normalized = m[1].replace(/-/g, "+").replace(/_/g, "/");
    const decoded = atob(normalized);
    return /^\/[gm]\/[A-Za-z0-9_-]+$/.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

// Strips ASCII control characters only (0x00-0x1F, 0x7F) — every legitimate
// institution-name character (apostrophes, ampersands, slashes, parentheses,
// commas, spaces, diacritics) survives untouched.
const CONTROL_CHARS_RE = new RegExp("[" + String.fromCharCode(0) + "-" + String.fromCharCode(31) + String.fromCharCode(127) + "]", "g");
function sanitizeName(raw) {
  const cleaned = String(raw).replace(CONTROL_CHARS_RE, "").trim();
  return cleaned.slice(0, 200) || null;
}

// For a RAW, still percent/plus-encoded PATH SEGMENT (e.g. a `/place/<this>/`
// segment, or a legacy path-style /dir/<this>/<this>/ segment) — decodes `+`
// to a space and percent-escapes, then sanitizes. NOT for a value already
// read via URLSearchParams.get(), which the WHATWG URL spec already fully
// decodes (including `+` as space) — re-running decodeURIComponent on an
// already-decoded value could corrupt a name containing a literal `%`
// character. Use sanitizeName() directly for those instead (see the
// "search"/"directions" query-param branches below).
function decodeNamePart(segment) {
  try {
    return sanitizeName(decodeURIComponent(segment.replace(/\+/g, " ")));
  } catch {
    return null; // malformed % escape — never throw, just treat as "no name"
  }
}

// /place/<name>/... extraction, plus the legacy maps.google.com/maps?q=<name>
// form — unchanged from before this milestone.
function extractPlaceName(url) {
  const placeMatch = /\/place\/([^/@]+)/.exec(url.pathname);
  if (placeMatch) return decodeNamePart(placeMatch[1]);

  // Legacy `maps.google.com/maps?q=<place name>` form — only when `q` isn't
  // itself a coordinate pair (extractQueryCoords already claims that case).
  const q = url.searchParams.get("q");
  if (q && !isCoordPairString(q)) return sanitizeName(q); // already decoded by URLSearchParams

  return null;
}

// /maps/search/?api=1&query=<name-or-lat,lng> — the documented Google Maps
// Search URL API format. Some real-world links omit `api=1` or use a bare
// `q` instead of `query`; both are tolerated.
function extractSearchQueryValue(url) {
  const raw = url.searchParams.get("query") ?? url.searchParams.get("q");
  return raw ? raw.trim() : null;
}

// /maps/dir/?api=1&destination=<name-or-lat,lng> — the documented Google
// Maps Directions URL API format. Deliberately reads ONLY `destination`,
// never `origin`/`waypoints` — see this file's header for why.
function extractDestinationValue(url) {
  const raw = url.searchParams.get("destination");
  return raw ? raw.trim() : null;
}

// Legacy path-style directions URL: /maps/dir/<origin>/<destination>/@<lat>,<lng>,<zoom>
// (no `api=1`/`destination=` query param at all — an older but still
// commonly-shared share-link shape). Walks the path segments from the end,
// skipping the viewport (`@...`) and `data=...` segments, and returns the
// last remaining plain name segment — that is always the DESTINATION in
// Google's own path ordering (origin, then destination, then viewport).
function extractLegacyDirectionsName(url) {
  const segments = url.pathname.split("/").filter(Boolean);
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i];
    if (!seg || seg.startsWith("@") || seg.startsWith("data=") || seg === "dir" || seg === "maps") continue;
    return decodeNamePart(seg);
  }
  return null;
}

// Returns:
//   { isGoogleMapsUrl: false }
//     — not a recognized Google Maps host, or malformed/oversized input.
//   { isGoogleMapsUrl: true, isShortLink: true, name: null, latitude: null, longitude: null, coordSource: null, urlType: null, placeId: null, confidence: "low" }
//     — goo.gl/maps or maps.app.goo.gl: no coordinates are present in the
//       URL text itself; this module never follows redirects to resolve one.
//   { isGoogleMapsUrl: true, isShortLink: false, name: string|null, latitude: number|null, longitude: number|null, coordSource: "precise"|"viewport"|"query"|null, urlType: "place"|"search"|"directions"|"location", placeId: string|null, confidence: "high"|"medium"|"low" }
//     — a full Google Maps URL. latitude/longitude are already
//       range-validated (and non-null-island) when non-null; name is already
//       decoded and control-character-stripped when non-null. Both may
//       legitimately be null (e.g. a bare `/maps` URL, or a directions URL
//       with neither a destination param nor a name path segment) — the
//       caller decides. urlType/placeId/confidence are purely additive,
//       informational fields — nothing in this codebase's resolution logic
//       requires them; every existing caller that only reads
//       name/latitude/longitude/coordSource is unaffected.
export function parseGoogleMapsUrl(input) {
  const raw = typeof input === "string" ? input.trim() : "";
  if (!raw || raw.length > MAX_URL_LENGTH) return { isGoogleMapsUrl: false };

  let url;
  try {
    url = new URL(raw);
  } catch {
    return { isGoogleMapsUrl: false };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { isGoogleMapsUrl: false };

  const kind = classifyHost(url);
  if (!kind) return { isGoogleMapsUrl: false };

  if (kind === "short") {
    return { isGoogleMapsUrl: true, isShortLink: true, name: null, latitude: null, longitude: null, coordSource: null, urlType: null, placeId: null, confidence: "low" };
  }

  const urlType = classifyUrlType(url);
  const precisePin = extractPrecisePin(url.href); // strongest signal, checked first regardless of urlType

  let coords = precisePin;
  let name = null;

  if (urlType === "search") {
    const rawQuery = extractSearchQueryValue(url);
    if (rawQuery && isCoordPairString(rawQuery)) {
      if (!coords) coords = coordsFromString(rawQuery, "query");
    } else if (rawQuery) {
      name = sanitizeName(rawQuery); // already decoded by URLSearchParams
    }
    if (!coords) coords = extractViewportCenter(url.href);
  } else if (urlType === "directions") {
    const rawDestination = extractDestinationValue(url);
    if (rawDestination && isCoordPairString(rawDestination)) {
      if (!coords) coords = coordsFromString(rawDestination, "query");
    } else if (rawDestination) {
      name = sanitizeName(rawDestination);
    } else {
      name = extractLegacyDirectionsName(url);
    }
    // Deliberately NEVER falls back to the bare `@lat,lng` viewport here —
    // see this file's header ("Why 'directions' never falls back...").
  } else if (urlType === "place") {
    if (!coords) coords = extractViewportCenter(url.href) || extractQueryCoords(url);
    name = extractPlaceName(url);
  } else {
    // "location" catch-all — bare /maps/@lat,lng,zoom, legacy
    // maps.google.com/maps?q=..., or any other recognized /maps path.
    if (!coords) coords = extractViewportCenter(url.href) || extractQueryCoords(url);
    name = extractPlaceName(url);
  }

  const placeId = extractPlaceId(url.href);
  const confidence = coords?.coordSource === "precise" && name ? "high" : coords || name ? "medium" : "low";

  return {
    isGoogleMapsUrl: true,
    isShortLink: false,
    name,
    latitude: coords ? coords.latitude : null,
    longitude: coords ? coords.longitude : null,
    coordSource: coords ? coords.coordSource : null,
    urlType,
    placeId,
    confidence,
  };
}
