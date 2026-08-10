# IvyHuts Customer & Marketing Data Architecture

Status: **Milestone 1 — schema/architecture only.** No CRUD APIs, no dashboard,
no frontend UI, no data migration. See the Milestone 1 final report (chat)
for the full A–U writeup; this document is the durable reference for the
schema decisions, migration mappings, and open questions referenced there.

**Milestone 1B** added `User.accommodationJourney` (post-lead lifecycle
tracking through booking/move-in/stay/move-out) — still schema-only, no new
APIs. See the `accommodationJourney` subsection under §4 User.

## 1. Why this exists

The business needs to understand the full customer journey — not just "a
lead came in." A person can browse anonymously, search, filter, view and
wishlist properties, then create an account, submit an enquiry, and be
followed up on before converting. Modeling this as a single "leads table"
loses that journey. Instead:

| Concept | What it represents |
|---|---|
| **User** | Central identity — the person, not a login record |
| **Event** | Behavioural history — what they did, and when |
| **Lead** | Business qualification/pipeline state — an opportunity |
| **Enquiry** | A specific expression of interest |
| **Wishlist** | Property intent |
| **Communication** | Interaction history (what was said, on which channel) |
| **Follow-up** | A sales action still to be taken |

## 2. Storage split

```
                 MongoDB (permanent, source of truth)
                    │
       ┌────────────┼────────────┬──────────────┬───────────────┐
       │            │            │              │               │
      User         Lead      UserEvent       Enquiry      Communication /
       │            │                                        FollowUp
       │        Enquiries
       │        Wishlist
       └────────────┘

                 Redis (Upstash — temporary/coordination state only)
                    │
       ┌────────────┼────────────┐
       │            │            │
    Sessions    Rate limits   Amber cache/lock/budget
```

Redis keeps doing exactly what it already does (Amber cache/lock/budget,
plus the auth sessions and rate limiting added in the previous milestone).
MongoDB is new, and owns permanent customer/business data exclusively —
neither store duplicates the other's job.

## 3. Mongoose vs. native driver

No MongoDB library existed in the repo before this milestone. **Mongoose**
was chosen over the native driver because this data model has real
structure worth enforcing at the schema level from day one: required
fields, enums (lead status/temperature, communication channel/direction,
follow-up status), a uniqueness constraint (Wishlist per user), and
references between seven collections that will only grow more
interconnected as the Lead/Communication/FollowUp APIs are built in later
milestones. That's exactly Mongoose's value proposition (schemas,
validation, indexes-as-code, `populate()` for references) versus hand-rolled
validation on every native-driver call site. No other new dependency was
introduced beyond `mongoose` itself.

## 4. Models

All in `api/_lib/models/`. Each file's own header comment documents its
specific design reasoning; this is a consolidated summary.

### User (`User.js`)
The person/customer. **Intentionally holds no password, no session state.**
See §8 for exactly why and what migrates here later.

```
User
├── email (required, unique, lowercase)
├── name (required)
├── phone
├── auth: { emailVerified, createdAt, lastLoginAt }
├── profile: { country, city, preferredCountries[], preferredCities[], otherPreferences }
├── marketing: { source, medium, campaign, subscribed, consent, consentAt }
├── lead: { status, score, assignedTo, temperature }   ← denormalized snapshot, not authoritative
├── accommodationJourney: { status, servicePurchased, purchasedAt, moveInDate,
│                           expectedStayDurationMonths, expectedMoveOutDate,
│                           actualMoveInDate, actualMoveOutDate }
├── university: { name, city, country }   ← all optional, see below
├── createdAt / updatedAt
```

#### `university` (added in this milestone)

Fully **optional** — a User document with no `university` at all, or with
only some of the three sub-fields set, is valid. Captures where a
prospective tenant studies, distinct from `profile.country`/`profile.city`
(which describe the user's current/preferred location, not their
institution).

```
university
├── name (String, trim)
├── city (String, trim)
└── country (String, trim)
```

No index is added in this milestone — filtering "customers by university"
is a future CRM milestone's concern, and adding an unused index now would
just cost write performance ahead of any query that needs it (same
reasoning as the deliberately-unindexed free-text fields in §6). Not wired
to any API, form, or frontend UI yet — this is schema-only, matching how
`accommodationJourney` was introduced in Milestone 1B.

#### `accommodationJourney` (added in Milestone 1B)

A **marketing/customer-lifecycle field, not an Amber field** — nothing here
is populated from or synced to Amber, and it carries no dependency on Amber
being reachable. It exists alongside `lead` but answers a different
question: `lead` is pre-conversion sales qualification (is this person
worth pursuing); `accommodationJourney` is the full lifecycle including
everything *after* a booking exists, which `lead` has no fields for at all.

```
accommodationJourney
├── status: LEAD | ENQUIRY | BOOKING_IN_PROGRESS | BOOKED |
│           STAY_IN_PROGRESS | MOVED_IN | STAY_COMPLETED | CANCELLED
│           (default "LEAD", indexed)
├── servicePurchased (Boolean, default false)
├── purchasedAt
├── moveInDate                    ← planned, set at booking time
├── expectedStayDurationMonths    (Number, min 0)
├── expectedMoveOutDate           ← planned, derived from the above at booking time
├── actualMoveInDate              ← filled in once the stay actually starts
└── actualMoveOutDate             ← filled in once the stay actually ends
```

Intended marketing use — none of the following is implemented yet, this
milestone only adds the fields that make it possible later:

- **Segment by purchase**: `servicePurchased = true` and `purchasedAt`
  within a date range → post-purchase nurture campaigns, or
  `servicePurchased = false` with an old `updatedAt` → re-engagement
  campaigns for stalled leads.
- **Segment by upcoming move-in**: `moveInDate` within the next N days and
  `status != MOVED_IN` → pre-arrival communication (move-in guides,
  welcome messages).
- **Segment by actual vs. expected**: comparing `actualMoveInDate` to
  `moveInDate`, or `actualMoveOutDate` to `expectedMoveOutDate` → detecting
  early departures or delayed arrivals worth a check-in.
- **Segment by stay length**: `expectedStayDurationMonths` → distinguishing
  short-stay from long-stay customers for different marketing treatment.
- **Segment by lifecycle stage**: `status` directly, e.g. everyone currently
  `STAY_IN_PROGRESS` → mid-stay satisfaction surveys; everyone
  `STAY_COMPLETED` → alumni/referral campaigns.

`status` is indexed (matching the existing `lead.status` index pattern) for
exactly this kind of dashboard/segment filtering — "show me everyone
currently BOOKED" is expected to be a common query once a dashboard exists.
No transition logic (e.g. auto-advancing `ENQUIRY` → `BOOKING_IN_PROGRESS`)
is implemented in this milestone; `status` is a plain field to be set by
whatever future API/admin action represents each transition.

### Lead (`Lead.js`)
The business opportunity — separate from User because a lead doesn't
require an account (`userId` is nullable) and because pipeline state has
its own lifecycle independent of the person's profile.

```
Lead
├── userId (nullable, ref User)
├── status: new | contacted | qualified | converted | lost
├── temperature: cold | warm | hot
├── score, source, sourceDetails, assignedTo
├── firstContactAt, lastContactAt, convertedAt, lostAt, lostReason
├── tags[], notes
├── createdAt / updatedAt
```

### Wishlist (`Wishlist.js`)
One document per user (unique index on `userId`), holding an `items[]`
array — bounded by nature (nobody saves thousands of properties), unlike
UserEvent below. `propertyId` is Amber's own `id` field (already the
stable identifier used as the React list key throughout the frontend —
see `src/services/amberMapper.js`). `city`/`propertyName` are point-in-time
snapshots for marketing display only; Wishlist never calls Amber and stays
fully readable even if Amber is down.

```
Wishlist
├── userId (required, unique)
├── items[]: { propertyId, city, propertyName, addedAt }
├── createdAt / updatedAt
```

### UserEvent (`UserEvent.js`)
Behavioural history — its own top-level collection, **never** embedded on
User, because event volume per user is unbounded over a long relationship
and MongoDB documents have a 16MB hard limit. Supports both `userId` and
`anonymousId` since a visitor can generate events before signing up;
associating that pre-signup history with a later account ("identity
stitching") is explicitly out of scope for this milestone.

```
UserEvent
├── userId (nullable), anonymousId (nullable)
├── event (required, e.g. PROPERTY_VIEWED)
├── properties (event-specific payload)
├── metadata (request context)
├── timestamp (required), createdAt
```

### Enquiry (`Enquiry.js`)
A specific expression of interest — distinct from Lead (which accumulates
multiple Enquiries over time). Doesn't require an account; never calls
Amber to validate `property.id` (stored as an opaque snapshot, exactly like
the current `api/enquire.js` flow already does).

```
Enquiry
├── userId (nullable), leadId (nullable)
├── property: { id, name, city }  ← snapshot, not authoritative
├── message
├── contact: { name (required), email (required), phone }
├── status: new | contacted | in_progress | resolved | converted | closed
├── source
├── createdAt / updatedAt
```

### Communication (`Communication.js`)
Interaction history. Schema only — no provider (Resend/WhatsApp/etc.)
integration in this milestone.

```
Communication
├── userId (nullable), leadId (nullable)
├── channel: email | whatsapp | phone | sms | system (required)
├── direction: inbound | outbound (required)
├── type (free-form: follow_up, enquiry_response, marketing, general)
├── content, status, agentId, metadata
├── createdAt / updatedAt
```

### FollowUp (`FollowUp.js`)
A sales action still to be taken (not a record of something that already
happened — that's Communication).

```
FollowUp
├── userId (nullable), leadId (nullable), assignedTo
├── type: call | email | whatsapp | meeting | other (required)
├── priority: low | medium | high
├── dueAt (required)
├── status: pending | completed | cancelled
├── notes, completedAt
├── createdAt / updatedAt
```

### Segment (`Segment.js`) — created, with justification
Included in this milestone because it can be done cleanly and safely: it
stores a segment **definition** as structured data (`field` / `operator` /
`value` conditions, combined with AND/OR), never as executable code. There
is no `eval`, no stored function body, and no code-string field anywhere in
the schema — `operator` is a closed enum (`eq/ne/gt/gte/lt/lte/in/nin/exists`).
**No query engine/evaluator is implemented** — that's explicitly deferred to
a future milestone, which will need to write the code that turns a stored
`rules` document into an actual MongoDB query. This milestone only
establishes a safe place to store what a segment *means*.

```
Segment
├── name (required, unique)
├── description
├── rules: { operator: AND|OR, conditions: [{ field, operator, value }] }
├── isActive
├── createdAt / updatedAt
```

## 5. Relationships

```
User ──┬── Lead (0..n)
       ├── Wishlist (0..1, unique)
       ├── UserEvent (0..n, by userId or anonymousId)
       ├── Enquiry (0..n)
       ├── Communication (0..n)
       └── FollowUp (0..n)

Lead ──┬── Enquiry (0..n)
       ├── Communication (0..n)
       └── FollowUp (0..n)
```

References only (`Schema.Types.ObjectId` + `ref`) — never unbounded
embedded arrays on User (`User.events[]`, `User.communications[]`,
`User.enquiries[]` do not exist; verified structurally by
`scripts/verify-mongodb-models.js`).

## 6. Indexes

Every index below is declared for a specific, named query pattern — not
"just in case." Full reasoning also lives as inline comments next to each
`.index()` call in the model files.

| Model | Index | Query pattern it serves |
|---|---|---|
| User | `email` (unique) | Login lookup / signup dedupe |
| User | `createdAt` | "New users in date range" reporting |
| User | `marketing.source` | "Users acquired via campaign X" |
| User | `lead.status` | Dashboard filtering by pipeline stage |
| User | `lead.score` | Sorting by lead priority |
| User | `accommodationJourney.status` | Lifecycle-stage segmentation/dashboard filtering (e.g. "everyone currently BOOKED") |
| Lead | `userId` | "All leads for this user" |
| Lead | `status` | Pipeline board filtering |
| Lead | `assignedTo` | "My assigned leads" (per agent) |
| Lead | `score` | Priority sorting |
| Lead | `createdAt` | New-leads-over-time reporting |
| Lead | `source` | "Which channel generates the most leads" |
| Wishlist | `userId` (unique) | One doc per user; also the sole read pattern (load a user's wishlist) |
| UserEvent | `userId + timestamp` | A user's activity timeline |
| UserEvent | `anonymousId + timestamp` | Same, pre-signup |
| UserEvent | `event + timestamp` | Funnel analysis ("all PROPERTY_VIEWED this week") |
| UserEvent | `timestamp` | Time-range exports / future retention job |
| Enquiry | `userId` | "All enquiries by this user" |
| Enquiry | `leadId` | "All enquiries tied to this Lead" |
| Enquiry | `property.id` | "How much interest has this property gotten" |
| Enquiry | `status` | Admin queue filtering |
| Enquiry | `createdAt` | New-enquiries-over-time reporting |
| Communication | `userId + createdAt` | Customer communication history, chronological |
| Communication | `leadId + createdAt` | Same, scoped to an opportunity |
| Communication | `agentId + createdAt` | "Everything this agent sent" |
| FollowUp | `userId`, `leadId` | Reverse lookups |
| FollowUp | `assignedTo + dueAt` | An agent's task list — the primary read this model exists for |
| FollowUp | `status + dueAt` | "Overdue pending follow-ups" ops view |

Deliberately **not** indexed: free-text fields (`notes`, `content`,
`message`) — no text-search feature exists yet, and an unused index only
costs write performance. Add one when a search feature actually needs it.

Indexes above are verified as *declared* by `scripts/verify-mongodb-models.js`
in both modes; whether they're actually *built* in a real database can only
be confirmed once `MONGODB_URI` points at a live instance (see the test
results in the Milestone 1 report).

## 7. Event retention (UserEvent growth)

`UserEvent` will be the largest collection by far — every page view,
search, filter, and wishlist toggle is a document. **No TTL index is added
in this milestone.** Reasoning:

- A TTL index unconditionally deletes documents past an age threshold.
  Nothing in this milestone's scope (no dashboard, no segmentation engine)
  yet uses UserEvent, so there's no way to know what retention window the
  business actually needs — 30 days is enough for session replay, but a
  "this user viewed 3 London properties over the last 6 months" segment
  needs much longer.
- Deleting events is not easily reversible; adding a TTL index later is.
  Getting this wrong in the direction of "add it now" risks silently
  destroying data a future segmentation/analytics milestone needs.
- The `timestamp` index already in place supports whatever the eventual
  policy turns out to be — a scheduled archival job (cold storage export
  before deletion) or a rolling aggregation (collapse raw events into daily
  rollups after N days) are both viable and can be decided once real event
  volume and actual dashboard/segment requirements exist.

Recommendation for a later milestone: decide retention only once the
segmentation engine's actual query needs are known, and prefer archival
(export + delete) over pure TTL deletion for anything that might feed a
future LTV/attribution analysis.

## 8. Privacy & security considerations

- **No plaintext passwords, session IDs, or auth secrets in MongoDB** —
  confirmed structurally: `User.password`, `User.passwordHash`,
  `User.sessionId` do not exist as schema paths (verified by
  `scripts/verify-mongodb-models.js`).
- **PII fields to be careful with in logs**: `User.email`/`phone`,
  `Enquiry.contact.*`, `Communication.content` (this will often hold real
  message text once a provider is wired up). None of the new files in this
  milestone log any document contents — `api/_lib/mongodb.js` only logs
  connection lifecycle events ("Connecting...", "Connected.", and error
  *messages*, never the URI, which embeds credentials).
- **`otherPreferences`, `metadata`, `properties` are `Schema.Types.Mixed`**
  (arbitrary structured data) by design, for flexibility — but that also
  means nothing stops a future caller from putting sensitive data in there
  without realizing it. Worth a lint/review step once real endpoints write
  to these fields.
- **Segment rules are data, never code** (§4) — the model itself cannot
  become an injection/RCE vector no matter what a future admin UI lets
  someone type into a segment builder.
- **Consent**: `User.marketing.consent`/`consentAt` exist so that future
  marketing-communication features have a place to check/record consent
  before this milestone's schema needs revisiting — not wired to anything
  yet.

## 9. Google Sheets → MongoDB migration mapping

**Nothing is migrated in this milestone.** This is documentation only, so a
future milestone can implement the actual write path with a clear map to
follow. Traced from the live source (`src/pages/AccommodationFinderPage.js`,
`ContactPage.js`, `PartnerPage.js`, `ListYourStayPage.js`, `api/enquire.js`)
— see §9.1 for what's still unresolved.

### Lead sources (which pages generate leads today)

| Page | Sheet `_page` tag | Purpose |
|---|---|---|
| `AccommodationFinderPage.js` (`/find-rooms`) | `"Find Rooms"` | Room search enquiry |
| `ContactPage.js` (`/contact`, `/enquire`) | `"Contact Us"` | General or property-specific enquiry |
| `PartnerPage.js` (`/partner`) | `"Partner with Us"` | B2B partnership lead |
| `ListYourStayPage.js` (`/list-your-stay`) | `"List Your Stay"` | Property owner lead |

Every one of these currently double-writes: a client-side `fetch` straight
to `REACT_APP_SHEETS_URL` (a Google Apps Script Web App), and a separate
`fetch("/api/enquire")` that only sends an email via Resend — the two
payloads are shaped differently and neither currently touches MongoDB.

### Field mapping

**Find Rooms** (`AccommodationFinderPage.js`):

| Current Sheet field | → | MongoDB |
|---|---|---|
| `Full Name` | → | `User.name` / `Enquiry.contact.name` |
| `Email` | → | `User.email` / `Enquiry.contact.email` |
| `Phone` | → | `User.phone` / `Enquiry.contact.phone` |
| `University` | → | `User.university.name` (optional; `University` sheet field has no city/country split today, so `university.city`/`university.country` stay unset until a future form captures them) |
| `Countries` | → | `User.profile.preferredCountries[]` |
| `Room Type` | → | *no field yet* — candidate: `Enquiry` needs a `preferences` sub-object (not in this milestone's scope) |
| `Budget` | → | same — no field yet |
| `Intake` | → | same — no field yet |
| `Duration` | → | same — no field yet |
| `Bills Included` | → | same — no field yet |
| `Other Notes` | → | `Enquiry.message` |
| (implicit: form submission itself) | → | `UserEvent { event: "ENQUIRY_SUBMITTED" }` |

**Contact Us** (`ContactPage.js`):

| Current Sheet field | → | MongoDB |
|---|---|---|
| `Full Name` / `Email` / `Phone` | → | `Enquiry.contact.{name,email,phone}` |
| `Subject` | → | folded into `Enquiry.message` (current `api/enquire.js` behavior already does this) |
| `Message` | → | `Enquiry.message` |
| `Property Inventory ID` | → | `Enquiry.property.id` |
| `Property Name` | → | `Enquiry.property.name` |
| `Room ID` / `Room Name` | → | *no field yet* — candidate: extend `Enquiry.property` with `roomId`/`roomName` |
| `Tenancy ID` / `Duration` / `Move In` / `Move Out` / `Weekly Price` | → | *no field yet* — candidate: `Enquiry.tenancyDetails` (Mixed) if this level of detail is still wanted once MongoDB is live |

**List Your Stay** / **Partner with Us**: these are supply-side (property
owners / B2B partners), not demand-side customers — they map conceptually
to `Lead` with `source: "list-your-stay"` / `"partner"`, but **not** to
`User`/`Enquiry` as currently modeled (those assume a prospective tenant).
Flagging this as an open modeling question rather than guessing: a future
milestone should decide whether property owners get their own lightweight
model or are folded into `Lead.sourceDetails` as free-form data.

### 9.1 What has no MongoDB equivalent yet

- Room preference details (room type, budget, intake, duration, bills) —
  no schema field anywhere yet. Not added speculatively in this milestone
  (matches the "don't design for hypothetical requirements" principle) —
  flagging for whoever builds the Enquiry-creation API to decide where
  these actually belong.
- Tenancy-specific fields from the property-enquiry variant of Contact Us
  (`Tenancy ID`, move in/out dates, weekly price) — same story.
- Supply-side (List Your Stay / Partner) submissions don't cleanly fit the
  demand-side User/Enquiry model as designed — see above.

### What becomes an Event (not stored elsewhere)

The act of viewing/searching/filtering itself (currently invisible to both
Sheets and email) has no Sheets equivalent at all — this is net-new
tracking that `UserEvent` is specifically for for (`PAGE_VIEWED`,
`SEARCH_PERFORMED`, `PROPERTY_VIEWED`, etc.), not a migration of existing
data.

## 10. Redis User → MongoDB migration plan

**No migration happens in this milestone.** Current state, inspected
directly from `api/_lib/userStore.js`, `session.js`, `auth.js`, and
`api/auth/*`:

- `user:{userId}` in Redis holds `{ id, email, passwordHash, name, phone,
  createdAt, lastLogin }` — permanent (no TTL).
- `email:{normalizedEmail}` in Redis holds `userId` — the atomic
  uniqueness reservation (`sharedSetNX`), permanent (no TTL).
- `session:{sessionId}` in Redis holds `{ userId, createdAt }` — TTL'd
  (`AUTH_SESSION_TTL_SECONDS`).
- Password hashing (bcryptjs) and all auth business logic live in
  `userStore.js`/`login.js`/`signup.js`.

### Target split (this is *why* the MongoDB User model has no password field)

| Data | Stays in Redis | Moves to MongoDB |
|---|---|---|
| `passwordHash` | ✅ (or a dedicated `Credential` collection later — TBD in the migration milestone) | ❌ never |
| `session:{sessionId}` → `userId` | ✅ always | ❌ never |
| `email`, `name`, `phone`, `createdAt`, `lastLogin` | migrates | ✅ becomes `User.email/name/phone/auth.createdAt/auth.lastLoginAt` |
| Marketing/lead/profile fields | didn't exist in Redis | ✅ new, MongoDB-only |

### Migration approach (for the future milestone that does this)

1. **Dual-write period**: `api/auth/signup.js` and `login.js` start also
   writing/updating the corresponding MongoDB `User` document (keyed by the
   same normalized email) alongside the existing Redis writes — Redis
   remains authoritative for auth (password + session) throughout.
2. **Backfill**: a one-off script iterates existing `user:*` Redis keys and
   creates the matching MongoDB `User` documents for accounts that predate
   the dual-write period.
3. **Identity linkage**: MongoDB `User._id` becomes the value referenced by
   `Lead.userId`, `Enquiry.userId`, etc. Until this migration happens,
   nothing in this milestone can actually set those fields for a real
   registered user — they stay `null`, same as an anonymous visitor, which
   is schema-valid today (see `verify-mongodb-models.js`).
4. **Never**: passwordHash and session data are not planned to move to
   MongoDB — Redis remains correct for both (fast, TTL-native for
   sessions, and keeping the credential store separate from the
   business-data store is a reasonable security boundary to keep
   regardless of migration).
5. Redis user records are **not deleted** as part of this future migration
   — they stay authoritative for auth indefinitely, per the explicit
   instruction for this milestone and the likely shape of the next one.

## 11. Amber isolation

Verified by grep across every file this milestone touched: zero references
to `base.amberstudent.com` or `/api/amber`. No MongoDB model or connection
file imports `amberGateway.js`/`sharedStore.js`/`cacheWarmer.js`, and no
Redis key added or read by anything in this milestone uses the `amber:*`
prefix. `api/_lib/amberGateway.js`, `api/_lib/sharedStore.js`,
`api/_lib/cacheWarmer.js`, `api/warm-amber-cache.js`, `api/amber.js`, and
`src/services/amberApi.js` were not modified.

## 12. Milestone 2 — Business API architecture

Status: implemented and live-verified (`scripts/verify-business-api.js`,
45/45 passing against the real test database). The public website's React
UI is unchanged — these are backend-only foundations for the future
marketing dashboard.

```
IvyHuts Website / future Dashboard
              │
              ▼
      Our Backend API  (api/customers/*, api/leads/*, api/enquiries/*)
              │
    ┌─────────┴─────────┐
    ▼                   ▼
 MongoDB              Redis
 (business data,    (sessions, auth
  via Mongoose        rate limits —
  models)             untouched)
```

Neither the dashboard (not built yet) nor the public site talks to MongoDB
directly — everything routes through these API endpoints, which enforce
authorization before any query runs.

### 12.1 The identity gap this milestone had to close

Redis (auth) and MongoDB (business data) are two separate stores with two
separate id spaces, and the formal migration between them (§10 above) is
still a future milestone. But Customer/Lead/Enquiry APIs need a real
MongoDB `User._id` to attach records to *now*. `api/_lib/businessAuth.js`
bridges this with `resolveMongoUser(redisUser)`: look up a MongoDB `User`
by the same normalized email Redis already uses, and lazily create one if
none exists. This is additive only — it never reads or writes Redis
credential/session data, and is fully compatible with the real migration
happening properly later (effectively the "dual-write on read" half of the
plan in §10, scoped to what this milestone needs).

### 12.2 Role model

`User.role` (MongoDB, new in this milestone) — **not** Redis — since role
is business authorization data, not an auth/session concern:

```
USER              — default; every signed-up visitor
MARKETING_AGENT    ┐
MARKETING_MANAGER  ├─ "internal roles" — can read/manage business data
ADMIN               ┘  (ADMIN additionally required to change a role)
```

`api/_lib/businessAuth.js` exposes:
- `requireCustomerIdentity(req, res)` — 401 if not logged in (via the
  existing Redis session, never a client-supplied id); returns `{redisUser,
  mongoUser}`.
- `requireRole(req, res, allowedRoles)` — same, plus 403 if `mongoUser.role`
  isn't in `allowedRoles`.
- `getOptionalMongoUserId(req)` — for endpoints where anonymous access is
  valid (lead/enquiry creation): resolves the logged-in visitor's Mongo id
  if present, or `null` — never writes an error response, since anonymous
  is a normal outcome here, not a failure.

No endpoint ever trusts a client-supplied `userId` for identity — every
handler below derives it from the session via one of the functions above.

### 12.3 API endpoints

| Method | Path | Access | Notes |
|---|---|---|---|
| GET | `/api/customers` | internal roles | search, status, source, city, createdFrom/To, pagination |
| POST | `/api/customers` | internal roles | staff-created/imported customer record |
| GET | `/api/customers/me` | any logged-in user | own profile only (see §12.4) |
| GET | `/api/customers/:id` | internal roles | Customer 360 (see §12.5) |
| PATCH | `/api/customers/:id` | internal roles | name/phone/profile/marketing; `role` requires ADMIN |
| PATCH | `/api/customers/:id/lifecycle` | internal roles (USER: none yet, see §12.6) | `accommodationJourney.*` |
| GET | `/api/leads` | internal roles | status/source/assignedTo/userId/city/score range/search/pagination |
| POST | `/api/leads` | public | anonymous or authenticated; see §12.7 |
| GET | `/api/leads/:id` | internal roles | + bounded recent enquiries/follow-ups/communications |
| PATCH | `/api/leads/:id` | internal roles | business fields only, explicit whitelist |
| DELETE | `/api/leads/:id` | MARKETING_MANAGER, ADMIN | soft delete (`archivedAt`), see §12.8 |
| PATCH | `/api/leads/:id/assignment` | internal roles | target must hold an internal role |
| GET | `/api/enquiries` | internal roles | status/source/userId/leadId/city/search/pagination |
| POST | `/api/enquiries` | public | anonymous or authenticated; auto-links a Lead, see §12.9 |
| GET | `/api/enquiries/:id` | internal roles | |
| PATCH | `/api/enquiries/:id` | internal roles | status, leadId only |

Response shape is uniform across all of these (`api/_lib/apiResponse.js`):
`{success, data}`, `{success, data, pagination}` for collections, or
`{success: false, error: {code, message}}` — deliberately a different
shape from the pre-existing `{ok, ...}` used by `api/enquire.js`/
`api/auth/*`, which predate this convention and are out of scope to
retrofit here. Every handler is wrapped in `withErrorHandling`
(`api/_lib/validation.js`), so Mongo validation errors, bad ObjectIds,
duplicate keys, and anything unexpected all become safe, consistent JSON —
never a stack trace, connection string, or raw driver error.

Filtering is a hard **explicit whitelist** per endpoint — no query
parameter is ever passed through to Mongoose unfiltered, and free-text
search is regex-escaped before use (`escapeRegex` in `validation.js`) to
prevent both incorrect matches and ReDoS. Pagination defaults to 25,
capped at 100, oversized requests are clamped rather than rejected.

### 12.4 `/api/customers/me` vs. the existing `/api/auth/me`

Deliberately not merged: `auth/me` answers "who is logged in" from Redis
(id/name/email/phone only — no MongoDB fields exist there). `customers/me`
answers "what's their business profile" from MongoDB (lifecycle, marketing
source, role, etc.) — a different data source for a different question,
not duplicated logic.

### 12.5 Customer 360 (`GET /api/customers/:id`)

Three small, targeted, indexed queries — never `populate()` on an unbounded
collection: `Wishlist.findOne({userId})` (item count only),
`Lead.find({userId}).limit(10)`, `Enquiry.find({userId}).limit(10)`, all
alongside the profile fields already on the User document. No N+1 — this
is a fixed number of queries regardless of how much history a customer has.

### 12.6 Lifecycle updates and self-service

`SELF_SERVICE_FIELDS` in `api/customers/[id]/lifecycle.js` is currently
**empty** — every `accommodationJourney` field is business-managed only,
even for a USER updating their own record. None of these fields (status,
purchase, move-in/out dates) have an established self-service flow yet
(that requires an actual booking system, explicitly out of scope for this
milestone) — rather than guess at a policy the business hasn't defined,
every field stays gated until one exists. Extending self-service later is
a one-line whitelist change, not a rewrite.

### 12.7 Lead creation and identity

`POST /api/leads` is public. Identity resolution order: session-derived
`userId` by default; an explicit `userId` in the request body is honored
**only** when the caller holds an internal role (the staff-import case)
and the target id is validated to exist — otherwise it's silently ignored
in favor of session identity (or `null`). A lead needs either a resolved
`userId` or a `contact.email` — enforced at the API layer, not the schema
(so a staff-created lead tied to an existing user doesn't need contact
duplicated).

**Schema gap found and fixed**: the Milestone 1 `Lead` model had no
contact/property fields at all, which would have made an anonymous lead
unreachable. Milestone 2 added `Lead.contact {name, email, phone}` and
`Lead.property {id, name, city}` (mirroring `Enquiry`'s existing shape) —
the smallest change that makes anonymous leads actually usable. `Lead`'s
"intent" field mentioned in the spec was **not** added, since it wasn't
already represented anywhere in the model and the spec's own phrasing
("if already represented") doesn't call for inventing it.

### 12.8 Lead deletion is a soft delete

The Milestone 1 `Lead` model had no `deletedAt`/archive/audit fields.
Rather than an irreversible hard delete, Milestone 2 added `Lead.archivedAt`
(mirrors the existing `lostAt`/`convertedAt` pattern) — `DELETE
/api/leads/:id` sets it rather than removing the document, restricted to
MARKETING_MANAGER/ADMIN. List queries exclude archived leads by default;
`?includeArchived=true` includes them. Marketing data doesn't disappear
accidentally in either direction.

### 12.9 Enquiry → Lead linking

`POST /api/enquiries` implements "create or associate a Lead if
appropriate" as one explicit rule (`api/_lib/leadLinking.js`, no
scoring/automation engine): reuse the caller's existing **open**
(non-converted, non-lost, non-archived) Lead if one exists — matched by
`userId` if authenticated, else by `contact.email` — otherwise create a new
one. A fully anonymous enquiry with no email gets its own fresh Lead every
time (no reliable dedupe key). Live-verified: two enquiries from the same
email reuse the same `leadId`.

### 12.10 Activity events

Three events are recorded via the existing `UserEvent` model (best-effort,
never fails the parent request) rather than a new activity collection:
`LEAD_CREATED`, `LEAD_STATUS_CHANGED`, `LEAD_ASSIGNED`, and
`ACCOMMODATION_JOURNEY_STATUS_CHANGED`. This is not the event-tracking
system itself (a future milestone) — just reuse of the existing model for
the handful of events this milestone's own actions naturally produce.

### 12.11 Rate limiting

Mutating business endpoints (POST/PATCH/DELETE) go through
`checkBusinessWriteRateLimit` (`api/_lib/businessRateLimit.js`), reusing
`sharedStore.js`'s generalized `reserveSlot()` atomic primitive under
`api:business:write:ip:*` keys — completely separate from Amber's
`amber:requests` budget and auth's `auth:*` keys. Default: 60 requests per
IP per 15 minutes, configurable via `API_BUSINESS_RATE_LIMIT`.

### 12.12 Google Sheets coexistence

Unchanged and untouched this milestone. `api/enquire.js` (email via
Resend) and the client-side `fetch(REACT_APP_SHEETS_URL, ...)` calls in
the enquiry-form pages continue to run exactly as before — `POST
/api/enquiries` is an **additional**, independent write to MongoDB, not a
replacement, and the two pipelines don't call each other. The frontend
forms were not modified to call the new endpoint (frontend changes are out
of scope for this milestone) — wiring them together is a Google Sheets
migration milestone's job.

### 12.13 Milestone 3 — Production Enquiry Data Capture

Status: implemented (`scripts/verify-enquiry-capture.js`; static checks
8/8 passing — live MongoDB checks blocked in this session by Atlas network
access from the dev machine, see the script's own header and the Milestone
3 final report for details). Wires two of the four demand/supply-side forms
traced in §9 into `POST /api/enquiries` as an **additional**, non-blocking
destination — the Sheets/email flow described in §9/§12.12 is unchanged and
still the primary, user-facing submission path.

```
                         ┌──→ Existing Google Sheets (unchanged)
                         │
User → Enquiry Form ─────┼──→ Existing api/enquire.js email notify (unchanged)
                         │
                         └──→ POST /api/enquiries (new, fire-and-forget)
                                      ↓
                                   MongoDB
                                      ↓
                              User / Lead / Enquiry
```

**Wired**: `AccommodationFinderPage.js` (`source: "find-rooms"`) and
`ContactPage.js` (`source: "contact"`) — both call the new
`src/lib/enquiryApi.js#submitEnquiryToMongo` helper right after their
existing `fetch("/api/enquire")` call, in the exact same
fire-and-forget/never-awaited style. Fields with no MongoDB schema
equivalent (room type, budget, intake, duration, bills-included for Find
Rooms; room/tenancy detail for Contact) are folded into `Enquiry.message`
as readable text — same resolution §9.1 already flagged, and the same
pattern `ListYourStayPage.js`/`ContactPage.js` already use for their own
`api/enquire.js` payloads. No schema field was added.

**Not wired**: `PartnerPage.js` and `ListYourStayPage.js` remain exactly as
described in §9 — supply-side/business submissions that don't cleanly fit
the demand-side `User`/`Enquiry` model. Left unchanged this milestone too,
per explicit instruction; still an open modeling question for later.

**Identity**: unchanged from §12.1/§12.9 — the frontend never sends a
`userId`; `getOptionalMongoUserId` derives it from the session cookie
(sent automatically on this same-origin fetch) or resolves `null` for an
anonymous visitor. Lead reuse (§12.9) and the `ENQUIRY_SUBMITTED` event
(§12.10) fire exactly as before — no changes were made to
`leadLinking.js`, `events.js`, or `api/enquiries/index.js` itself.

**Failure strategy**: `submitEnquiryToMongo` is called without `await`,
wrapped in its own try/catch and `.then/.catch` chain, and is fired *after*
the Sheets and `api/enquire` calls — so a MongoDB outage/timeout can never
delay, duplicate, or fail the pre-existing Sheets/email submission, and the
success screen is reached unconditionally regardless of this call's
outcome. Failures are logged client-side via `console.error` with only the
server's own safe error message (never request/response bodies containing
PII, and never password/session data — none of which this endpoint ever
handles in the first place).

**Duplicate-submission protection**: relies entirely on the *existing*
per-form safeguards already in place before this milestone — honeypot
field, 60-second module-level cooldown, and `disabled={status ===
"sending"}` on the submit button (set synchronously before any fetch
fires) — no new idempotency mechanism was added. Each real form submission
event triggers exactly one call to each of the three destinations. Multiple
real submissions from the same person still correctly produce multiple
`Enquiry` documents (each one a distinct expression of interest) while
reusing the same open `Lead` via the existing §12.9 rule — this is
intended behavior, not a duplicate-prevention gap.

### 12.14 Local development

`scripts/local-api-server.js` gained a small path-matching router
(`businessRoutes`) mirroring Vercel's filesystem-based dynamic routing
(`api/leads/[id].js` → `/api/leads/:id`), since the plain Node dev server
has no framework to do that automatically — same precedence rules Vercel
itself applies (static routes like `/api/customers/me` are matched before
the more general `/api/customers/:id`). Milestone 4's `/api/wishlist`,
`/api/wishlist/:propertyId`, and `/api/events` routes were added to the
same router table.

## 13. Milestone 4 — Wishlist & Behavioral Intelligence

Status: implemented and live-verified (`scripts/verify-wishlist-behavior.js`,
30/30 passing against the real test database).

```
React Frontend
      │
      ├──→ POST/GET /api/wishlist, GET/DELETE /api/wishlist/:propertyId
      │            └──→ MongoDB (Wishlist)
      │
      └──→ POST /api/events (PROPERTY_VIEWED, CITY_SEARCHED)
                   └──→ MongoDB (UserEvent, via the existing events.js)

Amber: untouched. Neither wishlist nor event-tracking code imports
amberGateway.js/amberApi.js/sharedStore.js's Amber keys, or calls
/api/amber. A wishlist add stores the property snapshot the frontend
already has in hand — it never re-fetches the property to build it.
```

### 13.1 Audit findings that shaped the design

- **No login/signup UI existed.** `api/auth/{signup,login,logout,me}.js`
  were fully built (an earlier milestone) but nothing in `src/` linked to
  them — no `/login` route, no navbar link, no form. Confirmed by
  grepping `src/` for `login`/`signup` (no matches) and reading `App.js`'s
  route table. This blocked Part 7 of the spec (heart click → "a clear
  login/signup path") until a minimal `LoginPage.js` was added — see
  §13.5.
- **No anonymous-identifier mechanism existed.** `src/services/
  recentActivity.js` is real prior art for client-side persistence
  (localStorage lists of recent searches/properties) but has no persistent
  anonymous id string anywhere. Confirmed by grepping `src/` for
  `anonymousId`/`visitorId`/`clientId` (no matches). Per the spec's own
  Part 14 allowance, no such system was invented this milestone — see
  §13.4.
- **`lucide-react` was already an installed, already-used dependency**
  (`src/components/popups/LeadPopup.js`, `src/components/home/
  InventoryStatsSection.js`) — its `Heart` icon is used for the wishlist
  control instead of adding a new icon dependency.
- **`ListingCard.js` and `CompactPropertyCard.js`** (both rendered from
  `PropertyListingPage.js`, in list/grid view respectively) are the two
  "individual listing card" components; both already share
  `PropertyImageGallery.js` for their image area, which is why the heart
  was added there once rather than duplicated in each card.
  `PropertyDetailPage.js` is the property detail page; its `id`/`slug`/
  `name`/`address`/`image`/`price` fields (from `amberMapper.js`'s
  `mapAmberPropertyDetails`) already carry everything a wishlist snapshot
  needs — no new Amber field or call was required anywhere.
  `mapAmberPropertyToListing`/`mapAmberPropertyDetails` both already
  return a stable `id` (Amber's own id, already used as the React list
  key) and `slug` (`canonical_name`, already used for the `/property/:slug`
  route) — this is the existing property identifier, not a new one.
  `CompactPropertyCard.js` was found to render `PropertyImageGallery`
  twice already (pre-existing, unrelated to this milestone) — left as-is
  per "don't redesign the card"; the heart was added to only the second
  occurrence so this milestone doesn't introduce a *second*, new duplicate
  heart on top of the pre-existing duplicate image render.

### 13.2 Wishlist data model

`api/_lib/models/Wishlist.js` already existed (Milestone 1) with
`{ userId (unique), items: [{ propertyId, city, propertyName, addedAt }] }`.
Extended (additively, no field removed/renamed) with `slug`, `image`, and
`price: { amount, currency }` — all five snapshot fields are already
present on every mapped listing/detail object the frontend has in hand at
the moment of an "add" click, so nothing was invented or re-fetched from
Amber to populate them. `propertyName` was kept as the existing field name
rather than renamed to the spec's "title" — same data, avoids gratuitous
schema churn.

### 13.3 Wishlist API (`api/wishlist/index.js`, `api/wishlist/[propertyId].js`)

| Method | Path | Access | Notes |
|---|---|---|---|
| GET | `/api/wishlist` | authenticated only | the caller's own wishlist, one document |
| POST | `/api/wishlist` | authenticated only | add a property snapshot; idempotent |
| GET | `/api/wishlist/:propertyId` | authenticated only | `{ wishlisted, item }` status check for one property |
| DELETE | `/api/wishlist/:propertyId` | authenticated only | remove; safe/idempotent if absent |

Authentication reuses `requireCustomerIdentity` (`api/_lib/businessAuth.js`,
the same session-cookie-derived identity bridge Milestone 2/3 already use)
— 401 if not logged in, and there is no `:userId` parameter anywhere in
this API's surface, so no request can ever address another user's
wishlist: identity comes from the session on every call, never a
client-supplied id (verified by the "spoofed body.userId" test in
`scripts/verify-wishlist-behavior.js`).

**Add idempotency**: implemented as ensure-document-exists, then one atomic
conditional update — `findOneAndUpdate({ userId, "items.propertyId": {
$ne: propertyId } }, { $push: { items: item } })`. The push only applies
if the filter (including the negative match on propertyId) matches, so a
duplicate add can never create a second item; no separate read-then-check
window. A duplicate add returns 200 (idempotent, not an error); a genuine
first add returns 201.

**Remove correctness (bug found and fixed during live verification)**:
the first implementation trusted `updateOne(...).modifiedCount` to mean
"an item was actually removed" — live testing against the real MongoDB
Atlas cluster showed this MongoDB version reports the document as
"modified" by `$pull` even when zero array elements matched and nothing
was removed, which made a second DELETE of an already-absent item
incorrectly report `removed: true` and record a second (spurious)
`WISHLIST_REMOVED` event. Fixed by explicitly checking presence first
(`findOne({ userId, "items.propertyId": propertyId })`) before pulling —
this is what a static/mocked test run would not have caught, and is the
concrete reason this milestone's live-DB verification step mattered.

### 13.4 Behavioral events

Reuses the existing `api/_lib/events.js#recordEvent` and `UserEvent` model
— no second event-tracking mechanism.

- `WISHLIST_ADDED` / `WISHLIST_REMOVED` — recorded server-side, inside the
  wishlist API handlers themselves (never from a frontend component
  directly), with `{ propertyId, city }`. `ENQUIRY_SUBMITTED` is unchanged
  from Milestone 3 — not touched or duplicated here.
- `PROPERTY_VIEWED` / `CITY_SEARCHED` — no existing server-side hook could
  see these (property browsing talks to Amber via `/api/amber`, not the
  business API), so this milestone added exactly one new, narrow endpoint:
  `POST /api/events`. It is **not** a generic "log any event" endpoint —
  the event name is checked against a fixed whitelist
  (`PROPERTY_VIEWED`/`CITY_SEARCHED` only) and each event's `properties`
  are picked field-by-field, never passed through verbatim, so a client
  can never write an arbitrary `UserEvent` document or forge
  `WISHLIST_ADDED`/`WISHLIST_REMOVED`/`ENQUIRY_SUBMITTED` through it
  (verified by `scripts/verify-wishlist-behavior.js`).
- Frontend call sites: `PropertyDetailPage.js`'s existing data-load effect
  (same place `addRecentProperty` already runs) fires `PROPERTY_VIEWED`
  once per real navigation to a property, not on every render.
  `PropertyListingPage.js`'s existing data-load effect (same place
  `addRecentSearch` already runs) fires `CITY_SEARCHED` once per real
  navigation to a city-scoped listings view — filter/sort/search-box
  changes never trigger it, since those don't touch the `city` URL param
  this effect depends on.

**Anonymous behavior (Part 14)**: since no anonymous-identifier mechanism
exists in this project (see §13.1), `POST /api/events` resolves identity
via `getOptionalMongoUserId` (the same optional-identity helper
`POST /api/enquiries` already uses) and, for an anonymous caller, accepts
the request (200, not an error — browsing must never require login) but
records nothing, rather than inventing a new anonymousId scheme for a
single milestone. This means `PROPERTY_VIEWED`/`CITY_SEARCHED` signal is
currently authenticated-visitors-only; documented here as a known
limitation for whichever future milestone introduces a real anonymous
identity mechanism, not silently swallowed.

**Property-view deduplication (Part 13)**: before recording
`PROPERTY_VIEWED` or `CITY_SEARCHED`, the handler checks for an existing
event with the same `userId` + event name + the relevant key field
(`propertyId` or `city`) within the last 30 minutes
(`UserEvent.findOne({ userId, event, "properties.<field>": value,
timestamp: { $gte: since } })`) and skips recording if found. This reuses
the existing `userId+timestamp` index rather than adding new
infrastructure, and 30 minutes approximates "one browsing visit" without
building a real session concept — a deliberately simple choice, not an
analytics pipeline. Verified live: a second `PROPERTY_VIEWED` for the same
user+property within the window returns `{ recorded: false, reason:
"deduped" }` and does not insert a second document.

### 13.5 Frontend: shared wishlist state, heart UI, and login

- **`src/context/WishlistContext.js`** — the smallest tool that fit Part
  9/10's "one request, not N": on mount, one `GET /api/auth/me` (are we
  logged in) followed by, only if authenticated, one `GET /api/wishlist`.
  The resulting `Set<propertyId>` and item list are shared via React
  Context to every card and the detail page — no per-card requests, no new
  state-management dependency (Redux/Zustand were not needed for one
  shallow shared value).
- **`src/components/listing/WishlistHeart.js`** — the heart control
  itself (`lucide-react`'s `Heart`, filled when wishlisted). Wired into
  `PropertyImageGallery.js` (shared by `ListingCard.js` and
  `CompactPropertyCard.js`) as a top-right overlay stacked with the
  pre-existing "Verified" badge rather than on top of it, and into
  `PropertyDetailPage.js`'s sidebar next to the property name. No card
  dimensions, typography, colors (apart from the heart itself), spacing,
  or existing buttons were changed.
- **Unauthenticated click (Part 7)**: `WishlistHeart` checks
  `WishlistContext`'s auth state; if not logged in, it stashes the
  property snapshot via `src/lib/pendingWishlist.js` (plain
  `sessionStorage`, not a new state machine) and navigates to
  `/login?returnTo=<current path>`. It never fires an unauthenticated
  wishlist request and hopes the backend handles it.
- **`src/pages/LoginPage.js` (new)**: the minimal login/signup form
  described in §13.1, wired to the existing `POST /api/auth/login` and
  `/api/auth/signup` (no new auth backend). On success it reads back the
  pending snapshot (if any) and completes the add, then returns to
  `returnTo` — fulfilling Part 8's "preserve intended navigation" using
  plain query params + sessionStorage, which fits the existing
  React Router setup cleanly without a bespoke auth state machine.
- **Cross-page consistency (Part 10)**: since both `ListingCard`/
  `CompactPropertyCard` and `PropertyDetailPage` read the same
  `WishlistContext` Set, wishlisting on one page and viewing the same
  property on another shows the correct heart state with zero additional
  requests — the Set is only ever refetched from the server after a
  mutating add/remove, optimistically updated in the meantime.

### 13.6 MongoDB indexes

Only one new index was added this milestone —
`Wishlist.index({ "items.propertyId": 1 })` — for the query pattern named
in the Milestone 4 spec's own "future dashboard queries" list ("which
users have wishlisted property X", "which properties are wishlisted
most"), which searches *across* every user's Wishlist document by an item
field; the existing unique `userId` index cannot serve that at all (it
only supports "load one user's own document"). Without this index that
query would be a full collection scan.

`UserEvent`'s existing `userId+timestamp` and `event+timestamp` indexes
(Milestone 1) already cover every new Milestone 4 query pattern — the
`PROPERTY_VIEWED`/`CITY_SEARCHED` dedup check and any future "who viewed
London properties multiple times" segmentation query both fit the
existing indexes — so no new `UserEvent` index was added. Both existing
and new indexes verified as actually present via `listIndexes()` in
`scripts/verify-wishlist-behavior.js`, not just declared in schema code.

### 13.7 Amber isolation (Milestone 4)

Verified by inspection: no file touched this milestone
(`api/wishlist/*`, `api/events/*`, `api/_lib/models/Wishlist.js`,
`api/_lib/wishlistView.js`, `src/context/WishlistContext.js`,
`src/components/listing/WishlistHeart.js`, `src/lib/eventsApi.js`,
`src/pages/LoginPage.js`) imports `amberGateway.js`, `sharedStore.js`,
`cacheWarmer.js`, or calls `/api/amber`. `api/amber.js`,
`src/services/amberApi.js`, `api/warm-amber-cache.js`, and
`api/_lib/cacheWarmer.js` were not modified. A wishlist add/remove and an
event POST are pure MongoDB writes; property-view tracking reuses the
`property` object the detail page already fetched for rendering — it
never triggers an additional Amber request to build the tracking payload.
