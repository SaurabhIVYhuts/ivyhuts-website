// Milestone 4 — fire-and-forget POST to /api/events for the two whitelisted
// behavioral events (PROPERTY_VIEWED, CITY_SEARCHED). Same non-blocking
// pattern as src/lib/enquiryApi.js: never awaited by callers, never throws,
// and never affects the page it's called from — a tracking failure must
// not break browsing.
export function trackEvent(event, properties) {
  try {
    fetch("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event, properties }),
    }).catch((err) => console.error(`[Events] ${event} request failed:`, err.message));
  } catch (_) {}
}
