#!/usr/bin/env node
// Runs the EXACT SAME api/*.js handlers used in production (Amber gateway,
// enquiry mailer, auth), as a plain Node HTTP server on its own port. This
// is not a reimplementation or a weaker fallback — it's the real handlers,
// just adapted from Vercel's (req, res) interface to plain Node http so
// local development doesn't require a Vercel account.
//
// CRA's dev server proxies /api requests here automatically — see
// src/setupProxy.js. Started together with `react-scripts start` by
// `npm start` (see scripts/start-local.js).
const path = require("path");
// Plain `node` (unlike `vercel dev`) never loads .env files on its own, so
// without this, any local .env/.env.local values (ENQUIRY_NOTIFY_EMAILS,
// UPSTASH_*, AMBER_MAX_REQUESTS_PER_MINUTE, ...) would silently never reach
// process.env under `npm start` — this MUST run before requiring the API
// handlers below, since some of them read env vars at require-time.
require("dotenv").config({ path: path.join(__dirname, "..", ".env.local") });
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const http = require("http");
const { URL } = require("url");
const amberHandler = require("../api/amber.js");
const universitiesResolveHandler = require("../api/universities/resolve.js");
const searchHandler = require("../api/search.js");
const searchDataHandler = require("../api/search-data.js");
const enquireHandler = require("../api/enquire.js");
const studentPlannerHandler = require("../api/student-planner.js");
const studentPlannerPptHandler = require("../api/student-planner-ppt.js");
const cityListingsHandler = require("../api/city-listings.js");
const authRoutes = {
    "/api/auth/signup": require("../api/auth/signup.js"),
    "/api/auth/login": require("../api/auth/login.js"),
    "/api/auth/logout": require("../api/auth/logout.js"),
    "/api/auth/me": require("../api/auth/me.js"),
};

// Milestone 2 business API — mirrors Vercel's filesystem-based dynamic
// routing (api/leads/[id].js -> /api/leads/:id) since this plain Node
// server has no framework to do that automatically. Order matters: more
// specific/static patterns (e.g. /api/customers/me) must be listed before
// the more general dynamic one (/api/customers/:id) they'd otherwise be
// shadowed by — same precedence rule Vercel itself applies.
const businessRoutes = [
    { pattern: "/api/customers", handler: require("../api/customers/index.js") },
    { pattern: "/api/customers/me", handler: require("../api/customers/me.js") },
    { pattern: "/api/customers/:id/lifecycle", handler: require("../api/customers/[id]/lifecycle.js") },
    { pattern: "/api/customers/:id", handler: require("../api/customers/[id].js") },
    { pattern: "/api/leads", handler: require("../api/leads/index.js") },
    { pattern: "/api/leads/:id/assignment", handler: require("../api/leads/[id]/assignment.js") },
    { pattern: "/api/leads/:id", handler: require("../api/leads/[id].js") },
    { pattern: "/api/enquiries", handler: require("../api/enquiries/index.js") },
    { pattern: "/api/enquiries/:id", handler: require("../api/enquiries/[id].js") },
    { pattern: "/api/wishlist", handler: require("../api/wishlist/index.js") },
    { pattern: "/api/wishlist/:propertyId", handler: require("../api/wishlist/[propertyId].js") },
    { pattern: "/api/events", handler: require("../api/events/index.js") },
    { pattern: "/api/insights/overview", handler: require("../api/insights/overview.js") },
    { pattern: "/api/insights/market", handler: require("../api/insights/market.js") },
].map((route) => ({
    ...route,
    paramNames: (route.pattern.match(/:([^/]+)/g) || []).map((p) => p.slice(1)),
    regex: new RegExp("^" + route.pattern.replace(/:[^/]+/g, "([^/]+)") + "$"),
}));

function matchBusinessRoute(pathname) {
    for (const route of businessRoutes) {
        const match = route.regex.exec(pathname);
        if (match) {
            const params = {};
            route.paramNames.forEach((name, i) => { params[name] = decodeURIComponent(match[i + 1]); });
            return { handler: route.handler, params };
        }
    }
    return null;
}

const PORT = process.env.LOCAL_API_PORT || 3001;

function adaptResponse(res) {
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (body) => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(body));
    };
    return res;
}

function readJsonBody(req) {
    return new Promise((resolve) => {
        let raw = "";
        req.on("data", (chunk) => { raw += chunk; });
        req.on("end", () => {
            try { resolve(JSON.parse(raw || "{}")); } catch { resolve({}); }
        });
    });
}

const server = http.createServer(async (req, res) => {
    try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        req.query = Object.fromEntries(url.searchParams.entries());
        adaptResponse(res);
        if (url.pathname === "/api/enquire") {
            req.body = await readJsonBody(req);
            await enquireHandler(req, res);
            return;
        }
        // Student Planner (Milestone 2+) and its PPT export (Milestone 9) —
        // previously missing from this router entirely, so both silently
        // fell through to amberHandler below (a GET-only handler, hence the
        // 405 on POST /api/student-planner-ppt). These are real handlers,
        // same as every other route here — student-planner.js talks to
        // Amber via ./_lib/accommodationIndex.js -> ./_lib/amberGateway.js
        // like normal; student-planner-ppt.js never touches Amber at all
        // (see its own header comment).
        if (url.pathname === "/api/student-planner") {
            await studentPlannerHandler(req, res);
            return;
        }
        if (url.pathname === "/api/student-planner-ppt") {
            req.body = await readJsonBody(req);
            await studentPlannerPptHandler(req, res);
            return;
        }
        // Mongo-first city browse/search (see api/city-listings.js) — was
        // missing from this router entirely, so it silently fell through to
        // amberHandler below, which rejects anything without a `type` param
        // (400, no `message` field) — surfaced on the listings page as a
        // generic "Failed to fetch city listings" with 0 properties shown,
        // same "must be explicitly routed or it silently falls through"
        // lesson as /api/search and /api/search-data below.
        if (url.pathname === "/api/city-listings") {
            await cityListingsHandler(req, res);
            return;
        }
        if (url.pathname === "/api/universities/resolve") {
            if (req.method === "POST") req.body = await readJsonBody(req);
            await universitiesResolveHandler(req, res);
            return;
        }
        // Global search (GlobalSearchBar's autocomplete) — was missing from
        // this router entirely, so it silently fell through to amberHandler
        // below (which naturally rejects anything without a `type` param),
        // making search look completely broken under `npm start` even
        // though the real handler (api/search.js) was correct all along.
        if (url.pathname === "/api/search") {
            await searchHandler(req, res);
            return;
        }
        // The complete countries/cities/universities dataset GlobalSearchBar
        // loads once (see src/lib/entitySearch.js) — same "must be
        // explicitly routed or it silently falls through to amberHandler"
        // lesson as /api/search above.
        if (url.pathname === "/api/search-data") {
            await searchDataHandler(req, res);
            return;
        }
        if (Object.prototype.hasOwnProperty.call(authRoutes, url.pathname)) {
            if (req.method === "POST") req.body = await readJsonBody(req);
            await authRoutes[url.pathname](req, res);
            return;
        }
        const businessMatch = matchBusinessRoute(url.pathname);
        if (businessMatch) {
            Object.assign(req.query, businessMatch.params);
            if (["POST", "PATCH", "PUT", "DELETE"].includes(req.method)) req.body = await readJsonBody(req);
            await businessMatch.handler(req, res);
            return;
        }
        await amberHandler(req, res);
    } catch (err) {
        console.error("[local-api-server] handler error:", err);
        if (!res.headersSent) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: false, error: "internal_error" }));
        }
    }
});

server.listen(PORT, () => {
    console.log(`[local-api-server] Amber gateway listening on http://localhost:${PORT} (reachable at /api/amber via the CRA dev proxy)`);
});