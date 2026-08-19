import { useCallback, useMemo } from "react";

// Every filter PropertyListingPage supports, and the (short, URL-friendly)
// query param each one lives under. This is the single source of truth for
// filter state — no more local `useState(EMPTY_FILTERS)` — so refresh,
// share, and browser back/forward all just work, and desktop/mobile bind to
// the exact same state instead of drifting apart (that drift is what broke
// mobile filters in the first place).
//
// `near` is the free-text "which nearby place" filter (was previously keyed
// `university` in local state) — renamed to avoid colliding with the
// higher-level `?university=` entity-selector param, which decides which
// city's inventory gets loaded in the first place; `near` only narrows
// within whatever's already loaded.
const FILTER_KEYS = {
  query: { param: "q", type: "string" },
  minPrice: { param: "minPrice", type: "string" },
  maxPrice: { param: "maxPrice", type: "string" },
  roomType: { param: "roomType", type: "string" },
  billsOnly: { param: "billsOnly", type: "bool" },
  // "" (no filter) | "allowed" | "not_allowed" — mutually exclusive, so one
  // string param rather than two independent booleans (see petPolicy.js).
  petPolicy: { param: "pet", type: "string" },
  near: { param: "near", type: "string" },
  amenities: { param: "amenities", type: "list" },
  moveInMonth: { param: "moveInMonth", type: "string" },
  stayDuration: { param: "stayDuration", type: "string" },
  sortBy: { param: "sortBy", type: "string", default: "recommended" },
};

export const EMPTY_FILTERS = {
  query: "", minPrice: "", maxPrice: "", roomType: "", billsOnly: false, petPolicy: "",
  near: "", amenities: [], moveInMonth: "", stayDuration: "", sortBy: "recommended",
};

function parseFilters(searchParams) {
  const out = { ...EMPTY_FILTERS };
  for (const [key, cfg] of Object.entries(FILTER_KEYS)) {
    const raw = searchParams.get(cfg.param);
    if (raw == null || raw === "") continue;
    if (cfg.type === "bool") out[key] = raw === "1" || raw === "true";
    else if (cfg.type === "list") out[key] = raw.split(",").map((s) => s.trim()).filter(Boolean);
    else out[key] = raw;
  }
  return out;
}

function isEmptyValue(key, cfg, value) {
  if (cfg.type === "bool") return value !== true;
  if (cfg.type === "list") return !Array.isArray(value) || value.length === 0;
  if (key === "sortBy") return !value || value === "recommended";
  return value == null || value === "";
}

// `searchParams`/`setSearchParams` are exactly react-router's own
// useSearchParams() pair — this hook doesn't own the URL, it just knows how
// to read/write its filter slice of it, leaving every other param (city,
// country, university, property, view) untouched since it always starts
// from a copy of the current params and only ever touches FILTER_KEYS.
export default function useFilterState(searchParams, setSearchParams) {
  const filters = useMemo(() => parseFilters(searchParams), [searchParams]);

  const setFilters = useCallback((updater) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      const current = parseFilters(prev);
      const updated = typeof updater === "function" ? updater(current) : updater;
      for (const [key, cfg] of Object.entries(FILTER_KEYS)) {
        const value = updated[key];
        if (isEmptyValue(key, cfg, value)) next.delete(cfg.param);
        else if (cfg.type === "list") next.set(cfg.param, value.join(","));
        else if (cfg.type === "bool") next.set(cfg.param, "1");
        else next.set(cfg.param, String(value));
      }
      return next;
    }, { replace: true });
    // A filter tweak (typing a price, ticking an amenity) replaces the
    // current history entry rather than pushing a new one — otherwise every
    // keystroke would need its own "back" step, which is worse UX than the
    // shareable-URL benefit this hook exists to provide.
  }, [setSearchParams]);

  const setFilter = useCallback((key) => (value) => setFilters((prev) => ({ ...prev, [key]: value })), [setFilters]);

  const toggleAmenity = useCallback((amenity) => {
    setFilters((prev) => ({
      ...prev,
      amenities: prev.amenities.includes(amenity)
        ? prev.amenities.filter((a) => a !== amenity)
        : [...prev.amenities, amenity],
    }));
  }, [setFilters]);

  const clearFilters = useCallback(() => setFilters(EMPTY_FILTERS), [setFilters]);

  return { filters, setFilters, setFilter, toggleAmenity, clearFilters };
}
