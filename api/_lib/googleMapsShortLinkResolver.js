// Resolves a Google Maps SHORT link (maps.app.goo.gl/*, goo.gl/maps/*,
// share.google/*) to its canonical full Google Maps URL by following its
// HTTP redirect chain — nothing more. This module never parses
// coordinates/names itself: once a canonical URL is obtained, the caller
// (api/universities/resolve.js) hands it to the EXISTING, unmodified
// parseGoogleMapsUrl() (see googleMapsParser.js), same as any full URL a
// user pastes directly. No competing parser, no second university resolver.
//
// SECURITY — this is the one place in the University Housing discovery
// feature that fetches a URL derived from untrusted user input, so it is
// deliberately narrow:
//   - every hop's hostname is validated via classifyHost()/
//     isTrustedRedirectHost() from googleMapsParser.js (the SAME allow-list
//     the rest of this feature already trusts — share.google/google.com/
//     www.google.com/maps.google.com/goo.gl/maps.app.goo.gl) — never an
//     arbitrary host, never a redirect followed to anything outside that
//     list. A hop landing on a trusted-but-not-yet-"/maps" host (e.g. a
//     share.google interstitial) is only ever a permitted STEPPING STONE —
//     resolution only succeeds once a hop lands on a host+path classifyHost()
//     itself calls "full"
//   - HTTPS only, on every hop (the initial URL AND every Location header /
//     bounce href — see below)
//   - a bounded number of hops (MAX_REDIRECTS) — never an infinite loop
//   - a single shared timeout across the whole chain
//   - HEAD first (falls back to GET only if HEAD doesn't yield a Location
//     header); the body is read in exactly ONE narrow case (see
//     extractBounceHref() below) — everywhere else it is never read, only
//     status + the Location header
//   - nothing about the response is ever returned to the caller beyond the
//     validated canonical URL string or a failure code
//
// share.google's own chain does NOT behave like a plain HTTP redirect the
// way maps.app.goo.gl's does: it bounces through a `google.com/share.google`
// hop that answers HTTP 200 (not a 3xx) whose real destination is embedded
// in a tiny HTML body (`<a href="...">`) rather than a Location header, and
// that destination is itself a `google.com/search?...&q=<name>&kgmid=<id>`
// URL — Google's own Knowledge-Graph-resolved NAME for the place, never a
// `/maps/...` URL or coordinates. Two additions handle this without adding a
// second parser or a new candidate shape:
//   1. extractBounceHref() reads a SIZE-BOUNDED body (MAX_BOUNCE_BODY_LENGTH)
//      ONLY for a 200 response from a host that already passed this same
//      trust check, and ONLY to pull a single `<a href>` — never a general
//      HTML/JS scraper, never for an untrusted host.
//   2. synthesizeMapsSearchUrl(), when a hop lands on exactly this
//      `.../search?...&q=<name>` shape, converts it into an equivalent,
//      standards-shaped Google Maps Search URL
//      (`/maps/search/?api=1&query=<name>`) — which then flows through the
//      EXACT SAME, unmodified parseGoogleMapsUrl() as any other Maps Search
//      URL a user might paste directly.
//
// Amber isolation: this file has no import of, and makes no call to,
// amberGateway.js / accommodationIndex.js / Amber's upstream host, and uses
// its own Redis key namespace ("university:discovery:shortlink:*") — same
// isolation discipline as universityDiscovery.js's Nominatim namespace.
"use strict";

const { classifyHost, isTrustedRedirectHost } = require("./googleMapsParser");
const { sharedGet, sharedSet, acquireLock, releaseLock, log } = require("./sharedStore");

const USER_AGENT = process.env.UNIVERSITY_DISCOVERY_USER_AGENT || "IVYHUTS-UniversityHousing/1.0 (https://ivyhuts.com)";
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 5000; // shared across the whole hop chain, not per-request
const CACHE_TTL_SECONDS = 30 * 24 * 60 * 60; // short links essentially never change destination — long TTL is safe
const LOCK_TTL_MS = TIMEOUT_MS + 3000;
const LOCK_WAIT_RETRIES = 10;
const LOCK_WAIT_STEP_MS = 500;
const CACHE_PREFIX = "university:discovery:shortlink:"; // own namespace — never amber:*
const LOCK_PREFIX = "university:discovery:shortlink:lock:";

// Generous for the tiny "moved" bounce pages actually observed (a few
// hundred bytes) while still bounding memory/parsing work — this is read
// ONLY from a host that already passed classifyHost()/isTrustedRedirectHost()
// at the top of followRedirectChain's loop, never an arbitrary host.
const MAX_BOUNCE_BODY_LENGTH = 8192;

// Minimal decoder for the handful of HTML entities Google's own bounce pages
// actually use in the href attribute (their query-string `&` separators are
// attribute-encoded as `&amp;`) — deliberately NOT a general HTML/entity
// parser, just enough to make `new URL()` see a real query string afterward.
function decodeHtmlEntities(str) {
    return str.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
}

// Reads a response body up to maxBytes, never more — cancels the stream and
// returns null the instant the cap would be exceeded. Falls back to a
// bounded res.text() when the runtime doesn't expose a streaming body
// reader (e.g. a test mock); never throws.
async function readBoundedText(res, maxBytes) {
    if (!res.body || typeof res.body.getReader !== "function") {
        try {
            const text = await res.text();
            return typeof text === "string" && text.length <= maxBytes ? text : null;
        } catch {
            return null;
        }
    }
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    try {
        for (;;) {
            // eslint-disable-next-line no-await-in-loop
            const { done, value } = await reader.read();
            if (done) break;
            total += value.length;
            if (total > maxBytes) {
                await reader.cancel().catch(() => {});
                return null;
            }
            chunks.push(value);
        }
    } catch {
        return null;
    } finally {
        try {
            reader.releaseLock();
        } catch {
            /* best-effort */
        }
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

// Google's "silent bounce" page — see this file's header — carries its real
// destination as a plain `<a href="...">`, never anything more elaborate
// (no JS to execute, no meta-refresh to interpret). Returns the decoded,
// URL-validated href, or null if the body doesn't match this exact narrow
// shape (never throws, never guesses).
function extractBounceHref(bodyText) {
    if (!bodyText || bodyText.length > MAX_BOUNCE_BODY_LENGTH) return null;
    const m = /<a\s+href=["']([^"']+)["']/i.exec(bodyText);
    if (!m) return null;
    try {
        return new URL(decodeHtmlEntities(m[1])).href;
    } catch {
        return null;
    }
}

// A hop that lands on `google.com/search?...&q=<name>` (or `query=`) —
// Google's OWN Knowledge-Graph-resolved name for the place, reached via
// share.google's redirect chain — is converted into the equivalent
// documented Google Maps Search URL API shape so it can flow through the
// EXISTING, unmodified parseGoogleMapsUrl() exactly like any other Maps
// Search URL. Returns null if the URL carries no usable name (never
// fabricates one).
function synthesizeMapsSearchUrl(url) {
    const raw = url.searchParams.get("q") || url.searchParams.get("query");
    const trimmed = raw ? raw.trim() : "";
    return trimmed ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(trimmed)}` : null;
}

// One redirect hop: HEAD first (cheapest — no body at all), falling back to
// GET only if HEAD didn't yield a Location header (some redirectors reject
// HEAD outright, and Google's own bounce pages — see this file's header —
// never set one at all). The body is read ONLY in that last case (a 200
// response with no Location header) — see readBoundedText()/
// extractBounceHref() — every other response's body is cancelled unread.
async function fetchRedirectHop(urlHref, signal) {
    const headers = { "User-Agent": USER_AGENT, Accept: "text/html" };
    let res;
    try {
        res = await fetch(urlHref, { method: "HEAD", redirect: "manual", signal, headers });
    } catch (err) {
        if (err.name === "AbortError") throw err;
        res = null;
    }
    if (res && res.headers.get("location")) {
        return { status: res.status, location: res.headers.get("location"), bounceHref: null };
    }
    if (res?.body) {
        try {
            await res.body.cancel();
        } catch {
            /* best-effort */
        }
    }
    const getRes = await fetch(urlHref, { method: "GET", redirect: "manual", signal, headers });
    const location = getRes.headers.get("location");
    let bounceHref = null;
    if (!location && getRes.status === 200) {
        const bodyText = await readBoundedText(getRes, MAX_BOUNCE_BODY_LENGTH).catch(() => null);
        bounceHref = extractBounceHref(bodyText);
    }
    if (getRes.body && bounceHref === null) {
        try {
            await getRes.body.cancel();
        } catch {
            /* best-effort — we never read the body beyond the one narrow case above */
        }
    }
    return { status: getRes.status, location, bounceHref };
}

// Walks the redirect chain starting from a validated short link until it
// lands on a full Google Maps URL (per the shared classifyHost()) or a hard
// limit is hit. Every intermediate hop must itself be an allow-listed HTTPS
// Google host — a redirect to any other host fails closed immediately.
async function followRedirectChain(startUrl) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        let current = startUrl;
        for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
            let parsed;
            try {
                parsed = new URL(current);
            } catch {
                return { ok: false, code: "invalid_url" };
            }
            if (parsed.protocol !== "https:") return { ok: false, code: "invalid_protocol" };

            const kind = classifyHost(parsed);
            if (kind === "full") return { ok: true, canonicalUrl: current };
            const trusted = kind === "short" || isTrustedRedirectHost(parsed.hostname);
            if (!trusted) return { ok: false, code: "disallowed_host" };
            // A trusted-but-not-yet-"full" host+path (e.g. an interstitial
            // google.com/www.google.com hop) is a permitted stepping stone —
            // EXCEPT the one terminal shape share.google's own chain lands
            // on: a Google Search URL carrying a resolved place name (see
            // synthesizeMapsSearchUrl() / this file's header). That shape is
            // never further redirectable (it's a real search-results page),
            // so it's converted and returned here rather than being fetched.
            if (kind !== "short" && parsed.pathname.toLowerCase() === "/search") {
                const synthesized = synthesizeMapsSearchUrl(parsed);
                if (synthesized) return { ok: true, canonicalUrl: synthesized };
            }
            if (hop === MAX_REDIRECTS) return { ok: false, code: "too_many_redirects" };

            let res;
            try {
                res = await fetchRedirectHop(current, controller.signal);
            } catch (err) {
                if (err.name === "AbortError" || controller.signal.aborted) return { ok: false, code: "timeout" };
                return { ok: false, code: "network_error" };
            }
            if (!res) return { ok: false, code: "no_redirect" };

            let nextLocation;
            if (res.status >= 300 && res.status < 400) {
                if (!res.location) return { ok: false, code: "no_location" };
                nextLocation = res.location;
            } else if (res.status === 200 && res.bounceHref) {
                // Google's "silent bounce" (200, not 3xx) — the body-embedded
                // href IS this hop's redirect target, same as a Location
                // header would be for a normal 3xx (see extractBounceHref()).
                nextLocation = res.bounceHref;
            } else {
                return { ok: false, code: "no_redirect" };
            }

            let next;
            try {
                next = new URL(nextLocation, current);
            } catch {
                return { ok: false, code: "invalid_location" };
            }
            if (next.protocol !== "https:") return { ok: false, code: "invalid_protocol" };
            current = next.href;
        }
        return { ok: false, code: "too_many_redirects" };
    } finally {
        clearTimeout(timer);
    }
}

// Public entry point — cached (so the same short link is never re-resolved
// once its destination is known) and coalesced (25 concurrent searches for
// the identical short link produce ONE redirect fetch, not 25 — same
// lock/wait pattern as universityResolveService.js's Tier 3 Nominatim
// discovery). Returns { ok: true, canonicalUrl } or { ok: false, code }.
// Never throws.
async function resolveGoogleMapsShortLink(shortUrl) {
    const cacheKey = CACHE_PREFIX + shortUrl;
    const cached = await sharedGet(cacheKey).catch(() => undefined);
    if (cached) return { ok: true, canonicalUrl: cached };

    const lockKey = LOCK_PREFIX + shortUrl;
    let token = await acquireLock(lockKey, LOCK_TTL_MS).catch(() => null);

    if (!token) {
        for (let i = 0; i < LOCK_WAIT_RETRIES; i++) {
            // eslint-disable-next-line no-await-in-loop
            await new Promise((r) => setTimeout(r, LOCK_WAIT_STEP_MS));
            // eslint-disable-next-line no-await-in-loop
            const raced = await sharedGet(cacheKey).catch(() => undefined);
            if (raced) return { ok: true, canonicalUrl: raced };
            // eslint-disable-next-line no-await-in-loop
            token = await acquireLock(lockKey, LOCK_TTL_MS).catch(() => null);
            if (token) break;
        }
    }

    try {
        const result = await followRedirectChain(shortUrl);
        if (result.ok) {
            await sharedSet(cacheKey, result.canonicalUrl, CACHE_TTL_SECONDS).catch(() => {});
        } else {
            log("google-maps short-link resolution failed:", result.code);
        }
        return result;
    } finally {
        if (token) await releaseLock(lockKey, token).catch(() => {});
    }
}

module.exports = { resolveGoogleMapsShortLink, MAX_REDIRECTS, TIMEOUT_MS };
