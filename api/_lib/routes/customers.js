// Route table for the consolidated /api/customers/** dispatcher
// (api/customers/[[...path]].js). All four handlers are unmodified from
// their original api/customers/*.js versions, just relocated.
//
// Order matters: literal routes ("me", "__base__") must come before the
// {param:"id"} route since all three match a single segment — matchRoute
// returns the first match, so a literal would otherwise be swallowed as if
// it were an :id value.
//
// The `["__base__"]` entry exists because a live `vercel dev` test found
// that Vercel's file-system routing for a plain (non-Next.js) `api/`
// directory does NOT match `[[...path]].js` against the bare parent path —
// see api/_lib/routes/wishlist.js's identical comment for the full
// explanation.
//
// The `{prefix: "lifecycle--", params: ["id"]}` entry exists for the same
// underlying reason, one level further: that same test found the catch-all
// only ever matches EXACTLY one path segment — /api/customers/:id/lifecycle
// (two segments past /api/customers) never reaches this dispatcher at all
// otherwise. A first attempt rewrote it to /api/customers/__lifecycle__
// ?id=:id, but that combination (a catch-all destination PLUS its own
// "?query=value") turned out to corrupt the segment in Vercel's local dev
// too — see api/_lib/routes/leads.js's fuller comment on both findings.
// vercel.json now rewrites straight to /api/customers/lifecycle--:id (no
// "?" anywhere), and routeMatcher.js's `{prefix, params}` type parses the
// id back out of the segment text itself — the handler still reads
// req.query.id exactly as it always has.
module.exports = [
    { segments: [], handler: require("./customers/index.js") },
    { segments: ["__base__"], handler: require("./customers/index.js") },
    { segments: ["me"], handler: require("./customers/me.js") },
    { segments: [{ prefix: "lifecycle--", params: ["id"] }], handler: require("./customers/[id]/lifecycle.js") },
    { segments: [{ param: "id" }], handler: require("./customers/[id].js") },
];
