// GET /api/search-data — the complete countries/cities/universities dataset
// GlobalSearchBar fetches ONCE (not per keystroke) and searches entirely
// in-memory thereafter (see src/lib/entitySearch.js). Deliberately thin:
// the actual dataset is pre-computed by the existing full-catalog crawl as
// part of its own 5-minute cron cycle (api/_lib/insightsMarket.js's
// saveSearchData, called from advanceCrawl) — this endpoint only ever reads
// that already-computed result, so a request here never touches Amber, never
// queries Mongo, and never processes the crawl's own large (~928KB) state
// blob. Properties are intentionally NOT part of this dataset (out of scope
// for this phase, see insightsMarket.js's header on SEARCH_DATA_KEY).
const { loadSearchData } = require("./_lib/insightsMarket");
const DESTINATIONS = require("./_lib/destinations.json");
const CAMPUS_UNIVERSITIES = require("./_lib/campusUniversities.json");
const COUNTRY_FULL_NAMES = require("./_lib/countryFullNames.json");

function slugify(str) {
    return String(str || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function countryAliases(fullName) {
    for (const [code, full] of Object.entries(COUNTRY_FULL_NAMES)) {
        if (full === fullName && code !== fullName) return [code];
    }
    return [];
}

// Bootstrap fallback for the gap between this code deploying and the
// crawl's next tick actually producing search:searchData:v1 (see
// insightsMarket.js) — curated data only, computed in-memory, zero Mongo/
// Amber/shared-store cost. Same shape as the real generated dataset so the
// frontend never needs to special-case which one it got.
function curatedOnlyFallback() {
    const countryMap = new Map();
    for (const d of DESTINATIONS) {
        if (!countryMap.has(d.country)) countryMap.set(d.country, 0);
        countryMap.set(d.country, countryMap.get(d.country) + 1);
    }
    const countries = Array.from(countryMap.entries()).map(([code, cityCount]) => {
        const fullName = COUNTRY_FULL_NAMES[code] || code;
        return { name: fullName, slug: slugify(fullName), aliases: fullName !== code ? [code] : [], cityCount };
    });
    const cities = DESTINATIONS.map((d) => {
        const fullName = COUNTRY_FULL_NAMES[d.country] || d.country;
        return { name: d.name, country: fullName, slug: slugify(d.name), aliases: [] };
    });
    const universities = CAMPUS_UNIVERSITIES.map((u) => ({
        name: u.name, city: u.city || null, country: u.country || null,
        slug: slugify(u.name), aliases: u.aliases || [], curated: true,
    }));
    return { countries, cities, universities, updatedAt: null, source: "curated-fallback" };
}

module.exports = async (req, res) => {
    if (req.method !== "GET") {
        res.status(405).json({ error: "Method not allowed" });
        return;
    }
    try {
        const data = await loadSearchData();
        // Short edge cache — this dataset only changes on the crawl's own
        // 5-minute cadence, so repeat fetches across users/tabs within that
        // window are free at the CDN layer, same convention api/amber.js
        // already uses for its own responses.
        res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
        res.status(200).json({ ok: true, data: data || curatedOnlyFallback() });
    } catch (err) {
        console.log(`[SEARCH_DATA] action=SEARCH_DATA_FAILED error=${err.message}`);
        // Never a hard failure for the frontend — curated coverage is always
        // available with zero external dependencies.
        res.status(200).json({ ok: true, data: curatedOnlyFallback() });
    }
};
