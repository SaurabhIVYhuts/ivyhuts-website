// Pure normalization + identity functions for the accommodation provider
// layer. Ported from ivyhuts-crm's src/lib/property-intelligence/{identity,normalize}.ts
// (Milestone 23.1) to plain JS for this backend — same rules, same
// "preserve unknown rather than guess" discipline. Not yet exercised by any
// real provider call (all four adapters are NOT_CONFIGURED — see
// README.md); exists now so the orchestration layer and its tests are
// correct in shape ahead of Milestone 23.4's real integrations, per the
// Milestone 23.3 spec's Part 8/11.
"use strict";

// ── Identity ──────────────────────────────────────────────────────────
// Preferred: provider + providerPropertyId. Fallback (only when
// providerPropertyId is absent): provider + a stable normalized URL/slug.
// Neither available -> identity cannot be computed, never guessed.
function normalizeUrlForIdentity(url) {
    const trimmed = String(url || "").trim();
    if (!trimmed) return null;
    try {
        const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
        const parsed = new URL(withProtocol);
        const path = parsed.pathname.replace(/\/+$/, "");
        return `${parsed.hostname.toLowerCase()}${path.toLowerCase()}`;
    } catch {
        return null;
    }
}

function computePropertyId(provider, providerPropertyId, url) {
    const trimmedProviderId = providerPropertyId ? String(providerPropertyId).trim() : "";
    if (trimmedProviderId) {
        return { status: "ok", propertyId: `${provider}:id:${trimmedProviderId}` };
    }
    if (url && String(url).trim()) {
        const normalized = normalizeUrlForIdentity(url);
        if (normalized) return { status: "ok", propertyId: `${provider}:slug:${normalized}` };
        return { status: "invalid", reason: "url present but could not be normalized" };
    }
    return { status: "invalid", reason: "neither providerPropertyId nor url was provided" };
}

// ── Field normalization ──────────────────────────────────────────────
function toFiniteNumber(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "string") {
        const cleaned = value.replace(/[,\s]/g, "");
        if (!cleaned) return null;
        const num = Number(cleaned);
        return Number.isFinite(num) ? num : null;
    }
    return null;
}

function normalizeRent(raw) {
    let value = raw;
    if (typeof value === "string") value = value.replace(/[^0-9.,-]/g, "");
    const num = toFiniteNumber(value);
    if (num == null || num <= 0) return null;
    return num;
}

const KNOWN_CURRENCY_CODES = new Set(["GBP", "USD", "EUR", "AUD", "CAD", "INR"]);
const SYMBOL_TO_CURRENCY = { "£": "GBP", $: "USD", "€": "EUR", "₹": "INR" };

function normalizeCurrency(raw) {
    if (typeof raw !== "string") return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (SYMBOL_TO_CURRENCY[trimmed]) return SYMBOL_TO_CURRENCY[trimmed];
    const upper = trimmed.toUpperCase();
    if (KNOWN_CURRENCY_CODES.has(upper)) return upper;
    return null;
}

function normalizeRentPeriod(raw) {
    if (typeof raw !== "string") return "unknown";
    const lower = raw.trim().toLowerCase();
    if (["week", "wk", "weekly", "pw", "per week"].includes(lower)) return "week";
    if (["month", "mo", "monthly", "pcm", "per month"].includes(lower)) return "month";
    if (["night", "nightly", "per night"].includes(lower)) return "night";
    return "unknown";
}

// Precomputed cross-provider comparison field — same pattern already
// proven necessary in production by AccommodationResidence.priceWeekly
// (api/_lib/accommodationIndex.js), since providers quote in different
// billing periods. Null unless both rent and rentPeriod are confidently
// known — never estimated from a partial/unknown period.
function computeRentPerWeek(rent, rentPeriod) {
    if (rent == null) return null;
    if (rentPeriod === "week") return rent;
    if (rentPeriod === "month") return (rent * 12) / 52;
    if (rentPeriod === "night") return rent * 7;
    return null;
}

const SHARING_WORD_MAP = { single: 1, studio: 1, ensuite: 1, private: 1, twin: 2, double: 2, triple: 3, quad: 4 };

function normalizeSharing(raw) {
    if (typeof raw === "number") return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : null;
    if (typeof raw !== "string") return null;
    const lower = raw.trim().toLowerCase();
    if (!lower) return null;
    const numericMatch = lower.match(/(\d+)\s*(?:sharing|share|person|people|bed)?/);
    if (numericMatch) {
        const num = Number(numericMatch[1]);
        if (Number.isFinite(num) && num > 0) return num;
    }
    for (const [word, count] of Object.entries(SHARING_WORD_MAP)) {
        if (lower.includes(word)) return count;
    }
    return null;
}

function normalizeAvailability(raw) {
    if (typeof raw === "boolean") return raw ? "available" : "unavailable";
    if (typeof raw === "string") {
        const lower = raw.trim().toLowerCase();
        if (["available", "in_stock", "yes", "true"].includes(lower)) return "available";
        if (["unavailable", "sold_out", "no", "false", "fully_booked"].includes(lower)) return "unavailable";
    }
    return "unknown";
}

function normalizeStringArray(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.filter((item) => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
}

function normalizeString(raw) {
    if (typeof raw !== "string") return null;
    const trimmed = raw.trim();
    return trimmed.length ? trimmed : null;
}

// Normalizes one raw provider listing into a CanonicalProperty (see
// types.js). Fails only when identity cannot be computed or `name` is
// missing — every other field degrades to null/"unknown" rather than
// blocking normalization or fabricating a value.
function normalizeProviderProperty(provider, raw) {
    raw = raw || {};
    const name = normalizeString(raw.name);
    if (!name) return { status: "invalid", reason: "missing required field: name" };

    const url = normalizeString(raw.url);
    const identity = computePropertyId(provider, raw.providerPropertyId, url);
    if (identity.status === "invalid") {
        return { status: "invalid", reason: `could not determine property identity: ${identity.reason}` };
    }

    const rent = normalizeRent(raw.rent);
    const rentPeriod = normalizeRentPeriod(raw.rentPeriod);

    const property = {
        provider,
        providerPropertyId: normalizeString(raw.providerPropertyId),
        propertyId: identity.propertyId,
        name,
        url,
        slug: normalizeString(raw.slug),
        image: normalizeString(raw.image),
        images: normalizeStringArray(raw.images),
        city: normalizeString(raw.city),
        country: normalizeString(raw.country),
        latitude: toFiniteNumber(raw.latitude),
        longitude: toFiniteNumber(raw.longitude),
        rent,
        currency: normalizeCurrency(raw.currency),
        rentPeriod,
        rentPerWeek: computeRentPerWeek(rent, rentPeriod),
        roomType: normalizeString(raw.roomType),
        sharing: normalizeSharing(raw.sharing != null ? raw.sharing : raw.roomType),
        availability: normalizeAvailability(raw.availability),
        amenities: normalizeStringArray(raw.amenities),
        sourceUpdatedAt: normalizeString(raw.sourceUpdatedAt),
        distanceFromUniversityKm: null, // filled in by search.js, never here (no university context at this layer)
    };

    return { status: "ok", property };
}

module.exports = {
    normalizeUrlForIdentity,
    computePropertyId,
    normalizeRent,
    normalizeCurrency,
    normalizeRentPeriod,
    computeRentPerWeek,
    normalizeSharing,
    normalizeAvailability,
    normalizeStringArray,
    normalizeProviderProperty,
};
