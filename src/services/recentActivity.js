// Client-side "recent searches" / "recently viewed properties" persistence.
//
// Recently-viewed properties store a small REAL summary (name/image/price/
// rating — trimmed from the property data already fetched and mapped when
// the user viewed it), not just a slug. This is reuse of real, already-paid-for
// Amber data, not fabricated data — and it means the homepage can render
// "Continue Exploring" with ZERO additional Amber requests instead of
// re-fetching each recently-viewed property by slug.

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

// Guards against a stored entry from before recently-viewed summaries existed
// (an earlier version stored only {slug, viewedAt}) — rendering one of those
// directly as a compact card would crash on missing fields (images, price,
// badges, etc). Self-healing: an old-format entry is simply dropped here and
// naturally replaced with a full one next time that property is viewed.
function isCompleteSummary(p) {
  return !!(p && p.slug && p.name && Array.isArray(p.images) && p.price);
}

export function getRecentProperties() {
  return readList(PROPERTIES_KEY).filter(isCompleteSummary);
}

// `summary` is a small real subset of an already-fetched, already-mapped
// property (see buildRecentPropertySummary in PropertyDetailPage.js) — just
// enough to render a compact card without ever contacting Amber again.
export function addRecentProperty(summary) {
  if (!summary || !summary.slug) return;
  const existing = readList(PROPERTIES_KEY).filter((p) => p.slug !== summary.slug);
  writeList(PROPERTIES_KEY, [{ ...summary, viewedAt: Date.now() }, ...existing].slice(0, MAX_PROPERTIES));
}