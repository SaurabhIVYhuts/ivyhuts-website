// Thin fetch client for the /insight dashboard's two protected endpoints.
// Mirrors src/services/amberApi.js's plain-fetch style — no client-side
// caching layer here (internal tool, low traffic, and every response is
// already filter-dependent), just a shared error shape the page can render.
export class InsightsApiError extends Error {
    constructor(status, code, message) {
        super(message || "Unable to load analytics");
        this.name = "InsightsApiError";
        this.status = status;
        this.code = code;
    }
}

async function getJson(path, params) {
    const query = new URLSearchParams(
        Object.entries(params || {}).filter(([, v]) => v !== undefined && v !== null && v !== "")
    );
    const url = query.toString() ? `${path}?${query.toString()}` : path;
    const res = await fetch(url);
    const body = await res.json().catch(() => null);
    if (!res.ok || (body?.success === false) || (body?.ok === false)) {
        // Two response shapes exist across this API (see api/_lib/apiResponse.js
        // vs. the older api/_lib/auth.js 401 shape) — normalize both rather
        // than assuming one.
        const code = body?.error?.code || (typeof body?.error === "string" ? body.error : undefined);
        const message = body?.error?.message || body?.message;
        throw new InsightsApiError(res.status, code, message);
    }
    return body?.data;
}

export function getInsightsOverview(filters) {
    return getJson("/api/insights/overview", filters);
}

export function getInsightsMarket(filters) {
    return getJson("/api/insights/market", filters);
}

// Primary feed for the calendar-driven dashboard — `date: undefined` (or
// today's date) returns live data; any earlier date returns the frozen
// stored snapshot for that day. See api/insights/snapshot.js.
export function getInsightsSnapshot(filters) {
    return getJson("/api/insights/snapshot", filters);
}

// Dates with a stored snapshot, for the calendar's availability dots.
export function getInsightsSnapshotDates(filters) {
    return getJson("/api/insights/snapshot-dates", filters);
}

export function getCurrentCustomer() {
    return getJson("/api/customers/me");
}
