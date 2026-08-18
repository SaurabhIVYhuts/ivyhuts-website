# Accommodation provider orchestration (Milestone 23.3)

Backend-side counterpart to `ivyhuts-crm`'s `src/lib/property-intelligence/`
(Milestone 23.1) and the audit in that repo's Milestone 23.2 report. Powers
`GET /api/properties/search` — the Find Rooms search endpoint.

## Why all four providers are `NOT_CONFIGURED`

Milestone 23.2 audited UHomes, UniAcco, University Living, and Gradding
Homes and found **no verified public API for any of them** — only vague
partner/affiliate program mentions (UniAcco has a partner dashboard at
`partner.uniacco.com`; University Living has a "list your property" contact
page), reachable only through direct business contact, not documented
technical integration. Per that milestone's explicit instruction (and this
one's), no scraping, reverse engineering, or fabricated results were
implemented. Each adapter (`uhomes.js`, `uniacco.js`, `universityLiving.js`,
`graddingHomes.js`) is a thin `createNotConfiguredAdapter(...)` call
(`notImplemented.js`) that honestly returns `{status: "NOT_CONFIGURED",
properties: []}` — never a fake listing, never a silent `NO_RESULTS`.

## Amber is not, and must never become, a fifth entry here

Amber (`api/amber.js`, `api/_lib/amberGateway.js`) is separate, existing
IVYHUTS property infrastructure. `registry.js` and `search.js` both carry
explicit comments against adding it — see those files, and Milestone
23.2/23.3's own "Amber must not be a CRM provider" sections.

## What exists here today vs. what Milestone 23.4 adds

- `types.js` — shared constants + JSDoc shapes (`PROVIDERS`, `PROVIDER_STATUSES`, `CanonicalProperty`).
- `normalize.js` — pure normalization/identity functions, ported from the CRM's Milestone 23.1 TypeScript version. Not exercised by any real provider call yet (nothing to normalize until 23.4), but tested directly (`scripts/verify-property-search.js`) so the shape is correct ahead of time.
- `distance.js` — straight-line (Haversine) university-to-property distance, reusing `api/_lib/accommodationIndex.js`'s existing `haversineKm` rather than a third copy of the formula. Deliberately not walking/travel time — that needs a real routing provider, out of scope here.
- `notImplemented.js` + the four provider files — today's honest `NOT_CONFIGURED` stubs.
- `registry.js` — the exhaustive four-provider map, with a require-time self-check against `types.js`'s `PROVIDERS` list.
- `search.js` — `Promise.allSettled` orchestration: per-provider timeout, malformed/rejected results sanitized to `ERROR` rather than leaking through or silently becoming zero results, identity-only dedup, distance attached per result.

**Milestone 23.4** (real provider integration) is expected to replace each
`createNotConfiguredAdapter(...)` call with a real `search(criteria)`
implementation — once real provider/partner access exists — without
touching `registry.js`'s shape, `search.js`'s orchestration, or the
`GET /api/properties/search` contract at all.

## rentPerWeek

Added to `CanonicalProperty` per the Milestone 23.2 recommendation,
confirmed useful by real precedent: `AccommodationResidence.priceWeekly`
(`api/_lib/accommodationIndex.js`) already solves the exact same
cross-provider comparison problem for Amber data. Computed only when both
`rent` and `rentPeriod` are confidently known — never estimated from a
partial/unknown period.
