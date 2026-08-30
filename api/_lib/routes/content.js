// Route table for the consolidated /api/content/** dispatcher
// (api/content/[[...path]].js), which vercel.json's `rewrites` map every
// original flat public URL onto (e.g. /api/amber -> /api/content/amber) —
// see that file's own header comment for why rewrites are used here instead
// of a directory-owned catch-all (these 11 files never shared a directory
// to begin with). All handlers are unmodified from their original
// api/*.js versions, just relocated. Includes one binary responder
// (student-planner-ppt) — the dispatcher passes its response through
// untouched, same as every other route.
//
// `["__university-housing-inventory__"]` (rather than the original
// ["university-housing", "inventory"] two-segment shape) exists because a
// live `vercel dev` test found the catch-all only ever matches EXACTLY one
// path segment past this dispatcher's own directory — see
// api/_lib/routes/leads.js's fuller comment on this same limitation and how
// vercel.json's rewrite flattens it before this file ever sees the request.
module.exports = [
    { segments: ["amber"], handler: require("./content/amber.js") },
    { segments: ["city-listings"], handler: require("./content/city-listings.js") },
    { segments: ["country-listings"], handler: require("./content/country-listings.js") },
    { segments: ["search"], handler: require("./content/search.js") },
    { segments: ["search-data"], handler: require("./content/search-data.js") },
    { segments: ["__university-housing-inventory__"], handler: require("./content/university-housing/inventory.js") },
    { segments: ["student-planner"], handler: require("./content/student-planner.js") },
    { segments: ["student-planner-ppt"], handler: require("./content/student-planner-ppt.js") },
    { segments: ["enquire"], handler: require("./content/enquire.js") },
    { segments: ["events"], handler: require("./content/events/index.js") },
    { segments: ["warm-amber-cache"], handler: require("./content/warm-amber-cache.js") },
];
