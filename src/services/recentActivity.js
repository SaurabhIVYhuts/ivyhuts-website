// Client-side "recent searches" / "recently viewed properties" persistence.
// Stores only lightweight identifiers — property data is always re-fetched
// fresh from Amber when displayed, never cached stale in localStorage.

const SEARCHES_KEY = "ivyhuts_recent_searches";
const PROPERTIES_KEY = "ivyhuts_recent_properties";
const MAX_SEARCHES = 5;
const MAX_PROPERTIES = 6;

function readList(key) {
  try {
    const raw = window.localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeList(key, list) {
  try {
    window.localStorage.setItem(key, JSON.stringify(list));
  } catch {
    // localStorage unavailable (private browsing, quota) — fail silently.
  }
}

export function getRecentSearches() {
  return readList(SEARCHES_KEY);
}

export function addRecentSearch(city) {
  const clean = (city || "").trim();
  if (!clean) return;
  const existing = readList(SEARCHES_KEY).filter((c) => c.toLowerCase() !== clean.toLowerCase());
  writeList(SEARCHES_KEY, [clean, ...existing].slice(0, MAX_SEARCHES));
}

export function getRecentProperties() {
  return readList(PROPERTIES_KEY);
}

export function addRecentProperty(slug) {
  if (!slug) return;
  const existing = readList(PROPERTIES_KEY).filter((p) => p.slug !== slug);
  writeList(PROPERTIES_KEY, [{ slug, viewedAt: Date.now() }, ...existing].slice(0, MAX_PROPERTIES));
}