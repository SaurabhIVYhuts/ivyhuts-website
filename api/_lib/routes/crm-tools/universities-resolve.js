// Vercel serverless function — the single entry point for the University
// Housing page's discovery feature. Every request funnels into
// api/_lib/universityResolveService.js's tiered resolution; this file is
// deliberately thin (same "thin gateway, real logic in _lib" pattern as
// api/amber.js), and does nothing accommodation-related itself — it never
// imports amberGateway.js or accommodationIndex.js.
//
// GET  ?id=<canonicalId>        -> resolve a previously-known id (shareable ?university=<id> URLs)
// GET  ?q=<free text>           -> run the full Tier 1/2/fuzzy/AI/Nominatim escalation
// GET  ?q=<Google Maps URL>     -> detect + parse the URL (a short maps.app.goo.gl/goo.gl/
//                                  share.google link is first resolved to its canonical full URL — see
//                                  googleMapsShortLinkResolver.js — then parsed identically),
//                                  then resolve the extracted candidate through the SAME
//                                  escalation above (see resolveGoogleMapsCandidate() in
//                                  universityResolveService.js)
// POST { query, candidate }     -> confirm one candidate the user picked from an earlier "ambiguous" response
const { resolveUniversity, resolveUniversityById, resolveGoogleMapsCandidate, MAX_QUERY_LENGTH } = require("../../universityResolveService");
const { parseGoogleMapsUrl, MAX_URL_LENGTH } = require("../../googleMapsParser");
const { resolveGoogleMapsShortLink } = require("../../googleMapsShortLinkResolver");
const { withCors } = require("../../cors");

module.exports = async (req, res) => {
    res.setHeader("Cache-Control", "no-store"); // discovery results are per-query and often user-specific (ambiguous picks) — never CDN-cached, unlike /api/amber
    // Milestone 23.3 (CRM Find Rooms foundation) — the CRM needs to call
    // this endpoint cross-origin for university lookup (see
    // api/_lib/providers/accommodation/README.md). Public/unauthenticated
    // behavior is unchanged; this only adds the headers a browser needs to
    // let a different-origin caller read the (already-public) response.
    if (withCors(req, res)) return; // preflight handled

    try {
        if (req.method === "GET") {
            const { id, q } = req.query || {};

            if (typeof id === "string" && id.trim()) {
                const record = await resolveUniversityById(id);
                res.status(200).json(record ? { ok: true, status: "resolved", data: record } : { ok: true, status: "not_found", data: null });
                return;
            }

            if (typeof q !== "string" || !q.trim()) {
                res.status(400).json({ ok: false, error: "invalid_query", message: "A search query ('q') or id is required." });
                return;
            }

            const trimmedQ = q.trim();
            const looksLikeUrl = /^https?:\/\//i.test(trimmedQ);

            // Google Maps URL detection happens BEFORE the plain-text search
            // path (and before AI/Nominatim are ever reached) — a pasted URL
            // is never treated as a free-text university name. This check is
            // authoritative here regardless of what the client already
            // determined client-side (UniversitySearchBox.js pre-filters the
            // obvious cases for a snappier UX, but never for security).
            if (looksLikeUrl) {
                if (trimmedQ.length > MAX_URL_LENGTH) {
                    res.status(400).json({ ok: false, error: "query_too_long", message: `Google Maps links must be ${MAX_URL_LENGTH} characters or fewer.` });
                    return;
                }
                let parsed = parseGoogleMapsUrl(trimmedQ);
                if (!parsed.isGoogleMapsUrl) {
                    res.status(200).json({ ok: true, status: "not_found", data: null, reason: "not_a_maps_link" });
                    return;
                }
                if (parsed.isShortLink) {
                    // maps.app.goo.gl / goo.gl/maps carry no coordinates in
                    // the URL text itself — resolve the redirect (validated,
                    // allow-listed hosts only, see
                    // googleMapsShortLinkResolver.js) to obtain the
                    // canonical full Google Maps URL, then re-parse THAT
                    // through the exact same parseGoogleMapsUrl() below, so
                    // a short link and a pasted full URL go through
                    // identical downstream logic from this point on.
                    const shortLinkResult = await resolveGoogleMapsShortLink(trimmedQ);
                    if (!shortLinkResult.ok) {
                        res.status(200).json({ ok: true, status: "short_link_unresolved", data: null, reason: "GOOGLE_MAPS_LINK_UNRESOLVED" });
                        return;
                    }
                    const canonicalParsed = parseGoogleMapsUrl(shortLinkResult.canonicalUrl);
                    if (!canonicalParsed.isGoogleMapsUrl || canonicalParsed.isShortLink) {
                        // Defensive only — followRedirectChain() only ever
                        // returns ok:true for a URL classifyHost() already
                        // called "full", so this should be unreachable.
                        res.status(200).json({ ok: true, status: "short_link_unresolved", data: null, reason: "GOOGLE_MAPS_LINK_UNRESOLVED" });
                        return;
                    }
                    parsed = canonicalParsed;
                }
                if (!parsed.name && parsed.latitude == null) {
                    res.status(200).json({ ok: true, status: "invalid_location", data: null, reason: "no_location_data" });
                    return;
                }

                const mapsResult = await resolveGoogleMapsCandidate({ name: parsed.name, latitude: parsed.latitude, longitude: parsed.longitude });
                if (mapsResult.status === "not_found") {
                    res.status(200).json({ ok: true, status: "maps_no_institution", data: null, reason: mapsResult.reason || "no_match" });
                    return;
                }
                res.status(200).json({ ok: true, status: mapsResult.status, data: mapsResult.record || mapsResult.candidates || null, reason: mapsResult.reason });
                return;
            }

            if (q.length > MAX_QUERY_LENGTH) {
                res.status(400).json({ ok: false, error: "query_too_long", message: `Search text must be ${MAX_QUERY_LENGTH} characters or fewer.` });
                return;
            }

            const result = await resolveUniversity(q);
            res.status(200).json({ ok: true, status: result.status, data: result.record || result.candidates || null, reason: result.reason });
            return;
        }

        if (req.method === "POST") {
            const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
            const { query, candidate } = body;
            if (!candidate || typeof candidate !== "object") {
                res.status(400).json({ ok: false, error: "invalid_candidate", message: "A candidate to confirm is required." });
                return;
            }
            const result = await resolveUniversity(String(query || "").slice(0, MAX_QUERY_LENGTH), { confirmedCandidate: candidate });
            res.status(200).json({ ok: true, status: result.status, data: result.record || null });
            return;
        }

        res.status(405).json({ ok: false, error: "method_not_allowed" });
    } catch (err) {
        // Every real failure mode inside universityResolveService.js already
        // degrades to a status in its return value (not_found/unavailable) —
        // reaching here means something unexpected (a bug, not a modeled
        // condition), so respond generically rather than leaking internals.
        console.error("[universities/resolve] unexpected error:", err);
        res.status(200).json({ ok: true, status: "unavailable", data: null, reason: "unexpected_error" });
    }
};
