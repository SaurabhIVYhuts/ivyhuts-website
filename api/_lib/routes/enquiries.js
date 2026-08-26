// Route table for the consolidated /api/enquiries/** dispatcher
// (api/enquiries/[[...path]].js). Both handlers are unmodified from their
// original api/enquiries/*.js versions, just relocated.
//
// The `["__base__"]` entry exists because a live `vercel dev` test found
// that Vercel's file-system routing for a plain (non-Next.js) `api/`
// directory does NOT match `[[...path]].js` against the bare parent path —
// see api/_lib/routes/wishlist.js's identical comment for the full
// explanation. This matters a lot here specifically: POST /api/enquiries is
// the PUBLIC enquiry-form submission endpoint, so without this rewrite
// (vercel.json rewrites /api/enquiries -> /api/enquiries/__base__) it would
// have been completely unreachable in production.
module.exports = [
    { segments: [], handler: require("./enquiries/index.js") },
    { segments: ["__base__"], handler: require("./enquiries/index.js") },
    { segments: [{ param: "id" }], handler: require("./enquiries/[id].js") },
];
