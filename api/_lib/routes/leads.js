// Route table for the consolidated /api/leads/** dispatcher
// (api/leads/[[...path]].js). Covers 17 of the 18 original api/leads/**
// files — all unmodified, just relocated together as one subtree (so the
// sibling `require("../index.js")` imports used by the communications/
// follow-ups/meetings/presentations :xId routes for their shared helpers
// keep resolving unchanged).
//
// api/leads/meta/webhook.js is deliberately NOT here — it needs the RAW,
// unparsed request body to verify Meta's HMAC signature, which this
// dispatcher (like every other route here) assumes Vercel's default JSON
// body parsing already handled. Folding it in would silently break every
// other route in this file. It stays exactly where it is, its own
// standalone Vercel Function — see that file's own header comment and
// scripts/local-api-server.js's identical carve-out for the same reason.
//
// Two live `vercel dev` findings shaped every `{prefix, params}` entry
// below:
//   1. A plain (non-Next.js) `api/` directory's catch-all (`[[...path]].js`)
//      only ever matches EXACTLY ONE path segment — a request with 2+
//      segments past the dispatcher's own directory never reaches this
//      function at all (confirmed with an isolated, unrelated test route).
//   2. A rewrite whose destination combines that catch-all path with its
//      own "?query=value" gets corrupted — Vercel's local dev mis-parses
//      the "?" boundary, producing a garbled segment and never setting the
//      intended query key (confirmed independently of a static value vs a
//      `:param` substitution).
// vercel.json's rewrites work around both by flattening every real
// multi-segment URL into ONE synthetic segment with any dynamic id(s)
// encoded directly in the segment TEXT (e.g. /api/leads/:id/meetings/
// :meetingId -> /api/leads/meeting-detail--:id--:meetingId, no "?"
// anywhere) — routeMatcher.js's `{prefix, params}` segment type parses
// that back out, splitting on "--" (safe: every id here is a 24-char hex
// Mongo ObjectId, which never contains one). Each handler below still
// reads req.query.id/meetingId/etc. exactly as it always has; only the URL
// shape reaching this file changed, never what the handler receives.
// `["__base__"]` handles the same one-segment limitation for the bare
// /api/leads path (zero segments — also not matched by the catch-all).
module.exports = [
    { segments: ["assignment-summary"], handler: require("./leads/assignment-summary.js") },
    { segments: ["work-queue"], handler: require("./leads/work-queue.js") },
    { segments: [], handler: require("./leads/index.js") },
    { segments: ["__base__"], handler: require("./leads/index.js") },
    { segments: [{ prefix: "assignment--", params: ["id"] }], handler: require("./leads/[id]/assignment.js") },
    { segments: [{ prefix: "accommodation-curation--", params: ["id"] }], handler: require("./leads/[id]/accommodation-curation.js") },
    { segments: [{ prefix: "discovery--", params: ["id"] }], handler: require("./leads/[id]/discovery.js") },
    { segments: [{ prefix: "whatsapp-messages--", params: ["id"] }], handler: require("./leads/[id]/whatsapp/messages.js") },
    { segments: [{ prefix: "communication-detail--", params: ["id", "communicationId"] }], handler: require("./leads/[id]/communications/[communicationId]/index.js") },
    { segments: [{ prefix: "communications--", params: ["id"] }], handler: require("./leads/[id]/communications/index.js") },
    { segments: [{ prefix: "followup-detail--", params: ["id", "followUpId"] }], handler: require("./leads/[id]/follow-ups/[followUpId]/index.js") },
    { segments: [{ prefix: "follow-ups--", params: ["id"] }], handler: require("./leads/[id]/follow-ups/index.js") },
    { segments: [{ prefix: "meeting-detail--", params: ["id", "meetingId"] }], handler: require("./leads/[id]/meetings/[meetingId]/index.js") },
    { segments: [{ prefix: "meetings--", params: ["id"] }], handler: require("./leads/[id]/meetings/index.js") },
    { segments: [{ prefix: "presentation-download--", params: ["id", "presentationId"] }], handler: require("./leads/[id]/presentations/[presentationId]/download.js") },
    { segments: [{ prefix: "presentation-detail--", params: ["id", "presentationId"] }], handler: require("./leads/[id]/presentations/[presentationId]/index.js") },
    { segments: [{ prefix: "presentations--", params: ["id"] }], handler: require("./leads/[id]/presentations/index.js") },
    { segments: [{ param: "id" }], handler: require("./leads/[id].js") },
];
