# Amber Architecture — Invariants & Merge Guide

This document exists because a second developer's frontend work (on `main`) will
eventually merge into this branch. The rules below are what must survive that
merge regardless of which branch's JSX/CSS wins in a conflict. If you're
resolving a conflict in a file listed in the Merge Risk Map and you're not sure
which side to keep for a given hunk, this document is the tiebreaker.

None of this changes visible UI. It protects Amber's real 10/minute upstream
limit and the correctness of the shared Redis-backed cache/lock/budget system
sitting behind `/api/amber`.

## Rule 1 — Browser Never Calls Amber Directly

Every Amber read goes:

```
Frontend  →  /api/amber  →  api/_lib/amberGateway.js  →  Redis/protection  →  Amber
```

No frontend component may call `base.amberstudent.com` directly. Verified
(Milestone 4 direct-Amber scan): the only files referencing
`base.amberstudent.com` or the Amber partner ID are `api/_lib/amberGateway.js`
and `api/amber.js`. `src/services/amberApi.js` references
`base.amberstudent.com` only in a comment explaining this exact rule — it
never calls it. The frontend's only Amber-related network call is
`fetch("/api/amber?...")` (same-origin) in `amberApi.js`.

## Rule 2 — No Amber Leads

Nothing in this codebase POSTs a lead/enquiry to Amber. The existing
enquiry/contact flow (`ContactPage.js`, `AccommodationFinderPage.js`,
`ListYourStayPage.js`, `PartnerPage.js`) POSTs to `REACT_APP_SHEETS_URL`
(Google Apps Script), a completely separate, independent system. Amber
integration is read-only by design — do not add a POST/write call to any
`amberstudent.com` endpoint.

## Rule 3 — Central Gateway Only

`api/_lib/amberGateway.js` is the only server-side module allowed to build an
Amber URL or call `fetch()` against it. `api/amber.js` (frontend-facing) and
`api/_lib/cacheWarmer.js` (cron-facing) both call *into* `amberGateway.js`
(`fetchAmber`/`fetchListings`) — neither ever constructs an Amber URL or calls
`fetch()` on Amber's domain itself.

## Rule 4 — Global Budget

Default: `AMBER_MAX_REQUESTS_PER_MINUTE = 6` (env-configurable, defined in
`api/_lib/amberGateway.js`). Amber's own real hard limit is 10/minute with a
5-minute halt on violation — the 6 default is a deliberate safety margin.
Every path that can reach Amber (foreground requests, SWR background
refreshes, cache warming) goes through the same atomic `tryReserveSlot()` in
`api/_lib/sharedStore.js`. Never raise this default as a workaround for
slowness — see Rule 8/9 instead.

## Rule 5 — Redis Shared State

Production relies on Upstash Redis (REST API, `api/_lib/sharedStore.js`) for:
cache entries, the rolling rate budget, distributed locks, the Amber cooldown
flag, and the cache-warmer's rotation cursor. Local development without
`UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` configured falls back to a
per-process in-memory `Map` — intentional and fine for local dev, but it does
**not** coordinate across multiple instances, which is why it must never be
what production silently falls back to (see Rule 6).

## Rule 6 — Fail Closed

If Redis is *configured* (env vars present) but the Upstash REST endpoint
itself fails or is unreachable at request time, the gateway must fail with a
controlled `503`/`cache_unavailable` (or serve stale data if some is already
in hand) — it must never silently fall back to the in-memory store's
behavior. Doing so would let every concurrently-running Vercel instance start
enforcing the full 6/min budget *independently*, multiplying real Amber
traffic by however many instances are warm. This is implemented via
`RedisUnavailableError` in `sharedStore.js`, caught and converted by
`fetchAmber`'s wrapper in `amberGateway.js`. The in-memory fallback path is
only ever taken when `REDIS_AVAILABLE` is `false` at module load (i.e., the
env vars were never set) — a completely different, accepted case from "Redis
is configured but currently down."

## Rule 7 — Stale-While-Revalidate (SWR)

Client-side (`src/services/amberApi.js`, `callGateway`): stale-but-usable
cached data returns to the caller **instantly**, with no network wait. A
background refresh is then kicked off — always at `"LOW"` priority,
*regardless* of what priority the foreground caller used (e.g. `HIGH` for a
property detail page). This is enforced by a single line in `callGateway`:
the background `startNetworkFetch` call is hardcoded to `"LOW"`. A background
refresh must never compete with, or consume budget ahead of, a real waiting
user. The server side deliberately does **not** attempt an equivalent
background refresh (serverless functions can't reliably do fire-and-forget
work after responding) — it just serves stale until a request arrives after
true expiry, which then does one coordinated (locked) refresh.

## Rule 8 — Cache Warming

`api/_lib/cacheWarmer.js`, triggered by `api/warm-amber-cache.js`:

- **LOW priority only** — every warm attempt calls `fetchListings(..., "LOW", "cache-warmer")`.
- **Maximum 1 candidate per execution** (`WARM_BATCH_SIZE = 1`).
- **Trigger**: Vercel Cron, `vercel.json` → `crons: [{ path: "/api/warm-amber-cache", schedule: "*/5 * * * *" }]` — every 5 minutes.
- **Skips when recent usage ≥ half the budget** (`WARM_BUDGET_THRESHOLD = floor(RATE_BUDGET_PER_MINUTE * 0.5)` = 3 of 6 by default) — checked via `peekRecentRequestCount()`, both before picking a candidate and again immediately before the actual fetch attempt.
- **Never calls Amber directly** — goes through `fetchListings()`, inheriting cache-first checks, locking, and budget enforcement exactly like any real user request.
- **Never warms individual property details** — only `type: "listings"` for a 12-city UK pool (`WARM_TARGET_CITIES` in `cacheWarmer.js`), rotated via a small cursor stored in Redis (`amber:warm:cursor`). Property detail pages benefit from the existing listing-summary cache, normal detail cache, client SWR, and distributed locking instead.
- **Vercel Cron only fires against the Production deployment**, not Preview deployments (general Vercel platform behavior, not something this repo can override) — a Preview URL's cache is expected to start cold regardless of how well-warmed Production is.

## Rule 9 — Timeout Budget

- `AMBER_FETCH_TIMEOUT_MS = 25_000` (env-configurable, default 25s) — the `AbortController` timeout on the actual `fetch()` to Amber, in `fetchFromAmberOnce`.
- Vercel `maxDuration = 30` for `api/amber.js`, set in `vercel.json`.
- `LOCK_TTL_MS = AMBER_FETCH_TIMEOUT_MS + 5_000` (30s by default) — always derived from the fetch timeout, never set independently, so it can't accidentally end up shorter than a legitimate in-flight fetch.
- **Listings' primary + fallback share one deadline.** `fetchListings()` (used when Amber's `location_place_name` filter returns zero results for a city that does have listings) establishes one `deadlineAt = Date.now() + AMBER_FETCH_TIMEOUT_MS` and passes it to *both* the primary and the fallback `fetchAmber()` call — they do not each get an independent fresh timeout. If the primary consumes most of the shared deadline, the fallback's own Amber attempt is skipped (`MIN_AMBER_ATTEMPT_MS` floor, proportional: 10% of `AMBER_FETCH_TIMEOUT_MS`, minimum 500ms) rather than risking pushing one invocation past `maxDuration`. If the fallback can't be attempted or fails, `fetchListings` gracefully returns the primary's own (possibly empty) result rather than throwing.
- Real Vercel Preview evidence (Milestone 3C/4): a genuinely cold Amber request has been observed taking ~11–20s; the timeout was raised from an original 20s (which was demonstrated, with real runtime evidence, to be too tight) to the current 25s specifically to give real cold responses room while staying under `maxDuration`.

## Rule 10 — TTL Relationship

| Data Type | Client Fresh | Client Stale-usable | Server Fresh | Server Usable/Retention |
|---|---|---|---|---|
| listings | 3 min | 45 min | 2 min | 50 min |
| detail | 5 min | 60 min | 5 min | 65 min |
| citystats | 60 min | 24 hr | 60 min | 25 hr |

Defined in `CLIENT_TTL` (`src/services/amberApi.js`) and `TTL`
(`api/_lib/amberGateway.js`) respectively — two hand-synced tables, not one
shared module, because `api/` is a plain CommonJS Node runtime with no build
step while `src/` goes through CRA's webpack/babel pipeline (CRA's
`ModuleScopePlugin` blocks importing anything from outside `src/`, so sharing
a literal constants module isn't practical without ejecting/reconfiguring the
build). **The required relationship**: server retention must always be ≥
client's stale-usable window (with a buffer) — if the server expired first,
the client's own "instant stale response" would silently start missing and
fall through to a real blocking fetch, defeating the client cache's purpose.
If either table changes, update both, keeping this relationship intact.

## Rule 11 — cityStats Reuse

After a successful listings Amber fetch (any source — real user, SWR
refresh, or cache warming), `amberGateway.js` derives a trimmed citystats
payload (`buildCityStatsPayloadFromListings`: just `canonical_name` +
`pricing` per item, plus `meta.count` — not the full item objects) and writes
it under that city's own citystats cache key. A citystats request for the
same city shortly after is then a free Redis `HIT` instead of a second Amber
round-trip. This must keep happening for any future code that fetches
listings — don't bypass `fetchAmber`/`fetchListings` for a new listings code
path without also going through this reuse step.

## Rule 12 — Filters (read this before touching `PropertyListingPage.js`)

Audited directly from `src/pages/PropertyListingPage.js` (Milestone 4):

| Filter/Input | Client-side or Amber-bound | Notes |
|---|---|---|
| `city` (URL `?city=`) | **Amber-bound** | The only input that changes the `/api/amber` request or its cache key. Triggers `getProperties(city)` in a `useEffect` keyed on `[city]` only. |
| `query` (free-text search box) | Client-side | Filters the already-fetched `listings` array in a `useMemo`. |
| `minPrice` / `maxPrice` | Client-side | Same `useMemo`, numeric comparison against already-fetched data. |
| `roomType` | Client-side | Filters against `l.rooms.types` from already-fetched data. |
| `billsOnly` | Client-side | Filters against `l.billsIncluded`. |
| `university` | Client-side | Filters against each listing's own `distances.nearby` data (already fetched). |
| `amenities` (multi-select) | Client-side | Filters against `l.amenities.all`. |
| `sortBy` (recommended/price/rating) | Client-side | Sorts the already-filtered array in-memory; no network involved. |

**No pagination UI exists** — `getProperties(city)` is always called with the
default `page=1, limit=50`, so there is currently no user-facing control that
could multiply Amber-bound cache keys per city.

**Verified**: the listings-load `useEffect`'s dependency array is `[city]`
only — changing any filter/sort state does **not** re-run `load()` or touch
`/api/amber` at all. There is currently zero "filter combination explosion"
risk (e.g. `London+filterA`, `London+filterB` each becoming separate Amber
requests) — all eight filter/sort inputs operate purely over data already in
memory.

**Recommendation for the future merge**: whichever new filter/search UI the
`main` branch introduces, keep every filter that doesn't need data Amber
doesn't already return (price, room type, bills, university, amenities, text
search, sort) **client-side**, exactly as today. Only a genuinely new
dimension — e.g., a *different* city, or pagination beyond the 50-item page —
should ever touch `/api/amber` again. If the merged UI adds pagination,
route it through `getProperties(city, page, limit, ...)`'s existing
parameters (the cache-key machinery already supports `page`/`limit`) rather
than inventing a new fetch path.

---

## Known Minor Findings (not fixed this milestone — documented for awareness)

- **Client-side city-key casing is not normalized.** `amberApi.js`'s
  `gatewayUrl`/`keyParamsFor` build the browser's L1 (memory + IndexedDB)
  cache key straight from whatever `city` string was passed in — unlike the
  server (`amberGateway.js`'s `normalizeCityName`: trim + lowercase +
  whitespace-collapse), which *does* normalize. A user who types "london"
  (lowercase, bypassing the autocomplete suggestion) versus one who arrives
  via a `DESTINATIONS`-driven "London" link would get two separate client
  cache entries for the same city. This does **not** cause duplicate Amber
  traffic (the server-side Redis cache key is correctly normalized either
  way, so the second request is still a cache `HIT`) — it only means a bit of
  redundant client-side storage/one extra `/api/amber` round-trip the first
  time each casing variant is seen. Low severity; not fixed here since it
  isn't small-and-obvious enough to patch blindly without deciding whether
  the client should always normalize display-vs-cache-key city strings.

---

## Post-Merge Verification Checklist

Run this after `main` is merged into `development`, before considering the
merge safe to deploy:

1. **Search for a direct Amber URL outside the gateway**: grep the whole repo for `base.amberstudent.com`, `amberstudent.com/api`, and the partner ID (`ivy-huts-707a5cdf`). The only matches should be `api/_lib/amberGateway.js`, `api/amber.js`, and the explanatory comment in `src/services/amberApi.js`.
2. **Verify `/api/amber` remains the sole frontend gateway** — no new `fetch()`/`axios` call anywhere in `src/` targets Amber directly.
3. **Verify filters don't explode Amber requests** — re-check any new/changed filter UI's data-loading `useEffect` dependency array; it should only include things that legitimately need a new `/api/amber` call (city, and if added, page).
4. **Verify SWR background refresh is still `"LOW"` priority** in `amberApi.js`'s `callGateway`.
5. **Verify the cron is still configured** — `vercel.json` still has the `crons` entry pointing at `/api/warm-amber-cache` with a schedule.
6. **Verify Redis environment variable names are unchanged** — `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` (and that `.env.example` still documents them as placeholders only).
7. **Run `CI=true npm run build`** (or the Windows-shell equivalent) and confirm it passes cleanly — this is what Vercel's own build enforces.
8. **Manually test**: Home page loads; Listings page loads for at least one city; every filter/sort control changes the visible list without a network request (check devtools); Property Detail page opens from a listing card; back-navigation returns to Listings without a new Amber fetch for data already seen; navigating to a *different*, previously-unvisited city does trigger exactly one new `/api/amber` request.
9. **Inspect Vercel's `/api/amber` function logs** for the test session — confirm `[GATEWAY]`, `[AMBER UPSTREAM]`, and `[AMBER] event=AMBER_SUCCESS|AMBER_TIMEOUT|AMBER_FAILED` lines are present and look sane (no unexpected `code=budget_exceeded`/`lock_busy` spam).
10. **Verify no lead/enquiry POST to Amber exists** — grep for `POST` alongside `amberstudent.com`; every `POST` in the codebase should target `REACT_APP_SHEETS_URL`, never Amber.