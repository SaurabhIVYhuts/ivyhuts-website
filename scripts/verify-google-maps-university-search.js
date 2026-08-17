#!/usr/bin/env node
// Google Maps Link Support (University Housing search) verification. Covers:
//   - Amber isolation for the two new files (googleMapsParser.js, both twins)
//   - URL format parsing: full place URL, encoded name, spaces, maps.google.com,
//     goo.gl/maps + maps.app.goo.gl short links, invalid hostname, invalid
//     coordinates, (0,0) rejection
//   - Security: arbitrary hosts rejected, malformed URLs don't crash, javascript:
//     URLs rejected, extremely long input rejected, control characters
//     stripped safely, hostname-bypass tricks (userinfo/subdomain suffix),
//     short links never followed (no network call)
//   - resolveGoogleMapsCandidate(): resolved (name + corroborating coords),
//     ambiguous (name resolves but coords disagree -> both surfaced),
//     not_found with reason "no_institution_name" (coords with no name)
//   - Full /api/universities/resolve GET handler, via mock req/res: Google
//     Maps URL for a curated Tier 1 university resolves with zero AI calls;
//     short link / invalid host / invalid location get their own distinct
//     status; plain-text search regression (unchanged behavior + length gate)
//
// Same standalone-Node-script convention as every other scripts/verify-*.js
// in this repo (Jest is broken repo-wide for an unrelated pre-existing
// reason). Only the BACKEND (CommonJS) parser twin is exercised directly —
// the frontend twin (src/lib/googleMapsParser.js) is an ES module and can't
// be require()'d from a plain Node script, same reason
// scripts/verify-university-ai-discovery.js never requires
// src/lib/campusUniversityResolver.js directly either. A structural
// no-drift check compares the two files' literal source text instead.
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");

try {
    require("dotenv").config({ path: path.join(ROOT, ".env.local") });
} catch {
    /* dotenv not installed in some environments — env vars may already be set another way */
}

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  PASS  ${name}`);
    } catch (err) {
        failed++;
        failures.push({ name, message: err.message });
        console.log(`  FAIL  ${name}\n        ${err.message}`);
    }
}

function readSource(...segments) {
    return fs.readFileSync(path.join(ROOT, ...segments), "utf8");
}

function mockReqRes(query, method = "GET") {
    const req = { method, query };
    let statusCode = null;
    let jsonBody = null;
    const res = {
        setHeader() {},
        status(code) {
            statusCode = code;
            return this;
        },
        json(body) {
            jsonBody = body;
        },
    };
    return { req, res, getStatus: () => statusCode, getBody: () => jsonBody };
}

async function main() {
    console.log("=== IvyHuts Google Maps University Search Verification ===\n");

    // ══════════════════════ AMBER ISOLATION ══════════════════════
    const newFiles = [
        ["src", "lib", "googleMapsParser.js"],
        ["api", "_lib", "googleMapsParser.js"],
    ];
    for (const segments of newFiles) {
        const relPath = segments.join("/");
        const src = readSource(...segments);
        await test(`AMBER ISOLATION: ${relPath} never imports amberGateway.js or accommodationIndex.js`, () => {
            assert.ok(!/require\([^)]*amberGateway/.test(src));
            assert.ok(!/require\([^)]*accommodationIndex/.test(src));
            assert.ok(!/amberstudent\.com/.test(src));
        });
        await test(`SECURITY: ${relPath} never fetches the parsed URL itself (no fetch()/http request call)`, () => {
            assert.ok(!/\bfetch\s*\(/.test(src), `${relPath} must never fetch a user-supplied URL — short links are reported unresolved, never followed`);
        });
    }
    await test("AMBER ISOLATION: api/universities/resolve.js's Google Maps branch reuses resolveGoogleMapsCandidate() from the SAME service file — no second resolver, no new Amber-adjacent file", () => {
        const src = readSource("api", "universities", "resolve.js");
        assert.ok(src.includes('require("../_lib/universityResolveService")'), "resolve.js must import the existing university resolver service, not a new one");
        assert.ok(src.includes("resolveGoogleMapsCandidate"), "resolve.js must route Google Maps candidates through resolveGoogleMapsCandidate()");
    });

    // ══════════════════════ TWIN CONSISTENCY (no drift) ══════════════════════
    await test("TWIN CONSISTENCY: frontend and backend googleMapsParser.js share the same host allow-list and coordinate regexes", () => {
        const frontendSrc = readSource("src", "lib", "googleMapsParser.js");
        const backendSrc = readSource("api", "_lib", "googleMapsParser.js");
        const mustMatch = [
            'new Set(["google.com", "www.google.com", "maps.google.com"])',
            "/!3d(-?\\d+(?:\\.\\d+)?)!4d(-?\\d+(?:\\.\\d+)?)/",
            "/@(-?\\d+(?:\\.\\d+)?),(-?\\d+(?:\\.\\d+)?)/",
            "maps.app.goo.gl",
            // urlType classification + the new URL-shape extraction strategies
            'path.includes("/place/")',
            'path.includes("/dir/")',
            'path.includes("/search/")',
            "PLACE_TOPIC_RE",
            "!16z([A-Za-z0-9+/_-]+={0,2})",
        ];
        mustMatch.forEach((snippet) => {
            assert.ok(frontendSrc.includes(snippet), `frontend parser missing expected snippet: ${snippet}`);
            assert.ok(backendSrc.includes(snippet), `backend parser missing expected snippet: ${snippet}`);
        });
    });

    // ══════════════════════ URL FORMAT PARSING ══════════════════════
    const { parseGoogleMapsUrl, MAX_URL_LENGTH } = require(path.join(ROOT, "api", "_lib", "googleMapsParser.js"));

    const FULL_PLACE_URL =
        "https://www.google.com/maps/place/Campus+Velbert%2FHeiligenhaus/@51.3274338,6.8972765,12z/data=!4m6!3m5!1s0x47b8c9b123456:0xabc!8m2!3d51.3274305!4d6.9677006!16s%2Fg%2F11abc123";

    await test("PARSE: full place URL — recognized, precise !3d/!4d pin preferred over the @lat,lng viewport center", () => {
        const r = parseGoogleMapsUrl(FULL_PLACE_URL);
        assert.strictEqual(r.isGoogleMapsUrl, true);
        assert.strictEqual(r.isShortLink, false);
        assert.strictEqual(r.name, "Campus Velbert/Heiligenhaus");
        assert.strictEqual(r.coordSource, "precise");
        assert.ok(Math.abs(r.latitude - 51.3274305) < 1e-6);
        assert.ok(Math.abs(r.longitude - 6.9677006) < 1e-6);
    });

    await test("PARSE: place name with %2F and + decodes correctly (Campus+Velbert%2FHeiligenhaus -> 'Campus Velbert/Heiligenhaus')", () => {
        const r = parseGoogleMapsUrl("https://www.google.com/maps/place/Campus+Velbert%2FHeiligenhaus/@51.0,6.0,12z");
        assert.strictEqual(r.name, "Campus Velbert/Heiligenhaus");
    });

    await test("PARSE: %20-encoded spaces decode correctly (University%20of%20Derby)", () => {
        const r = parseGoogleMapsUrl("https://www.google.com/maps/place/University%20of%20Derby/@52.9381,-1.4964,15z");
        assert.strictEqual(r.name, "University of Derby");
    });

    await test("PARSE: apostrophes/ampersands/parentheses/commas in a name survive sanitization untouched", () => {
        const raw = encodeURIComponent("St George's (A&B), University");
        const r = parseGoogleMapsUrl(`https://www.google.com/maps/place/${raw}/@1,2,10z`);
        assert.strictEqual(r.name, "St George's (A&B), University");
    });

    await test("PARSE: falls back to the @lat,lng viewport center when no precise !3d/!4d pin is present", () => {
        const r = parseGoogleMapsUrl("https://www.google.com/maps/place/University+of+Derby/@52.9381,-1.4964,15z");
        assert.strictEqual(r.coordSource, "viewport");
        assert.ok(Math.abs(r.latitude - 52.9381) < 1e-6);
    });

    await test("PARSE: maps.google.com (legacy ?q= form) is recognized without a /maps path prefix requirement", () => {
        const r = parseGoogleMapsUrl("https://maps.google.com/maps?q=University+of+Manchester");
        assert.strictEqual(r.isGoogleMapsUrl, true);
        assert.strictEqual(r.name, "University of Manchester");
        assert.strictEqual(r.latitude, null, "a non-numeric q= is a name, not coordinates");
    });

    await test("PARSE: goo.gl/maps/<code> is recognized as an unresolvable short link (no coordinates guessed)", () => {
        const r = parseGoogleMapsUrl("https://goo.gl/maps/abc123XYZ");
        assert.strictEqual(r.isGoogleMapsUrl, true);
        assert.strictEqual(r.isShortLink, true);
        assert.strictEqual(r.latitude, null);
        assert.strictEqual(r.name, null);
    });

    await test("PARSE: maps.app.goo.gl/<code> is recognized as an unresolvable short link", () => {
        const r = parseGoogleMapsUrl("https://maps.app.goo.gl/AbC123");
        assert.strictEqual(r.isGoogleMapsUrl, true);
        assert.strictEqual(r.isShortLink, true);
    });

    await test("PARSE: goo.gl WITHOUT a /maps path is not recognized (only goo.gl/maps/* is a Maps short link)", () => {
        const r = parseGoogleMapsUrl("https://goo.gl/notmaps/abc123");
        assert.strictEqual(r.isGoogleMapsUrl, false);
    });

    await test("PARSE: an unrelated host (example.com) is never treated as Google Maps, even with a maps-shaped path", () => {
        const r = parseGoogleMapsUrl("https://example.com/maps/place/University+Name/@53.4,-2.2,15z");
        assert.strictEqual(r.isGoogleMapsUrl, false);
    });

    await test("PARSE: www.google.com WITHOUT a /maps path is rejected (e.g. a plain google.com/search link)", () => {
        const r = parseGoogleMapsUrl("https://www.google.com/search?q=university");
        assert.strictEqual(r.isGoogleMapsUrl, false);
    });

    await test("VALIDATION: out-of-range coordinates (lat > 90) in the URL are rejected, not passed through", () => {
        const r = parseGoogleMapsUrl("https://www.google.com/maps/@999,6.9,12z");
        assert.strictEqual(r.isGoogleMapsUrl, true);
        assert.strictEqual(r.latitude, null, "an invalid coordinate must never be surfaced as a usable value");
    });

    await test("VALIDATION: (0,0) 'Null Island' coordinates are rejected even though they're technically in range", () => {
        const r = parseGoogleMapsUrl("https://www.google.com/maps/@0,0,12z");
        assert.strictEqual(r.latitude, null);
        assert.strictEqual(r.longitude, null);
    });

    // ══════════════════════ SECURITY ══════════════════════
    await test("SECURITY: a javascript: URL is never accepted (protocol check rejects it before any host check)", () => {
        const r = parseGoogleMapsUrl("javascript:alert(document.cookie)");
        assert.strictEqual(r.isGoogleMapsUrl, false);
    });

    await test("SECURITY: extremely long input is rejected outright, not regex-processed", () => {
        const huge = "https://www.google.com/maps/place/" + "a".repeat(5000);
        assert.ok(huge.length > MAX_URL_LENGTH);
        const r = parseGoogleMapsUrl(huge);
        assert.strictEqual(r.isGoogleMapsUrl, false);
    });

    await test("SECURITY: malformed URLs never throw — parseGoogleMapsUrl always returns a value", () => {
        ["not a url at all", "https://", "://broken", "", null, undefined, 12345, "%zz%malformed"].forEach((input) => {
            const r = parseGoogleMapsUrl(input);
            assert.strictEqual(typeof r, "object");
            assert.strictEqual(r.isGoogleMapsUrl, false);
        });
    });

    await test("SECURITY: control characters in a decoded place name are stripped, not passed through", () => {
        // Built via String.fromCharCode rather than an inline literal — a raw
        // control byte typed directly into this source file would corrupt it.
        const nulChar = String.fromCharCode(0);
        const unitSepChar = String.fromCharCode(31);
        const rawName = "Test" + nulChar + "Name" + unitSepChar + "University";
        const encoded = encodeURIComponent(rawName);
        const r = parseGoogleMapsUrl(`https://www.google.com/maps/place/${encoded}/@1,2,10z`);
        assert.strictEqual(r.name, "TestNameUniversity");
        const controlCharPattern = new RegExp("[" + String.fromCharCode(0) + "-" + String.fromCharCode(31) + String.fromCharCode(127) + "]");
        assert.ok(!controlCharPattern.test(r.name));
    });

    await test("SECURITY: a userinfo hostname-spoof (google.com@evil.com) is rejected — hostname is evil.com, not an allow-listed host", () => {
        const r = parseGoogleMapsUrl("https://google.com@evil.com/maps/place/X/@1,2,10z");
        assert.strictEqual(r.isGoogleMapsUrl, false);
    });

    await test("SECURITY: a subdomain-suffix hostname spoof (google.com.evil.com) is rejected by exact hostname match", () => {
        const r = parseGoogleMapsUrl("https://google.com.evil.com/maps/place/X/@1,2,10z");
        assert.strictEqual(r.isGoogleMapsUrl, false);
    });

    await test("SECURITY: a short link never triggers a network call — no fetch/redirect-following happens at all", async () => {
        const originalFetch = global.fetch;
        let fetchCalled = false;
        global.fetch = async (...args) => {
            fetchCalled = true;
            return originalFetch ? originalFetch(...args) : { ok: false };
        };
        try {
            parseGoogleMapsUrl("https://maps.app.goo.gl/AbC123");
            assert.strictEqual(fetchCalled, false, "resolving a short link must never make a network request");
        } finally {
            global.fetch = originalFetch;
        }
    });

    // ══════════════════════ resolveGoogleMapsCandidate() — deterministic, Tier 1 only ══════════════════════
    const { resolveGoogleMapsCandidate, GOOGLE_MAPS_PROXIMITY_KM } = require(path.join(ROOT, "api", "_lib", "universityResolveService.js"));
    const CAMPUS_UNIVERSITIES = require(path.join(ROOT, "api", "_lib", "campusUniversities.json"));
    const derby = CAMPUS_UNIVERSITIES.find((u) => u.id === "university-of-derby");
    const manchester = CAMPUS_UNIVERSITIES.find((u) => u.id === "university-of-manchester");

    await test("CANDIDATE: name resolves via Tier 1 and the Maps coordinates corroborate it -> resolved with the trusted Tier 1 coordinates", async () => {
        const result = await resolveGoogleMapsCandidate({ name: "University of Derby", latitude: derby.latitude, longitude: derby.longitude });
        assert.strictEqual(result.status, "resolved");
        assert.strictEqual(result.record.id, "university-of-derby");
        assert.strictEqual(result.record.latitude, derby.latitude);
    });

    await test("CANDIDATE: name resolves via Tier 1 but Maps coordinates are far away -> ambiguous, both the trusted record AND the pasted location are surfaced (never silently picked)", async () => {
        // Manchester's own coordinates, but claiming the name "University of Derby" — several hundred km apart, well beyond GOOGLE_MAPS_PROXIMITY_KM.
        const result = await resolveGoogleMapsCandidate({ name: "University of Derby", latitude: manchester.latitude, longitude: manchester.longitude });
        assert.strictEqual(result.status, "ambiguous");
        assert.strictEqual(result.candidates.length, 2);
        assert.ok(result.candidates.some((c) => c.id === "university-of-derby"), "the trusted Tier 1 record must still be offered as an option");
        assert.ok(result.candidates.some((c) => c.latitude === manchester.latitude && c.longitude === manchester.longitude), "the pasted Google Maps location must also be offered as an option, not discarded");
    });

    await test("CANDIDATE: no name extracted at all -> not_found with reason 'no_institution_name', never a reverse-geocode guess", async () => {
        const result = await resolveGoogleMapsCandidate({ name: null, latitude: 51.5, longitude: -0.1 });
        assert.strictEqual(result.status, "not_found");
        assert.strictEqual(result.reason, "no_institution_name");
    });

    await test("CANDIDATE: name resolves via Tier 1, no coordinates supplied -> resolved on name alone (same trust level as a normal text search)", async () => {
        const result = await resolveGoogleMapsCandidate({ name: "University of Manchester", latitude: null, longitude: null });
        assert.strictEqual(result.status, "resolved");
        assert.strictEqual(result.record.id, "university-of-manchester");
    });

    await test("CANDIDATE: unresolvable name -> not_found, coordinates alone never fabricate a match", async () => {
        const result = await resolveGoogleMapsCandidate({ name: "Xyzzy Nonexistent Fictional Institute Qxzz", latitude: 51.5, longitude: -0.1 });
        assert.ok(["not_found", "unavailable"].includes(result.status));
    });

    await test(`PROXIMITY THRESHOLD: GOOGLE_MAPS_PROXIMITY_KM is documented and generous-but-bounded (${GOOGLE_MAPS_PROXIMITY_KM}km)`, () => {
        assert.ok(Number.isFinite(GOOGLE_MAPS_PROXIMITY_KM) && GOOGLE_MAPS_PROXIMITY_KM > 0 && GOOGLE_MAPS_PROXIMITY_KM <= 200);
    });

    // ══════════════════════ FULL ENDPOINT — mock req/res against api/universities/resolve.js ══════════════════════
    const resolveHandler = require(path.join(ROOT, "api", "universities", "resolve.js"));

    await test("ENDPOINT: a full Google Maps URL for a curated Tier 1 university resolves, with zero AI calls (Tier 1 never escalates)", async () => {
        delete process.env.ANTHROPIC_API_KEY; // prove AI isn't even reachable/needed for this path
        const { req, res, getStatus, getBody } = mockReqRes({ q: FULL_PLACE_URL });
        await resolveHandler(req, res);
        assert.strictEqual(getStatus(), 200);
        const body = getBody();
        assert.strictEqual(body.status, "resolved");
        assert.strictEqual(body.data.id, "campus-velbert-heiligenhaus");
    });

    await test("ENDPOINT: a short Google Maps link with a bogus/unresolvable code returns 'short_link_unresolved' with a null data payload, never a fake university", async () => {
        const { req, res, getStatus, getBody } = mockReqRes({ q: "https://maps.app.goo.gl/AbC123" });
        await resolveHandler(req, res);
        assert.strictEqual(getStatus(), 200);
        assert.strictEqual(getBody().status, "short_link_unresolved");
        assert.strictEqual(getBody().data, null);
        assert.strictEqual(getBody().reason, "GOOGLE_MAPS_LINK_UNRESOLVED");
    });

    await test("ENDPOINT: a non-Google-Maps URL returns not_found rather than being treated as a text search", async () => {
        const { req, res, getBody } = mockReqRes({ q: "https://example.com/maps/place/Fake+University/@1,2,10z" });
        await resolveHandler(req, res);
        assert.strictEqual(getBody().status, "not_found");
        assert.strictEqual(getBody().reason, "not_a_maps_link");
    });

    await test("ENDPOINT: a Google Maps URL with no usable name or coordinates returns 'invalid_location'", async () => {
        const { req, res, getBody } = mockReqRes({ q: "https://www.google.com/maps/@0,0,3z" });
        await resolveHandler(req, res);
        assert.strictEqual(getBody().status, "invalid_location");
    });

    await test("ENDPOINT: an oversized Google Maps URL (> MAX_URL_LENGTH) is rejected with 400, not silently truncated", async () => {
        const { req, res, getStatus, getBody } = mockReqRes({ q: "https://www.google.com/maps/place/" + "a".repeat(3000) });
        await resolveHandler(req, res);
        assert.strictEqual(getStatus(), 400);
        assert.strictEqual(getBody().error, "query_too_long");
    });

    // ══════════════════════ REGRESSION — plain-text search remains fully unchanged ══════════════════════
    await test("REGRESSION: a normal curated university name still resolves exactly as before", async () => {
        const { req, res, getBody } = mockReqRes({ q: "University of Manchester" });
        await resolveHandler(req, res);
        assert.strictEqual(getBody().status, "resolved");
        assert.strictEqual(getBody().data.id, "university-of-manchester");
    });

    await test("REGRESSION: a misspelled curated university name still resolves via local fuzzy match", async () => {
        const { req, res, getBody } = mockReqRes({ q: "Univesity of Manchster" });
        await resolveHandler(req, res);
        assert.strictEqual(getBody().status, "resolved");
        assert.strictEqual(getBody().data.id, "university-of-manchester");
    });

    await test("REGRESSION: the plain-text 120-character length gate is still enforced for non-URL input", async () => {
        const { req, res, getStatus, getBody } = mockReqRes({ q: "a".repeat(200) });
        await resolveHandler(req, res);
        assert.strictEqual(getStatus(), 400);
        assert.strictEqual(getBody().error, "query_too_long");
    });

    await test("REGRESSION: an empty query is still rejected with 400 invalid_query", async () => {
        const { req, res, getStatus, getBody } = mockReqRes({ q: "   " });
        await resolveHandler(req, res);
        assert.strictEqual(getStatus(), 400);
        assert.strictEqual(getBody().error, "invalid_query");
    });

    await test("REGRESSION: ?id= lookup for a curated Tier 1 record is unaffected", async () => {
        const { req, res, getBody } = mockReqRes({ id: "university-of-manchester" });
        await resolveHandler(req, res);
        assert.strictEqual(getBody().status, "resolved");
        assert.strictEqual(getBody().data.id, "university-of-manchester");
    });

    // Several tiers above (Tier 2 lookup, local fuzzy matching) call
    // connectToDatabase() unconditionally whenever MONGODB_URI is set —
    // Mongoose's connection is a persistent socket (an open handle), so
    // without an explicit disconnect here this script's own Node process
    // never exits on its own (same fix as verify-university-ai-discovery.js).
    if (process.env.MONGODB_URI) {
        try {
            const { disconnectFromDatabase } = require(path.join(ROOT, "api", "_lib", "mongodb"));
            await disconnectFromDatabase();
        } catch {
            /* best-effort — never let cleanup itself fail the run */
        }
    }

    console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
    if (failed > 0) {
        console.log("Failures:");
        failures.forEach((f) => console.log(`  - ${f.name}\n    ${f.message}`));
        process.exitCode = 1;
    }
}

main().catch((err) => {
    console.error("FATAL:", err);
    process.exitCode = 1;
});
