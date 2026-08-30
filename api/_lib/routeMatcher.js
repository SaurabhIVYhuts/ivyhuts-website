// Shared dynamic-route matcher for the consolidated group dispatchers
// (api/<group>/[[...path]].js — see api/_lib/routes/*.js for each group's
// table) and scripts/local-api-server.js's plain-Node equivalent, so the two
// can never drift into different routing behavior.
//
// Works on an already-split, already-decoded array of path segments, never
// a raw string — this sidesteps any encode/decode ambiguity between
// Vercel's pre-decoded catch-all params (see vercelSegments below for the
// actual query key) and Node's raw, still-percent-encoded url.pathname
// under the local dev server. Each
// context's own adapter (vercelSegments / localSegments below) is
// responsible for producing that array correctly; matchRoute itself never
// touches encoding.
//
// A route's `segments` is an array where a plain string must match that
// exact literal segment, `{param: "id"}` matches any single segment and
// captures its value under that name (mirrors Vercel's own `[id]` vs
// static-folder distinction, just expressed as data instead of file paths),
// and `{prefix, params}` matches a single segment that starts with the
// literal `prefix` — the remainder is split on "--" and assigned to
// `params` in order. That last shape exists only because a live `vercel
// dev` test found that a rewrite whose destination combines a catch-all
// path with its own "?query=value" gets corrupted (Vercel's local dev
// mis-parses the "?" boundary against a `[[...path]].js` destination,
// producing a garbled segment and never setting the intended query key) —
// confirmed independently of whether the value was a static string or a
// `:param` substitution. Encoding a captured id directly into the segment
// TEXT itself (e.g. rewriting to `/api/leads/discovery--:id`, no "?"
// anywhere in the destination) was confirmed clean. "--" is a safe
// delimiter since every id these routes ever carry is a 24-char hex Mongo
// ObjectId, which never contains a hyphen.
function matchRoute(routes, segments) {
    for (const route of routes) {
        if (route.segments.length !== segments.length) continue;
        const params = {};
        let ok = true;
        for (let i = 0; i < route.segments.length; i++) {
            const seg = route.segments[i];
            const actual = segments[i];
            if (typeof seg === "string") {
                if (seg !== actual) {
                    ok = false;
                    break;
                }
            } else if (seg.prefix != null) {
                if (typeof actual !== "string" || !actual.startsWith(seg.prefix)) {
                    ok = false;
                    break;
                }
                const values = actual.slice(seg.prefix.length).split("--");
                if (values.length !== seg.params.length || values.some((v) => !v)) {
                    ok = false;
                    break;
                }
                seg.params.forEach((name, idx) => {
                    params[name] = values[idx];
                });
            } else {
                params[seg.param] = actual;
            }
        }
        if (ok) return { handler: route.handler, params };
    }
    return null;
}

// Vercel's [[...path]].js dynamic-segment query key — confirmed live against
// a real `vercel dev` instance (not documented anywhere obvious, and NOT the
// bare "path" key Next.js's router uses for the same file convention): for
// an optional catch-all file literally named `[[...path]].js`, the query key
// Vercel actually sets is the inner bracketed name verbatim, e.g.
// `req.query["[...path]"]` — one layer of brackets stripped, not two. Every
// dispatcher's route table names its catch-all file `[[...path]].js`, so
// this constant matches all of them; a group using a different name (it
// shouldn't) would need its own matcher import instead.
const VERCEL_CATCHALL_KEY = "[...path]";

// Normalizes Vercel's catch-all query value to a segment array, and removes
// the raw key from req.query afterward (mutates req) so a matched handler's
// own req.query reads (id, propertyId, etc. — merged in by the caller after
// this runs) are never polluted by this routing-internal key. Checked in
// this order: the real key observed above, then the bare "path" key (in
// case a future Vercel version reverts to the Next.js-style convention —
// cheap to keep both rather than silently breaking again on an undocumented
// change), then empty (the exact base path, e.g. /api/wishlist — Vercel
// omits the key entirely rather than sending [] or "").
function vercelSegments(req) {
    let raw;
    if (VERCEL_CATCHALL_KEY in req.query) {
        raw = req.query[VERCEL_CATCHALL_KEY];
        delete req.query[VERCEL_CATCHALL_KEY];
    } else if ("path" in req.query) {
        raw = req.query.path;
        delete req.query.path;
    }
    if (Array.isArray(raw)) return raw;
    if (raw != null) return [raw];
    return [];
}

// scripts/local-api-server.js's plain Node http server: url.pathname is
// still percent-encoded (Node never decodes it), so this strips the group's
// own base prefix and decodes each remaining segment — mirroring what
// Vercel already does for us automatically once deployed.
function localSegments(pathname, basePath) {
    const rest = pathname.startsWith(basePath) ? pathname.slice(basePath.length) : pathname;
    return rest.split("/").filter(Boolean).map(decodeURIComponent);
}

module.exports = { matchRoute, vercelSegments, localSegments };
