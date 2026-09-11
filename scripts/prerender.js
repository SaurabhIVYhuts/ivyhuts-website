#!/usr/bin/env node
// Static-HTML prerenderer for the routes listed below — a small,
// dependency-light replacement for `react-snap`. react-snap's crawler calls
// Puppeteer's private, undocumented `page._client` API, which has changed
// shape across Puppeteer major versions and no longer matches ANY currently
// installable Puppeteer release (confirmed by direct testing: fails
// identically on puppeteer 18.2.1 and 22.15.0 with "page._client.send is not
// a function") — react-snap itself hasn't had a real release since 2020.
// This script does the same job (render each route in a real browser, save
// the resulting HTML next to the CRA build output) using ONLY Puppeteer's
// stable, public API (page.goto / page.content), so it isn't hostage to
// Puppeteer's internals and won't silently break on the next `npm install`.
//
// Why every route needs this at all: this is a client-rendered React app,
// so without a prerendered file, every route (including the ones listed
// below) serves an empty <div id="root"></div> to anything that doesn't
// execute JavaScript — confirmed live via `curl` against production. Google
// eventually renders the JS in a slower second-pass queue, but Bing and
// every non-JS tool/bot see nothing at all.
//
// Scope note: a route whose content depends on a live backend API call
// (e.g. /find-rooms' property listings) still gets its real page chrome,
// copy, and <h1> captured here — it just won't have that dynamic data
// baked in, since this runs against a local static file server with no
// backend behind it. That's the same limitation react-snap always had for
// these routes, not a regression introduced by this script.
"use strict";

const path = require("path");
const fs = require("fs");
const http = require("http");
const puppeteer = require("puppeteer");

const BUILD_DIR = path.join(__dirname, "..", "build");
const PORT = 45678;

// Keep this in sync with any route worth prerendering — same list
// package.json's old `reactSnap.include` carried.
const ROUTES = [
    "/",
    "/find-rooms",
    "/university-housing",
    "/student-planner",
    "/life-abroad",
    "/list-your-stay",
    "/partner",
    "/contact",
    "/terms",
    "/privacy",
];

const MIME_TYPES = {
    ".html": "text/html", ".js": "application/javascript", ".css": "text/css",
    ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon",
    ".woff": "font/woff", ".woff2": "font/woff2", ".txt": "text/plain",
    ".xml": "application/xml", ".webmanifest": "application/manifest+json",
};

function serveFile(filePath, res) {
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
    fs.createReadStream(filePath).pipe(res);
}

// Minimal static file server with SPA fallback (any request that doesn't
// match a real file in build/ gets index.html) — every route needs the SPA
// shell to boot React Router client-side before this script can capture
// what it renders, same reason react-snap's own "source": "build" mode
// always needed a local static server too.
function startServer() {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            const urlPath = decodeURIComponent(req.url.split("?")[0]);
            const requested = path.join(BUILD_DIR, urlPath);
            if (!requested.startsWith(BUILD_DIR)) { res.writeHead(403); res.end(); return; }
            fs.stat(requested, (err, stats) => {
                if (!err && stats.isFile()) return serveFile(requested, res);
                if (!err && stats.isDirectory() && fs.existsSync(path.join(requested, "index.html"))) {
                    return serveFile(path.join(requested, "index.html"), res);
                }
                serveFile(path.join(BUILD_DIR, "index.html"), res);
            });
        });
        server.listen(PORT, () => resolve(server));
    });
}

async function prerenderRoute(browser, route) {
    const page = await browser.newPage();
    try {
        await page.goto(`http://localhost:${PORT}${route}`, { waitUntil: "networkidle0", timeout: 30000 });
        // networkidle0 only guarantees the network went quiet — give React a
        // brief extra moment to finish painting after that.
        await page
            .waitForFunction(() => document.getElementById("root") && document.getElementById("root").childNodes.length > 0, { timeout: 5000 })
            .catch(() => {});
        const html = `<!doctype html>${await page.content()}`;

        const outPath = route === "/" ? path.join(BUILD_DIR, "index.html") : path.join(BUILD_DIR, route.slice(1), "index.html");
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, html);

        const rootMatch = html.match(/<div id="root">([\s\S]*?)<\/div>\s*(?:<script|<\/body)/);
        const visibleChars = rootMatch ? rootMatch[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().length : 0;
        console.log(`[prerender] ${route.padEnd(20)} -> ${path.relative(BUILD_DIR, outPath)} (${visibleChars} chars visible)`);
        if (visibleChars === 0) console.warn(`[prerender] WARNING: ${route} rendered with no visible text — check for a client-side error`);
    } finally {
        await page.close();
    }
}

async function main() {
    if (!fs.existsSync(BUILD_DIR)) {
        console.error("[prerender] build/ not found — run the CRA build first");
        process.exit(1);
    }
    const server = await startServer();
    const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
    try {
        for (const route of ROUTES) {
            await prerenderRoute(browser, route);
        }
    } finally {
        await browser.close();
        server.close();
    }
    console.log(`[prerender] done: ${ROUTES.length} routes`);
}

main().catch((err) => {
    console.error("[prerender] FATAL", err);
    process.exit(1);
});
