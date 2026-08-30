// Route table for the consolidated /api/wishlist/** dispatcher
// (api/wishlist/[[...path]].js) — see api/_lib/routeMatcher.js for the
// shared matcher this is fed into. Both handlers are unmodified from their
// original api/wishlist/*.js versions, just relocated (see that directory's
// git history) so Vercel stops counting them as separate Functions.
//
// The `["__base__"]` entry exists because a live `vercel dev` test found
// that Vercel's file-system routing for a plain (non-Next.js) `api/`
// directory does NOT match `[[...path]].js` against the bare parent path
// (confirmed: the function is never even invoked for exactly /api/wishlist
// with zero segments — a genuine platform behavior, not a bug in this
// matcher). vercel.json rewrites that exact path to /api/wishlist/__base__
// instead, which this one-segment literal route catches. The `[]` entry is
// kept too in case that's ever fixed platform-side; a duplicate, unreachable
// route costs nothing.
module.exports = [
    { segments: [], handler: require("./wishlist/index.js") },
    { segments: ["__base__"], handler: require("./wishlist/index.js") },
    { segments: [{ param: "propertyId" }], handler: require("./wishlist/[propertyId].js") },
];
