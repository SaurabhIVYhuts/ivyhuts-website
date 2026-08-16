// Bounds a promise to `ms` milliseconds, resolving to `fallback` instead of
// hanging if it doesn't settle in time.
//
// IMPORTANT — this only protects against SLOW promises, not FAILING ones:
// Promise.race relays whichever input settles first, resolve OR reject. If
// `promise` rejects quickly (a real connection error — bad URI, auth
// failure, ECONNREFUSED — as opposed to a hang), that rejection propagates
// immediately; the timeout never gets a chance to "win" and supply
// `fallback`. (Confirmed live: this is exactly what let a Mongo connection
// error take down the entire /api/search response — see
// api/_lib/searchIndex.js's searchProperties, which now catches its own
// errors independently of this wrapper rather than assuming this covers
// that case.) Callers that want "never fails, only ever slow" must catch
// their own promise's rejections themselves — this utility is timeout-only.
//
// Exists specifically because api/_lib/mongodb.js's connectToDatabase() uses
// a 10-SECOND serverSelectionTimeoutMS — the right choice for features that
// genuinely need Mongo to function, but fatal for the two callers this
// wraps (api/_lib/searchIndex.js's property search, api/amber.js's
// index-on-read hook): both are best-effort/opportunistic — the search
// index and the property-name Mongo mirror are allowed to be incomplete or
// briefly unavailable — so if Mongo is slow, unreachable, or misconfigured,
// neither one may be allowed to make the PRIMARY response (autocomplete
// results, the actual Amber listings/detail payload) wait on it.
"use strict";

function withTimeout(promise, ms, fallback) {
    let timer;
    const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

module.exports = { withTimeout };
