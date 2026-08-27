// Route table for the consolidated /api/insights/** dispatcher
// (api/insights/[[...path]].js). Mixes session-auth dashboard routes
// (market/overview/snapshot/snapshot-dates/sold-out-trend, via
// authorizeInsights) with CRON_SECRET-gated background jobs (daily-digest,
// advance-crawl) — each handler still enforces its own auth, the dispatcher
// itself makes no authorization decisions.
module.exports = [
    { segments: ["market"], handler: require("./insights/market.js") },
    { segments: ["overview"], handler: require("./insights/overview.js") },
    { segments: ["snapshot-dates"], handler: require("./insights/snapshot-dates.js") },
    { segments: ["snapshot"], handler: require("./insights/snapshot.js") },
    { segments: ["sold-out-trend"], handler: require("./insights/sold-out-trend.js") },
    { segments: ["daily-digest"], handler: require("./insights/daily-digest.js") },
    { segments: ["advance-crawl"], handler: require("./insights/advance-crawl.js") },
];
