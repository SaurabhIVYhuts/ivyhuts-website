// Resolves a Google Maps SHORT link (maps.app.goo.gl/*, goo.gl/maps/*) to its
// canonical full Google Maps URL by following its HTTP redirect — nothing
// more. This module never parses coordinates/names itself: once a canonical
// URL is obtained, the caller (api/universities/resolve.js) hands it to the
// EXISTING, unmodified parseGoogleMapsUrl() (see googleMapsParser.js), same
// as any full URL a user pastes directly. No competing parser, no second
// university resolver.
//
// SECURITY — this is the one place in the University Housing discovery
// feature that fetches a URL derived from untrusted user input, so it is
// deliberately narrow:
//   - every hop's hostname is validated via classifyHost() from
//     googleMapsParser.js (the SAME allow-list the rest of this feature
//     already trusts — google.com/www.google.com/maps.google.com/goo.gl/
//     maps.app.goo.gl) — never an arbitrary host, never a redirect followed
//     to anything outside that list
//   - HTTPS only, on every hop (the initial URL AND every Location header)
//   - a bounded number of hops (MAX_REDIRECTS) — never an infinite loop
//   - a single shared timeout across the whole chain
//   - HEAD first (falls back to GET only if HEAD doesn't yield a Location
//     header) — either way the response body is never read, only status +
//     the Location header; the full Google Maps HTML page is never
//     downloaded
//   - nothing about the response (headers, status, body) is ever returned to
//     the caller beyond the validated canonical URL string or a failure code
//
// Amber isolation: this file has no import of, and makes no call to,
// amberGateway.js / accommodationIndex.js / Amber's upstream host, and uses
// its own Redis key namespace ("university:discovery:shortlink:*") — same
// isolation discipline as universityDiscovery.js's Nominatim namespace.
"use strict";

const { classifyHost } = require("./googleMapsParser");
const { sharedGet, sharedSet, acquireLock, releaseLock, log } = require("./sharedStore");

const USER_AGENT = process.env.UNIVERSITY_DISCOVERY_USER_AGENT || "IVYHUTS-UniversityHousing/1.0 (https://ivyhuts.com)";
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 5000; // shared across the whole hop chain, not per-request
const CACHE_TTL_SECONDS = 30 * 24 * 60 * 60; // short links essentially never change destination — long TTL is safe
const LOCK_TTL_MS = TIMEOUT_MS + 3000;
const LOCK_WAIT_RETRIES = 10;
const LOCK_WAIT_STEP_MS = 500;
const CACHE_PREFIX = "university:discovery:shortlink:"; // own namespace — never amber:*
const LOCK_PREFIX = "university:discovery:shortlink:lock:";

// One redirect hop: HEAD first (cheapest — no body at all), falling back to
// GET only if HEAD didn't yield a Location header (some redirectors reject
// HEAD outright). Either way the body is cancelled immediately rather than
// read — we only ever need the status code and the Location header.
async function fetchRedirectHop(urlHref, signal) {
    const headers = { "User-Agent": USER_AGENT, Accept: "text/html" };
    let res;
    try {
        res = await fetch(urlHref, { method: "HEAD", redirect: "manual", signal, headers });
    } catch (err) {
        if (err.name === "AbortError") throw err;
        res = null;
    }
    if (!res || !res.headers.get("location")) {
        if (res?.body) {
            try {
                await res.body.cancel();
            } catch {
                /* best-effort */
            }
        }
        res = await fetch(urlHref, { method: "GET", redirect: "manual", signal, headers });
    }
    if (res?.body) {
        try {
            await res.body.cancel();
        } catch {
            /* best-effort — we never read the body either way */
        }
    }
    return res;
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
            if (kind !== "short") return { ok: false, code: "disallowed_host" };
            if (hop === MAX_REDIRECTS) return { ok: false, code: "too_many_redirects" };

            let res;
            try {
                res = await fetchRedirectHop(current, controller.signal);
            } catch (err) {
                if (err.name === "AbortError" || controller.signal.aborted) return { ok: false, code: "timeout" };
                return { ok: false, code: "network_error" };
            }
            if (!res || res.status < 300 || res.status >= 400) return { ok: false, code: "no_redirect" };

            const location = res.headers.get("location");
            if (!location) return { ok: false, code: "no_location" };

            let next;
            try {
                next = new URL(location, current);
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
