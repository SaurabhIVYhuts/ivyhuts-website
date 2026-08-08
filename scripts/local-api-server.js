#!/usr/bin/env node
// Runs the EXACT SAME api/amber.js handler used in production, as a plain
// Node HTTP server on its own port. This is not a reimplementation or a
// weaker fallback — it's the real gateway (cache, rolling rate budget,
// cooldown, stampede lock), just adapted from Vercel's (req, res) interface
// to plain Node http so local development doesn't require a Vercel account.
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
const enquireHandler = require("../api/enquire.js");

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