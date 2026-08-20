// One tiny document per city — a freshness pointer for the accommodation
// index (AccommodationResidence.js), so "is this city fresh/stale/missing"
// is a single O(1) indexed lookup instead of aggregating the (larger)
// residence collection on every planner request.
//
// lastRefreshedAt is updated on any successful (non-throwing) refresh
// attempt, including a legitimately empty result (status "empty") — only a
// genuinely thrown error (Amber timeout/budget/lock/Redis) leaves it
// untouched and sets status "error". See accommodationIndex.js's
// refreshCityIndex() for why: an empty-but-valid city must still start the
// freshness clock, or it would look "missing" forever and re-attempt a
// refresh on every single request instead of respecting the 30min/24h window.
//
// Milestone 4 additions (all additive, all optional with safe defaults — see
// accommodationIndex.js's classifyCityState()/attemptCityRefresh() for how
// they're used): the pre-existing three fields above are untouched in
// meaning, and every document written before this milestone reads back with
// these new fields simply defaulting to "never attempted"/zero, which
// classifyCityState() already treats as "no cooldown in effect" — so no
// migration/backfill is required for existing documents to keep working.
//   lastAttemptedAt      — every refresh ATTEMPT (success or failure), unlike
//                           lastRefreshedAt which only moves on a
//                           non-throwing outcome. This is what the
//                           failure-cooldown check reads, so a failing city
//                           is not re-attempted by every single request.
//   lastErrorAt / lastError — most recent thrown-refresh failure, for
//                           observability ("why is Manchester stale?")
//                           without reading raw logs. lastError is truncated
//                           and is a plain message string — never a stack
//                           trace, token, or full error object.
//   consecutiveFailures   — reset to 0 on any successful attempt; used only
//                           to cap the backoff cooldown (see
//                           REFRESH_FAILURE_COOLDOWN_MS), never to permanently
//                           blacklist a city.
const mongoose = require("mongoose");
const { Schema } = mongoose;

const AccommodationIndexMetaSchema = new Schema({
    city: { type: String, required: true, unique: true }, // normalized, same as AccommodationResidence.city
    lastRefreshedAt: { type: Date, default: null },
    // "refreshing" is a best-effort, non-authoritative observability marker
    // only — the Redis city-refresh lock (see accommodationIndex.js) is what
    // actually prevents a duplicate refresh; this field can legitimately
    // read stale ("refreshing" after the attempt already finished) since
    // Mongo writes are not on the lock's own critical path.
    status: { type: String, enum: ["ok", "empty", "error", "refreshing"], default: "error" },
    residenceCount: { type: Number, default: 0 },
    lastAttemptedAt: { type: Date, default: null },
    lastErrorAt: { type: Date, default: null },
    lastError: { type: String, default: null, maxlength: 500 },
    consecutiveFailures: { type: Number, default: 0 },

    // Milestone 8 additions (IVYHUTS_MILESTONE_8_REFRESH_LIFECYCLE_REPORT.md)
    // — all additive, all optional with safe defaults, same "no migration
    // needed" guarantee as the Milestone 4 fields above. Track the LIFECYCLE
    // of the most recent refresh ATTEMPT (distinct from `status`, which
    // tracks the outcome of the most recent COMPLETED refresh — untouched by
    // this milestone, still read/written exactly as before).
    //
    // Unlike the pre-existing `status: "refreshing"` enum value (Milestone 4,
    // deliberately never written — see that field's own comment on why a
    // stuck-state risk made it unsafe without an operation identity), these
    // fields ARE now written, because `operationId` gives each attempt a
    // stable, comparable identity: a caller reading `refreshStatus` can tell
    // whether it's looking at the attempt IT triggered or a different,
    // possibly-stale one. Still purely OBSERVABILITY — never load-bearing for
    // correctness (the Redis `accommodation:refreshlock:<city>` key, with its
    // own self-expiring TTL, remains the actual mutual-exclusion mechanism;
    // these fields can legitimately read a few hundred ms stale, same
    // "Mongo writes are not on the lock's own critical path" caveat the
    // pre-existing `status` field's comment already states).
    operationId: { type: String, default: null },
    refreshStatus: { type: String, enum: ["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED"], default: null },
    refreshStartedAt: { type: Date, default: null },
    refreshCompletedAt: { type: Date, default: null },
});

module.exports = mongoose.models.AccommodationIndexMeta || mongoose.model("AccommodationIndexMeta", AccommodationIndexMetaSchema);
