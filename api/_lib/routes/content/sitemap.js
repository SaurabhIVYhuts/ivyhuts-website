// GET /sitemap.xml  (vercel.json rewrites it onto /api/content/sitemap)
//
// This site is a client-rendered CRA SPA, so there is no build step that can
// emit a per-property sitemap. The hand-maintained public/sitemap.xml that
// this route replaces listed 10 static routes + 9 city pages and ZERO
// property pages — so /property/<slug>, the highest-volume long-tail SEO
// surface (brand + city queries, "student accommodation near <university>"),
// was completely undiscoverable except by internal-link crawl.
//
// This route emits, on every request:
//   • the fixed marketing / legal routes (same set as the old static file)
//   • /properties?city=<City> for every destination that currently has
//     indexed inventory — case-matched to what PropertyListingPage's <Seo>
//     emits as its canonical (/properties?city=${encodeURIComponent(city)}),
//     so a sitemap URL and its page's canonical never disagree
//   • /property/<slug> for every available, slugged AccommodationResidence
//
// It reads only the local AccommodationResidence mirror (never Amber), is
// cached hard at the edge, and degrades to the static-only list if MongoDB
// is unreachable — a sitemap must never 5xx.
"use strict";

const { connectToDatabase, MongoNotConfiguredError } = require("../../mongodb");
const { normalizeCityName } = require("../../amberGateway");
const AccommodationResidence = require("../../models/AccommodationResidence");
const DESTINATIONS = require("../../destinations.json");

const ORIGIN = "https://www.ivyhuts.com";

// Fixed routes that always belong in the index, with their crawl hints.
// Mirrors the old public/sitemap.xml exactly (utility/no-index routes such
// as /login, /wishlist, /thank-you are intentionally absent).
const STATIC_ROUTES = [
    { path: "/", changefreq: "weekly", priority: "1.0" },
    { path: "/find-rooms", changefreq: "weekly", priority: "0.9" },
    { path: "/university-housing", changefreq: "weekly", priority: "0.9" },
    { path: "/student-planner", changefreq: "monthly", priority: "0.7" },
    { path: "/life-abroad", changefreq: "monthly", priority: "0.7" },
    { path: "/list-your-stay", changefreq: "monthly", priority: "0.8" },
    { path: "/partner", changefreq: "monthly", priority: "0.7" },
    { path: "/contact", changefreq: "monthly", priority: "0.6" },
    { path: "/terms", changefreq: "yearly", priority: "0.3" },
    { path: "/privacy", changefreq: "yearly", priority: "0.3" },
];

// Used only when MongoDB is unreachable — the 9 cities the hand-maintained
// sitemap already trusted, so a DB outage never shrinks the sitemap below
// its previous state.
const FALLBACK_CITIES = ["London", "Manchester", "Liverpool", "Birmingham", "Munich", "Berlin", "Paris", "Dublin", "Dubai"];

function xmlEscape(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

function urlEntry(loc, { changefreq, priority, lastmod } = {}) {
    const parts = [`<loc>${xmlEscape(loc)}</loc>`];
    if (lastmod) parts.push(`<lastmod>${xmlEscape(lastmod)}</lastmod>`);
    if (changefreq) parts.push(`<changefreq>${changefreq}</changefreq>`);
    if (priority) parts.push(`<priority>${priority}</priority>`);
    return `  <url>${parts.join("")}</url>`;
}

function cityLoc(displayName) {
    // Must match PropertyListingPage's <Seo canonical> exactly:
    // `/properties?city=${encodeURIComponent(city)}`.
    return `${ORIGIN}/properties?city=${encodeURIComponent(displayName)}`;
}

function propertyLoc(slug) {
    // Must match PropertyDetailPage's route: /property/:slug, linked as
    // `/property/${encodeURIComponent(slug)}`.
    return `${ORIGIN}/property/${encodeURIComponent(slug)}`;
}

// Cities that actually have indexed inventory right now, returned as the
// site's own display-case names (from destinations.json) so the emitted URL
// matches the page's canonical. Falls back to the known-good 9 on any DB
// problem.
async function resolveInventory() {
    try {
        await connectToDatabase();
    } catch (err) {
        if (err instanceof MongoNotConfiguredError) {
            return { cities: FALLBACK_CITIES, properties: [], degraded: true };
        }
        throw err;
    }

    // One lean pass over the mirror. `available` defaults true; a null/empty
    // slug can't be linked to, so it can't be in the sitemap.
    const rows = await AccommodationResidence.find(
        { available: true, slug: { $type: "string", $ne: "" } },
        { slug: 1, city: 1, updatedAt: 1, _id: 0 }
    ).lean();

    const citiesWithInventory = new Set(rows.map((r) => r.city).filter(Boolean));
    const cities = DESTINATIONS
        .map((d) => d.name)
        .filter((name) => citiesWithInventory.has(normalizeCityName(name)));

    const seen = new Set();
    const properties = [];
    for (const r of rows) {
        if (seen.has(r.slug)) continue;
        seen.add(r.slug);
        properties.push({
            slug: r.slug,
            lastmod: r.updatedAt instanceof Date ? r.updatedAt.toISOString().slice(0, 10) : null,
        });
    }

    return {
        cities: cities.length ? cities : FALLBACK_CITIES,
        properties,
        degraded: false,
    };
}

module.exports = async (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
        res.status(405).json({ error: "Method not allowed" });
        return;
    }

    let inventory;
    try {
        inventory = await resolveInventory();
    } catch (err) {
        // A sitemap must never 5xx — Search Console penalises a fetch error
        // far more than a temporarily short sitemap. Serve the static skeleton.
        console.log(`[SITEMAP] inventory read failed, serving static-only: ${err.message}`);
        inventory = { cities: FALLBACK_CITIES, properties: [], degraded: true };
    }

    const lines = [];
    lines.push('<?xml version="1.0" encoding="UTF-8"?>');
    lines.push('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');

    for (const route of STATIC_ROUTES) {
        lines.push(urlEntry(`${ORIGIN}${route.path}`, { changefreq: route.changefreq, priority: route.priority }));
    }
    for (const city of inventory.cities) {
        lines.push(urlEntry(cityLoc(city), { changefreq: "weekly", priority: "0.8" }));
    }
    for (const property of inventory.properties) {
        lines.push(urlEntry(propertyLoc(property.slug), { changefreq: "weekly", priority: "0.6", lastmod: property.lastmod }));
    }

    lines.push("</urlset>");

    const body = lines.join("\n") + "\n";
    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    // 1h fresh at the edge, then serve-stale-while-revalidating for a day —
    // the inventory mirror changes slowly and a crawler never needs the
    // absolute latest minute.
    res.setHeader("Cache-Control", "public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400");
    res.setHeader("X-Sitemap-Degraded", inventory.degraded ? "1" : "0");
    console.log(`[SITEMAP] static=${STATIC_ROUTES.length} cities=${inventory.cities.length} properties=${inventory.properties.length} degraded=${inventory.degraded}`);
    res.status(200).send(body);
};
