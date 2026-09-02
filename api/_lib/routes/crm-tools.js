// Route table for the consolidated /api/crm-tools/** dispatcher
// (api/crm-tools/[[...path]].js), which vercel.json's `rewrites` map every
// original flat/nested public URL onto — see that file's own header
// comment. All handlers are unmodified from their original api/*.js
// versions, just relocated.
//
// Every entry below except "staff" uses a single `"__name__"` synthetic
// segment (rather than its original 2-3 segment shape, e.g.
// ["properties", "search"]) because a live `vercel dev` test found the
// catch-all only ever matches EXACTLY one path segment past this
// dispatcher's own directory — see api/_lib/routes/leads.js's fuller
// comment on this same limitation and how vercel.json's rewrite flattens
// each one before this file ever sees the request.
module.exports = [
    { segments: ["__properties-search__"], handler: require("./crm-tools/properties-search.js") },
    { segments: ["__universities-resolve__"], handler: require("./crm-tools/universities-resolve.js") },
    { segments: ["staff"], handler: require("./crm-tools/staff.js") },
    // Ivy Assistant (read-only CRM chat agent). Single "assistant" segment,
    // same shape as "staff" — vercel.json flattens /api/assistant onto
    // /api/crm-tools/assistant before this table is consulted.
    { segments: ["assistant"], handler: require("./crm-tools/assistant.js") },
    { segments: ["__admin-inventory-health__"], handler: require("./crm-tools/admin/accommodation/inventory-health.js") },
];
