// Orchestrates a Find Rooms search across every registered provider
// adapter concurrently (Promise.allSettled semantics — one provider's
// failure/timeout never fails the whole search), builds providerCoverage
// so an agent can always tell "searched, zero matches" apart from
// "couldn't be searched", dedupes on identity only, and applies the
// deterministic straight-line distance calculation. No ranking, scoring,
// or AI — see Milestone 23.3 spec Part 10.
//
// AMBER IS NEVER CALLED HERE. This orchestration only ever invokes the
// four adapters in ./registry.js. If that ever needs to change, it needs a
// new decision, not a quiet addition here — see registry.js's own comment.
const { withTimeout } = require("../../withTimeout");
const { REGISTRY } = require("./registry");
const { distanceFromUniversityKm } = require("./distance");
const { PROVIDER_STATUSES } = require("./types");

const VALID_STATUSES = new Set(PROVIDER_STATUSES);

// Each provider gets its own timeout so one slow provider can never hold
// up the others or the overall response — matches the per-provider budget
// approach api/amber.js already uses for a different purpose (rate
// budget), applied here to latency instead.
const PROVIDER_TIMEOUT_MS = Number(process.env.PROVIDER_SEARCH_TIMEOUT_MS) || 8000;

function timeoutResult(provider) {
    return { provider, status: "ERROR", properties: [], reason: `Provider timed out after ${PROVIDER_TIMEOUT_MS}ms` };
}

// Defensive normalization of whatever an adapter handed back (or threw). A
// misbehaving adapter — wrong status literal, non-array properties, a
// thrown/rejected promise — must never leak malformed data into the
// response or silently present as a clean zero-result search; it becomes
// an explicit ERROR instead.
function sanitizeSettledResult(provider, settledResult) {
    if (settledResult.status === "rejected") {
        const reason = settledResult.reason;
        return { provider, status: "ERROR", properties: [], reason: reason && reason.message ? reason.message : "Provider adapter threw an unexpected error." };
    }
    const value = settledResult.value;
    if (!value || typeof value !== "object" || !VALID_STATUSES.has(value.status) || !Array.isArray(value.properties)) {
        return { provider, status: "ERROR", properties: [], reason: "Provider adapter returned a malformed result." };
    }
    return { provider, status: value.status, properties: value.properties, reason: value.reason };
}

function withDistance(property, universityCoordinates) {
    const propertyCoordinates = property && property.latitude != null && property.longitude != null ? { latitude: property.latitude, longitude: property.longitude } : null;
    return { ...property, distanceFromUniversityKm: distanceFromUniversityKm(universityCoordinates, propertyCoordinates) };
}

async function searchProviders(criteria) {
    const entries = Object.entries(REGISTRY);

    // Promise.allSettled, each leg individually time-boxed by withTimeout —
    // together these guarantee one provider's slowness or failure can never
    // fail or stall the overall search (Milestone 23.3 spec Part 16). Every
    // adapter is called exactly once per search (no N+1 — nothing here
    // iterates per-property back into a provider).
    const settledResults = await Promise.allSettled(
        entries.map(([provider, adapter]) => withTimeout(Promise.resolve().then(() => adapter.search(criteria)), PROVIDER_TIMEOUT_MS, timeoutResult(provider)))
    );

    const sanitized = entries.map(([provider], i) => sanitizeSettledResult(provider, settledResults[i]));

    const properties = [];
    const seenPropertyIds = new Set();
    for (const result of sanitized) {
        for (const property of result.properties) {
            // Identity-only dedup (Milestone 23.1 rule, carried over
            // unchanged) — a malformed property with no propertyId is
            // dropped rather than trusted.
            if (property && property.propertyId && !seenPropertyIds.has(property.propertyId)) {
                seenPropertyIds.add(property.propertyId);
                properties.push(withDistance(property, criteria.universityCoordinates));
            }
        }
    }

    const providerCoverage = sanitized.map(({ provider, status, properties: props, reason }) => {
        const coverage = { provider, status, count: props.length };
        if (reason) coverage.reason = reason;
        return coverage;
    });

    return { properties, providerCoverage };
}

// sanitizeSettledResult is exported purely for direct unit testing of the
// "malformed/rejected adapter result never leaks through" guarantee
// (scripts/verify-property-search.js) — not used anywhere outside this
// module and searchProviders() itself otherwise.
module.exports = { searchProviders, PROVIDER_TIMEOUT_MS, sanitizeSettledResult };
