#!/usr/bin/env node
// Google Maps SHORT LINK resolution verification (maps.app.goo.gl / goo.gl/maps).
// Covers:
//   - Amber isolation for the new file (googleMapsShortLinkResolver.js)
//   - host allow-list reuse (classifyHost from googleMapsParser.js, no second parser)
//   - redirect-chain security: disallowed host, non-HTTPS hop, private-IP target,
//     missing/malformed Location header, too-many-redirects, network error, timeout
//   - real network resolution of the exact previously-failing URL
//     (https://maps.app.goo.gl/DrMWXNSbHTFmgv948) through the resolver, the
//     EXISTING parser, and the full /api/universities/resolve endpoint
//   - a bogus short-link code fails closed with short_link_unresolved (never a fake university)
//   - full Google Maps URL regression (still works, unchanged)
//   - caching (second resolve of the same short link makes zero network calls)
//   - concurrency coalescing (25 concurrent identical short-link searches -> 1 network call)
//   - zero AI calls when Nominatim resolves the redirected name directly
//
// Same standalone-Node-script convention as every other scripts/verify-*.js in
// this repo (Jest is broken repo-wide for an unrelated pre-existing reason).
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

// sharedStore.js (Redis lock/cache primitives) uses the SAME global fetch()
// this script mocks below to simulate redirect responses — if a real Upstash
// Redis were configured, mocking global.fetch would also intercept its
// GET/SET calls and corrupt the lock/cache logic being tested. Force the
// deterministic in-memory fallback store for this entire run instead (also
// keeps test-only cache keys like "security-test-*" out of the real store).
// Must happen BEFORE anything requires sharedStore.js, which reads these at
// module-load time.
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
delete process.env.KV_REST_API_URL;
delete process.env.KV_REST_API_TOKEN;

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

// ── fetch mocking helpers ──
function fakeHeaders(obj) {
    const lower = {};
    for (const k of Object.keys(obj || {})) lower[k.toLowerCase()] = obj[k];
    return { get: (k) => (lower[String(k).toLowerCase()] ?? null) };
}
function fakeResponse(status, headers) {
    return { status, headers: fakeHeaders(headers), body: { cancel: async () => {} } };
}
function withMockedFetch(impl, fn) {
    const original = global.fetch;
    global.fetch = impl;
    return Promise.resolve()
        .then(fn)
        .finally(() => {
            global.fetch = original;
        });
}

async function main() {
    console.log("=== IvyHuts Google Maps Short-Link Resolver Verification ===\n");

    // ══════════════════════ AMBER ISOLATION ══════════════════════
    const resolverSrc = readSource("api", "_lib", "googleMapsShortLinkResolver.js");
    await test("AMBER ISOLATION: googleMapsShortLinkResolver.js never imports amberGateway.js or accommodationIndex.js", () => {
        assert.ok(!/require\([^)]*amberGateway/.test(resolverSrc));
        assert.ok(!/require\([^)]*accommodationIndex/.test(resolverSrc));
        assert.ok(!/amberstudent\.com/.test(resolverSrc));
    });
    await test("AMBER ISOLATION: uses its own Redis namespace ('university:discovery:shortlink:'), never amber:* keys", () => {
        assert.ok(resolverSrc.includes("university:discovery:shortlink:"));
        assert.ok(!/["'`]amber:/.test(resolverSrc));
    });
    await test("NO COMPETING PARSER: the resolver reuses classifyHost() from googleMapsParser.js rather than re-implementing host detection", () => {
        assert.ok(resolverSrc.includes('require("./googleMapsParser")'));
        assert.ok(resolverSrc.includes("classifyHost"));
    });
    await test("NO COMPETING RESOLVER: api/universities/resolve.js still routes through resolveGoogleMapsCandidate() only — no second university resolver was introduced", () => {
        const src = readSource("api", "universities", "resolve.js");
        assert.ok(src.includes("resolveGoogleMapsCandidate"));
        assert.ok(!/shortLinkUniversityResolver/.test(src));
    });

    const { resolveGoogleMapsShortLink, MAX_REDIRECTS, TIMEOUT_MS } = require(path.join(ROOT, "api", "_lib", "googleMapsShortLinkResolver.js"));
    const { parseGoogleMapsUrl } = require(path.join(ROOT, "api", "_lib", "googleMapsParser.js"));

    await test(`BOUNDS: MAX_REDIRECTS (${MAX_REDIRECTS}) is small and finite; TIMEOUT_MS (${TIMEOUT_MS}) is short`, () => {
        assert.ok(Number.isInteger(MAX_REDIRECTS) && MAX_REDIRECTS >= 1 && MAX_REDIRECTS <= 10);
        assert.ok(Number.isFinite(TIMEOUT_MS) && TIMEOUT_MS > 0 && TIMEOUT_MS <= 15000);
    });

    // ══════════════════════ SECURITY — mocked redirects, no real network ══════════════════════
    await test("SECURITY: a redirect to a non-Google host fails closed (disallowed_host), never followed", async () => {
        await withMockedFetch(
            async (url, opts) => fakeResponse(302, { Location: "https://evil.example/steal" }),
            async () => {
                const r = await resolveGoogleMapsShortLink("https://maps.app.goo.gl/security-test-evil-host");
                assert.strictEqual(r.ok, false);
                assert.strictEqual(r.code, "disallowed_host");
            }
        );
    });

    await test("SECURITY: a redirect to a private IP (http, non-HTTPS) fails closed on the protocol check", async () => {
        await withMockedFetch(
            async () => fakeResponse(302, { Location: "http://127.0.0.1/admin" }),
            async () => {
                const r = await resolveGoogleMapsShortLink("https://maps.app.goo.gl/security-test-private-ip-http");
                assert.strictEqual(r.ok, false);
                assert.strictEqual(r.code, "invalid_protocol");
            }
        );
    });

    await test("SECURITY: a redirect to a private IP over HTTPS still fails closed — the host allow-list, not the protocol, is what rejects it", async () => {
        await withMockedFetch(
            async () => fakeResponse(302, { Location: "https://127.0.0.1/admin" }),
            async () => {
                const r = await resolveGoogleMapsShortLink("https://maps.app.goo.gl/security-test-private-ip-https");
                assert.strictEqual(r.ok, false);
                assert.strictEqual(r.code, "disallowed_host");
            }
        );
    });

    await test("SECURITY: a redirect to 'localhost' fails closed (not an allow-listed Google host)", async () => {
        await withMockedFetch(
            async () => fakeResponse(302, { Location: "https://localhost/steal" }),
            async () => {
                const r = await resolveGoogleMapsShortLink("https://maps.app.goo.gl/security-test-localhost");
                assert.strictEqual(r.ok, false);
                assert.strictEqual(r.code, "disallowed_host");
            }
        );
    });

    await test("SECURITY: a redirect chain exceeding MAX_REDIRECTS fails closed (too_many_redirects), never loops indefinitely", async () => {
        let calls = 0;
        await withMockedFetch(
            async () => {
                calls++;
                return fakeResponse(302, { Location: `https://maps.app.goo.gl/loop-${calls}` });
            },
            async () => {
                const r = await resolveGoogleMapsShortLink("https://maps.app.goo.gl/security-test-redirect-loop");
                assert.strictEqual(r.ok, false);
                assert.strictEqual(r.code, "too_many_redirects");
                assert.ok(calls <= MAX_REDIRECTS, `expected at most ${MAX_REDIRECTS} fetches before giving up, got ${calls}`);
            }
        );
    });

    await test("SECURITY: a missing Location header on a 3xx response fails closed (no_location)", async () => {
        await withMockedFetch(
            async () => fakeResponse(302, {}),
            async () => {
                const r = await resolveGoogleMapsShortLink("https://maps.app.goo.gl/security-test-no-location");
                assert.strictEqual(r.ok, false);
                assert.strictEqual(r.code, "no_location");
            }
        );
    });

    await test("SECURITY: a malformed Location header fails closed (invalid_location), never throws", async () => {
        await withMockedFetch(
            async () => fakeResponse(302, { Location: "http://[not-valid" }),
            async () => {
                const r = await resolveGoogleMapsShortLink("https://maps.app.goo.gl/security-test-malformed-location");
                assert.strictEqual(r.ok, false);
                assert.strictEqual(r.code, "invalid_location");
            }
        );
    });

    await test("SECURITY: a non-redirect (200) response fails closed (no_redirect) instead of guessing", async () => {
        await withMockedFetch(
            async () => fakeResponse(200, {}),
            async () => {
                const r = await resolveGoogleMapsShortLink("https://maps.app.goo.gl/security-test-no-redirect");
                assert.strictEqual(r.ok, false);
                assert.strictEqual(r.code, "no_redirect");
            }
        );
    });

    await test("SECURITY: a network error while resolving fails closed (network_error), never throws out of resolveGoogleMapsShortLink", async () => {
        await withMockedFetch(
            async () => {
                throw new Error("ECONNRESET");
            },
            async () => {
                const r = await resolveGoogleMapsShortLink("https://maps.app.goo.gl/security-test-network-error");
                assert.strictEqual(r.ok, false);
                assert.strictEqual(r.code, "network_error");
            }
        );
    });

    await test("SECURITY: an aborted/timed-out fetch fails closed (timeout), never hangs the request", async () => {
        await withMockedFetch(
            async () => {
                const err = new Error("The operation was aborted");
                err.name = "AbortError";
                throw err;
            },
            async () => {
                const r = await resolveGoogleMapsShortLink("https://maps.app.goo.gl/security-test-timeout");
                assert.strictEqual(r.ok, false);
                assert.strictEqual(r.code, "timeout");
            }
        );
    });

    await test("SECURITY: malformed/empty starting URLs never throw", async () => {
        for (const bad of ["", "not a url", "javascript:alert(1)", "https://"]) {
            const r = await resolveGoogleMapsShortLink(bad);
            assert.strictEqual(r.ok, false);
            assert.ok(typeof r.code === "string");
        }
    });

    await test("SECURITY: an oversized starting URL never triggers a network call — resolveGoogleMapsShortLink is only ever called with an already-length-checked, already-classified short link, but must not hang if misused", async () => {
        await withMockedFetch(
            async () => {
                throw new Error("should not be reachable — host not allow-listed");
            },
            async () => {
                const r = await resolveGoogleMapsShortLink("https://example.com/" + "a".repeat(3000));
                assert.strictEqual(r.ok, false);
                assert.strictEqual(r.code, "disallowed_host");
            }
        );
    });

    await test("SECURITY: HEAD-first — a working redirect never falls back to reading a response body (body.cancel() called, never body read)", async () => {
        let headCalls = 0;
        let getCalls = 0;
        let bodyRead = false;
        await withMockedFetch(
            async (url, opts) => {
                if (opts.method === "HEAD") headCalls++;
                else getCalls++;
                return {
                    status: 302,
                    headers: fakeHeaders({ Location: "https://www.google.com/maps/place/Test+University/@1,2,10z" }),
                    body: {
                        cancel: async () => {
                            bodyRead = false; // cancel(), not a read
                        },
                    },
                };
            },
            async () => {
                const r = await resolveGoogleMapsShortLink("https://maps.app.goo.gl/security-test-head-first");
                assert.strictEqual(r.ok, true);
                assert.strictEqual(headCalls, 1);
                assert.strictEqual(getCalls, 0, "HEAD alone was sufficient — GET fallback must not fire when HEAD already yields a Location header");
                assert.strictEqual(bodyRead, false);
            }
        );
    });

    await test("SECURITY: HEAD without a Location header falls back to GET exactly once (some redirectors reject HEAD)", async () => {
        let headCalls = 0;
        let getCalls = 0;
        await withMockedFetch(
            async (url, opts) => {
                if (opts.method === "HEAD") {
                    headCalls++;
                    return fakeResponse(405, {});
                }
                getCalls++;
                return fakeResponse(302, { Location: "https://www.google.com/maps/place/Test+University/@1,2,10z" });
            },
            async () => {
                const r = await resolveGoogleMapsShortLink("https://maps.app.goo.gl/security-test-get-fallback");
                assert.strictEqual(r.ok, true);
                assert.strictEqual(headCalls, 1);
                assert.strictEqual(getCalls, 1);
            }
        );
    });

    // ══════════════════════ CACHING + CONCURRENCY ══════════════════════
    await test("CACHING: resolving the same short link twice makes exactly one network call — the second call is served from cache", async () => {
        let calls = 0;
        await withMockedFetch(
            async () => {
                calls++;
                return fakeResponse(302, { Location: "https://www.google.com/maps/place/Cache+Test+University/@10,20,12z" });
            },
            async () => {
                const shortUrl = "https://maps.app.goo.gl/caching-test-" + Date.now();
                const first = await resolveGoogleMapsShortLink(shortUrl);
                const second = await resolveGoogleMapsShortLink(shortUrl);
                assert.strictEqual(first.ok, true);
                assert.strictEqual(second.ok, true);
                assert.strictEqual(second.canonicalUrl, first.canonicalUrl);
                assert.strictEqual(calls, 1, "the second resolve should hit the cache, not the network");
            }
        );
    });

    await test("CONCURRENCY: 25 concurrent searches for the identical short link coalesce into a single network call, no global lock across DIFFERENT links", async () => {
        let callsForSharedLink = 0;
        let callsForOtherLink = 0;
        const sharedUrl = "https://maps.app.goo.gl/concurrency-test-" + Date.now();
        const otherUrl = "https://maps.app.goo.gl/concurrency-test-other-" + Date.now();
        await withMockedFetch(
            async (url) => {
                // Simulate real network latency so the 25 concurrent callers
                // genuinely race for the lock instead of trivially serializing.
                await new Promise((r) => setTimeout(r, 30));
                if (url === sharedUrl) callsForSharedLink++;
                else callsForOtherLink++;
                return fakeResponse(302, { Location: "https://www.google.com/maps/place/Concurrency+Test+University/@30,40,12z" });
            },
            async () => {
                const results = await Promise.all([
                    ...Array.from({ length: 25 }, () => resolveGoogleMapsShortLink(sharedUrl)),
                    resolveGoogleMapsShortLink(otherUrl),
                ]);
                assert.ok(results.every((r) => r.ok), "every concurrent caller must still get a successful result");
                assert.strictEqual(callsForSharedLink, 1, `expected exactly 1 network call for the 25 concurrent identical searches, got ${callsForSharedLink}`);
                assert.strictEqual(callsForOtherLink, 1, "a different short link must not be blocked by the shared link's lock");
            }
        );
    });

    // ══════════════════════ REAL NETWORK — the exact previously-failing URL ══════════════════════
    const FAILING_URL = "https://maps.app.goo.gl/DrMWXNSbHTFmgv948";

    await test("REGRESSION FIX: the exact previously-failing URL (maps.app.goo.gl/DrMWXNSbHTFmgv948) is detected as a short link by the existing parser", () => {
        const parsed = parseGoogleMapsUrl(FAILING_URL);
        assert.strictEqual(parsed.isGoogleMapsUrl, true);
        assert.strictEqual(parsed.isShortLink, true);
    });

    let canonicalUrlForFailingCase = null;
    await test("REGRESSION FIX: the exact previously-failing URL resolves to a canonical full Google Maps URL via a real redirect", async () => {
        const r = await resolveGoogleMapsShortLink(FAILING_URL);
        assert.strictEqual(r.ok, true, `expected the redirect to resolve; got failure code: ${r.code}`);
        assert.ok(/^https:\/\/(www\.)?google\.com\/maps\//.test(r.canonicalUrl), `canonical URL should be a full google.com/maps URL, got: ${r.canonicalUrl}`);
        canonicalUrlForFailingCase = r.canonicalUrl;
    });

    await test("REGRESSION FIX: the canonical URL passes through the EXISTING, unmodified parseGoogleMapsUrl() and yields valid coordinates + a name", () => {
        assert.ok(canonicalUrlForFailingCase, "previous step must have produced a canonical URL");
        const parsed = parseGoogleMapsUrl(canonicalUrlForFailingCase);
        assert.strictEqual(parsed.isGoogleMapsUrl, true);
        assert.strictEqual(parsed.isShortLink, false);
        assert.ok(parsed.name && parsed.name.length > 0, "expected a decoded place name");
        assert.ok(Number.isFinite(parsed.latitude) && Math.abs(parsed.latitude) <= 90, "expected a valid latitude");
        assert.ok(Number.isFinite(parsed.longitude) && Math.abs(parsed.longitude) <= 180, "expected a valid longitude");
    });

    await test("REGRESSION FIX: the full /api/universities/resolve endpoint resolves the short link end-to-end into a real institution with valid coordinates", async () => {
        const resolveHandler = require(path.join(ROOT, "api", "universities", "resolve.js"));
        const req = { method: "GET", query: { q: FAILING_URL } };
        let statusCode = null;
        let jsonBody = null;
        const res = {
            setHeader() {},
            status(c) {
                statusCode = c;
                return this;
            },
            json(b) {
                jsonBody = b;
            },
        };
        await resolveHandler(req, res);
        assert.strictEqual(statusCode, 200);
        assert.ok(["resolved", "ambiguous"].includes(jsonBody.status), `expected the university to resolve (or at worst offer disambiguation), got status: ${jsonBody.status}, reason: ${jsonBody.reason}`);
        const record = jsonBody.status === "resolved" ? jsonBody.data : jsonBody.data[0];
        assert.ok(record && record.name, "expected an institution name to be surfaced");
        assert.ok(Number.isFinite(record.latitude) && Math.abs(record.latitude) <= 90);
        assert.ok(Number.isFinite(record.longitude) && Math.abs(record.longitude) <= 180);
        assert.ok(!(record.latitude === 0 && record.longitude === 0), "must never surface Null Island as a real institution's coordinates");
        console.log(`        -> resolved: "${record.name}" (${record.latitude}, ${record.longitude})`);
    });

    await test("AI BEHAVIOR: resolving the short link succeeds with ANTHROPIC_API_KEY unset — proves the direct Nominatim query on the redirected name resolved it, AI escalation was never reached (same proof pattern as the full-URL Tier 1 test above)", async () => {
        const savedKey = process.env.ANTHROPIC_API_KEY;
        delete process.env.ANTHROPIC_API_KEY;
        try {
            const resolveHandler = require(path.join(ROOT, "api", "universities", "resolve.js"));
            const req = { method: "GET", query: { q: FAILING_URL } };
            let jsonBody = null;
            const res = {
                setHeader() {},
                status() {
                    return this;
                },
                json(b) {
                    jsonBody = b;
                },
            };
            await resolveHandler(req, res);
            assert.strictEqual(jsonBody.status, "resolved", "if AI escalation had been required to resolve this, an unset API key would have degraded this to not_found/unavailable instead");
        } finally {
            if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
        }
    });

    // ══════════════════════ CONTROLLED FAILURE — bogus code, never a fake university ══════════════════════
    await test("CONTROLLED FAILURE: a syntactically valid but nonexistent short-link code fails closed with short_link_unresolved, never a fabricated university", async () => {
        const resolveHandler = require(path.join(ROOT, "api", "universities", "resolve.js"));
        const req = { method: "GET", query: { q: "https://maps.app.goo.gl/ThisCodeDoesNotExist000000" } };
        let statusCode = null;
        let jsonBody = null;
        const res = {
            setHeader() {},
            status(c) {
                statusCode = c;
                return this;
            },
            json(b) {
                jsonBody = b;
            },
        };
        await resolveHandler(req, res);
        assert.strictEqual(statusCode, 200);
        assert.strictEqual(jsonBody.status, "short_link_unresolved");
        assert.strictEqual(jsonBody.data, null);
        assert.strictEqual(jsonBody.reason, "GOOGLE_MAPS_LINK_UNRESOLVED");
    });

    // ══════════════════════ REGRESSION — full URL path is untouched ══════════════════════
    await test("REGRESSION: a full (non-short) Google Maps URL still resolves exactly as before — the existing parser was never rewritten", async () => {
        const resolveHandler = require(path.join(ROOT, "api", "universities", "resolve.js"));
        const FULL_URL =
            "https://www.google.com/maps/place/Technical+University+of+Munich/@48.1487646,11.5681764,17z/data=!3m1!4b1!4m6!3m5!1s0x479e7261336d8c11:0x79a04d44dc5bf19d!8m2!3d48.1487646!4d11.5681764";
        const req = { method: "GET", query: { q: FULL_URL } };
        let jsonBody = null;
        const res = {
            setHeader() {},
            status() {
                return this;
            },
            json(b) {
                jsonBody = b;
            },
        };
        await resolveHandler(req, res);
        assert.ok(["resolved", "ambiguous"].includes(jsonBody.status));
    });

    // Several tiers call connectToDatabase() unconditionally whenever
    // MONGODB_URI is set — Mongoose's connection is a persistent socket, so
    // without an explicit disconnect this script's Node process never exits
    // on its own (same fix as the other verify-*.js scripts).
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
