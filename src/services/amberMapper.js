// Normalizes a raw Amber `inventories` API item into a flat, safe shape for the UI.
// Every getter here tolerates missing/null/undefined data — the UI should never
// need to guess at Amber's raw field names or crash on a sparse property.

const CURRENCY_SYMBOLS = {
  pound: "£",
  gbp: "£",
  dollar: "$",
  usd: "$",
  euro: "€",
  eur: "€",
};

function truthy(v) {
  return v === true || v === "true";
}

function toNumber(v) {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

// Amber returns a room's `meta.area` in square metres. The UI shows square
// feet, so convert once here at the mapping boundary rather than in the
// component. 1 m² = 10.7639 ft²; rounded to a whole number.
function sqmToSqft(v) {
  const n = toNumber(v);
  return n == null ? null : Math.round(n * 10.7639);
}

function currencySymbol(raw) {
  if (!raw) return "";
  const key = String(raw).trim().toLowerCase();
  return CURRENCY_SYMBOLS[key] || raw;
}

function titleCase(str) {
  if (!str) return "";
  return String(str)
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function getPrimaryImage(raw) {
  if (typeof raw.image_featured_link === "string" && raw.image_featured_link.trim()) {
    return raw.image_featured_link;
  }
  if (raw.meta && typeof raw.meta.featured_image_path === "string" && raw.meta.featured_image_path.trim()) {
    return raw.meta.featured_image_path;
  }
  if (Array.isArray(raw.images) && raw.images.length) {
    const featured = raw.images.find((i) => i && i.featured && (i.path || i.url));
    if (featured) return featured.path || featured.url;
    const first = raw.images[0];
    if (first) return first.path || first.url || "";
  }
  return "";
}

function getGalleryImages(raw, limit = 10) {
  const primary = getPrimaryImage(raw);
  const out = [];
  const seen = new Set();

  const push = (url, caption) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    out.push({ url, caption: caption || "" });
  };

  if (primary) push(primary, "");

  if (Array.isArray(raw.images)) {
    for (const img of raw.images) {
      if (!img) continue;
      const url = typeof img === "string" ? img : img.path || img.url;
      push(url, typeof img === "object" ? img.caption : "");
      if (out.length >= limit) break;
    }
  }

  return out;
}

function getAddress(raw) {
  const loc = raw.location || {};
  const locality = loc.locality?.long_name || raw.city || "";
  const country = loc.country?.long_name || raw.country || "";
  const postcode = loc.postal_code?.long_name || "";
  // route.long_name (or the loc.primary fallback below it) is meant to be a
  // proper street line, but for some properties Amber sets it to just the
  // postcode itself — without this guard that duplicates the postcode into
  // the address twice (e.g. "45127, Essen, 45127, Germany").
  let route = loc.route?.long_name || loc.primary || "";
  if (route === postcode) route = "";
  const parts = [route, locality, postcode, country].filter(Boolean);
  return {
    line: route,
    locality,
    country,
    postcode,
    full: parts.join(", "),
  };
}

// NOTE on `from`: this is Amber's raw, availability-UNAWARE aggregate
// minimum (pricing.min_price) — confirmed live against real Amber data that
// it can and does equal a completely SOLD OUT room type's price (e.g. a
// real Manchester property returned pricing.min_price:186 matching a room
// with 0 tenancies and available:false, while pricing.min_available_price
// was 215, matching the actual cheapest bookable room). getPrice() is kept
// as-is for its OTHER fields (to/original/deposit/currency/duration, which
// aren't availability-sensitive) — every caller that needs an accurate,
// availability-aware "from" price must go through normalizeResidencePricing()
// below instead of trusting this function's own `from` value directly.
function getPrice(raw) {
  const pricing = raw.pricing || {};
  const from = toNumber(pricing.min_price ?? pricing.available_price ?? pricing.price);
  const to = toNumber(pricing.max_price);
  const original = toNumber(pricing.original_price ?? pricing.slashed_price);
  return {
    from,
    to,
    original: original !== null && original > (from ?? 0) ? original : null,
    currency: currencySymbol(pricing.currency),
    duration: pricing.duration ? String(pricing.duration).replace(/ly$/, "") : "",
    deposit: toNumber(pricing.deposit ?? pricing.min_deposit),
  };
}

function getDistances(raw, limit = 4) {
  const list = Array.isArray(raw.meta?.distances) ? raw.meta.distances : [];
  const cityCentre = list.find((d) => d && /city cent(re|er)/i.test(d.place || ""));
  const nearby = list.filter((d) => d && d !== cityCentre && d.place && d.distance);
  return {
    cityCentre: cityCentre ? cityCentre.distance : null,
    nearby: nearby.slice(0, limit).map((d) => ({ place: d.place, distance: d.distance })),
  };
}

// Strips HTML tags and decodes common entities, returning plain text paragraphs.
// We never use dangerouslySetInnerHTML — Amber's room "about"/"payment" fields
// come back as HTML, so this guarantees nothing they return can execute as markup.
function htmlToPlainText(html) {
  if (!html || typeof html !== "string") return "";
  return html
    .replace(/<\/(p|li|div|h[1-6])>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&rsquo;|&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function getAmenityGroups(raw) {
  if (!Array.isArray(raw.features)) return [];
  const groups = raw.features
    .filter((cat) => cat && Array.isArray(cat.values) && cat.values.length)
    .map((cat) => {
      const seen = new Set();
      const items = [];
      for (const v of cat.values) {
        const name = v && v.name && v.name.trim();
        if (name && !seen.has(name.toLowerCase())) {
          seen.add(name.toLowerCase());
          items.push(name);
        }
      }
      return { name: cat.name || titleCase(cat.type) || "Other", items };
    })
    .filter((g) => g.items.length > 0);
  return groups;
}

function getQuickFacts(raw) {
  const meta = raw.meta || {};
  const facts = [];
  const infoTags = Array.isArray(meta.property_info_tags) ? meta.property_info_tags : [];
  const tagByType = Object.fromEntries(infoTags.filter((t) => t && t.type).map((t) => [t.type, t.value]));

  if (tagByType.total_units != null) facts.push({ label: "Total Units", value: String(tagByType.total_units) });
  if (tagByType.highest_floor != null) facts.push({ label: "Floors", value: String(tagByType.highest_floor) });
  if (tagByType.build_in_year != null) facts.push({ label: "Built In", value: String(tagByType.build_in_year) });
  if (meta.min_bedroom_count != null && meta.max_bedroom_count != null) {
    facts.push({
      label: "Bedrooms",
      value: meta.min_bedroom_count === meta.max_bedroom_count ? String(meta.min_bedroom_count) : `${meta.min_bedroom_count}–${meta.max_bedroom_count}`,
    });
  }
  if (meta.min_lease_duration != null && meta.max_lease_duration != null) {
    const unit = meta.lease_duration_unit ? `${meta.lease_duration_unit}${meta.min_lease_duration === 1 ? "" : "s"}` : "";
    facts.push({ label: "Lease Duration", value: `${meta.min_lease_duration}–${meta.max_lease_duration} ${unit}`.trim() });
  }
  if (meta.guarantor_required) facts.push({ label: "Guarantor", value: titleCase(meta.guarantor_required) });
  if (meta.non_students_allowed != null) facts.push({ label: "Non-Students Allowed", value: meta.non_students_allowed ? "Yes" : "No" });

  return facts;
}

function getPolicyLinks(raw) {
  const meta = raw.meta || {};
  const links = [];
  if (meta.tnc_url) links.push({ label: "Terms & Conditions", url: meta.tnc_url });
  if (meta.booking_process_doc_url) links.push({ label: "Booking Process Guide", url: meta.booking_process_doc_url });
  return links;
}

// Room-type "description" entries mix an "about" blurb with payment/fee policy
// notes under the same array — Amber doesn't separate them, so we split by `name`.
function splitRoomDescriptionEntries(entries) {
  const about = [];
  const payment = [];
  if (!Array.isArray(entries)) return { about, payment };
  for (const entry of entries) {
    if (!entry) continue;
    const text = htmlToPlainText(entry.value);
    if (!text) continue;
    if (entry.name === "payment") {
      payment.push({ label: entry.display_name || titleCase(entry.tag) || "Payment Note", text });
    } else {
      about.push(text);
    }
  }
  return { about, payment };
}

// Amber's raw tenancy dates come as "DD-MM-YYYY" (verified against
// available_from_formatted, e.g. raw "01-09-2026" ↔ formatted "1 Sep, 2026").
function parseAmberDate(str) {
  if (!str || typeof str !== "string") return null;
  const m = str.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  const d = new Date(Number(yyyy), Number(mm) - 1, Number(dd));
  return Number.isNaN(d.getTime()) ? null : d;
}

function mapTenancy(leaf) {
  if (!leaf) return null;
  const price = toNumber(leaf.pricing?.price ?? leaf.weekly_price);
  const original = toNumber(leaf.slashed_available_price);
  return {
    id: leaf.id,
    name: leaf.name || "",
    available: leaf.available === true,
    availableFrom: leaf.meta?.available_from_formatted || leaf.available_from || null,
    availableFromRaw: leaf.available_from || null,
    availableTo: leaf.meta?.available_to_formatted || null,
    leaseDuration: leaf.meta?.lease_duration ? `${leaf.meta.lease_duration} ${leaf.meta.lease_duration_unit || ""}`.trim() : null,
    price,
    originalPrice: original !== null && price !== null && original > price ? original : null,
    currency: currencySymbol(leaf.pricing?.currency),
    // Same "monthly"/"weekly" -> "month"/"week" normalization as getPrice()
    // above — this tenancy's actual billing period is NOT always the same
    // as the room/property-level one (a UK property is usually weekly, a
    // continental European one is usually monthly), so it must be read per
    // tenancy rather than assumed.
    priceDuration: leaf.pricing?.duration ? String(leaf.pricing.duration).replace(/ly$/, "") : "",
  };
}

// Available tenancies first, cheapest-first within that group (by
// weekly-equivalent price — see weeklyEquivalentPrice below for why raw
// amounts across different lease durations aren't directly comparable).
// RoomTypeCard.js only ever shows the first TENANCY_PREVIEW of this array by
// default — confirmed live against a real property (Amber id 3302773,
// "136-138 New Walk, Leicester"): its room type carries 4 real available
// tenancies (£196/51wk, £188/51wk, £185/51wk, £204/44wk) in THAT raw order
// from Amber, none of it price-sorted. The room's displayed "From" price
// (getRoomLowestAvailablePrice, computed over the FULL tenancy list) already
// correctly showed the true minimum, £185 — but the old availability-only
// sort left it as tenancy #3, invisible in the default 2-row preview behind
// "View more tenancies" while two pricier options (£196, £188) showed
// instead. The number was never wrong; it just never appeared anywhere the
// preview showed, which reads exactly like a bug. Sorting the available
// group by price means the visible preview and the "From" price it sits
// under can never disagree again.
function sortTenancies(tenancies) {
  return [...tenancies].sort((a, b) => {
    if (a.available !== b.available) return a.available ? -1 : 1;
    if (!a.available) return 0; // unavailable tenancies: relative order doesn't matter, none are ever priced/shown as "from"
    const aw = a.price !== null ? weeklyEquivalentPrice(a.price, a.priceDuration) : null;
    const bw = b.price !== null ? weeklyEquivalentPrice(b.price, b.priceDuration) : null;
    if (aw != null && bw != null) return aw - bw;
    if (aw != null) return -1; // a comparable-duration tenancy ranks ahead of an unrankable one
    if (bw != null) return 1;
    return (a.price ?? Infinity) - (b.price ?? Infinity); // both unrankable durations — last-resort raw compare
  });
}

// A room is available if any of its real tenancies are — never just a raw flag,
// and never inferred from price alone. Falls back to the API's own room-level
// flag only when there's no tenancy data to check against at all.
function isRoomAvailable(child, tenancies) {
  if (tenancies.length > 0) return tenancies.some((t) => t.available);
  return child.available === true;
}

// Earliest move-in among AVAILABLE tenancies only — a sold-out tenancy's date
// must never be used to claim the room is "available from" that date.
function getRoomAvailableFrom(tenancies) {
  const dated = tenancies
    .filter((t) => t.available && t.availableFromRaw)
    .map((t) => ({ t, d: parseAmberDate(t.availableFromRaw) }))
    .filter((x) => x.d);
  if (!dated.length) return null;
  dated.sort((a, b) => a.d - b.d);
  return dated[0].t.availableFrom;
}

// Cheapest AVAILABLE tenancy — returns the FULL tenancy record (price AND
// its own currency/duration/id), never just a bare amount. This is the fix
// for a real data-integrity bug found live: the previous version returned
// only the minimum available PRICE, which callers then paired with the
// ROOM's own aggregate duration/currency (child.pricing.duration) — a
// different record. mapTenancy()'s own header already documents that a
// tenancy's actual billing period/currency is NOT always the same as its
// room's aggregate ("a UK property is usually weekly, a continental
// European one is usually monthly" — the same applies within one room
// across different tenancy offers). Mixing amount-from-tenancy-A with
// duration-from-the-room-aggregate can silently produce a price/duration
// pair that matches NO real record at all. Returning the whole tenancy
// keeps amount+currency+duration atomically from the SAME source, always.
// Returns null (never a fabricated substitute) when no tenancy is usable.
function selectCheapestAvailableTenancy(tenancies) {
  // price > 0, not just Number.isFinite — a zero/negative "price" is a data
  // artifact, never a real chargeable rate. Never fabricate £0 (item 14).
  const available = tenancies.filter((t) => t.available === true && Number.isFinite(t.price) && t.price > 0);
  if (!available.length) return null;
  return available.reduce((best, t) => (t.price < best.price ? t : best));
}

// Cross-duration comparison ONLY — never used for display (a room's actual
// billing period is always shown as-is; see mapRoomType()/getPrice()). Same
// constant/scope as api/_lib/accommodationIndex.js's own computePriceWeekly
// (one normalization decision shared by the Planner and every frontend
// consumer, not two that could disagree): null for anything not confidently
// week/month (term/semester/academic year/etc.) rather than a guessed
// conversion — per this codebase's standing rule of redistributing/skipping
// an unusable factor instead of fabricating one.
const WEEKS_PER_MONTH = 52 / 12;
export function weeklyEquivalentPrice(amount, duration) {
  if (!Number.isFinite(amount)) return null;
  if (duration === "week") return amount;
  if (duration === "month") return amount / WEEKS_PER_MONTH;
  return null;
}

// THE single authoritative "which room type is this property's displayed
// price" decision (item 11 of the pricing-accuracy fix) — every consumer
// (listing card, property detail sidebar, map popup, sort comparator) goes
// through this one function or normalizeResidencePricing() below, never a
// second competing implementation. Operates on an ALREADY-mapped roomTypes
// array (mapRoomType() output — `available`/`price.from` already correctly
// derived from real tenancy data, see isRoomAvailable()/
// getRoomLowestAvailablePrice() above), so a room whose price is null (no
// valid pricing data) or that's sold out is never eligible regardless of
// how cheap its raw number looks. Returns null when nothing qualifies —
// callers treat that as "every room type is sold out or unpriced",
// never a silent fallback to a sold-out room's price.
export function selectCheapestAvailableRoomType(roomTypes) {
  // price > 0, not just Number.isFinite — same "never fabricate £0" rule
  // (item 14) applied at the property-level room-to-room comparison too.
  const candidates = (Array.isArray(roomTypes) ? roomTypes : [])
    .filter((rt) => rt && rt.available === true && Number.isFinite(rt.price?.from) && rt.price.from > 0)
    .map((rt) => ({
      id: rt.id, name: rt.name, amount: rt.price.from, currency: rt.price.currency, duration: rt.price.duration || "week",
      // Provenance (item 17) — traceable back to the exact tenancy (or, for
      // the rare room-aggregate-only case, the room) this price came from.
      priceSource: rt.price.source || "room", sourceRoomId: rt.id, sourceTenancyId: rt.price.sourceTenancyId || null,
    }));
  if (!candidates.length) return null;

  // Prefer tenancy-backed candidates over a bare room-aggregate price
  // whenever ANY exist on this property — a room-aggregate price
  // (price.source === "room") means the room had ZERO real tenancies, so
  // RoomTypeCard.js structurally has no Enquire button to offer for it (that
  // button only ever renders per-tenancy) — a customer literally cannot act
  // on that specific room regardless of Amber's raw `available` flag. This
  // matters because a bare aggregate can be wrong in a way real tenancy data
  // never is: confirmed live on a real property (Halsmere Studios, London,
  // Amber id 133206) — "Diamond Studio Plus" appeared THREE times, all
  // `available: true`, all £100/week, all with zero tenancies (a phantom-
  // duplicate pattern — see dedupeRoomChildren's own header) while every
  // genuinely tenancy-backed room on the same property started at £410. The
  // aggregate £100 won the naive cheapest-price comparison and became the
  // advertised "From" price — real money-and-trust risk under the site's
  // Lowest Price Guarantee, since a customer had no way to actually enquire
  // about the £100 option. Only falls back to room-aggregate candidates when
  // NONE of the property's rooms have tenancy data at all (a genuinely
  // simple, tenancy-less listing with no richer data to prefer instead).
  const tenancyBacked = candidates.filter((c) => c.priceSource === "tenancy");
  const pool = tenancyBacked.length > 0 ? tenancyBacked : candidates;

  pool.sort((a, b) => {
    const aw = weeklyEquivalentPrice(a.amount, a.duration);
    const bw = weeklyEquivalentPrice(b.amount, b.duration);
    if (aw != null && bw != null) return aw - bw; // normal case: comparable durations, compare fairly
    if (aw != null) return -1; // a comparable-duration room ranks ahead of an unrankable one (e.g. "term")
    if (bw != null) return 1;
    return a.amount - b.amount; // both unrankable (e.g. both "term") — last-resort raw compare; same property, same currency in every real example seen
  });
  return pool[0];
}

// Builds the mapped room-type array once — shared by every caller below so
// the SAME dedupe/parse logic (and therefore the same availability/price
// per room) is used everywhere, never a second parallel parser.
function buildRoomTypes(raw) {
  return Array.isArray(raw?.children) ? dedupeRoomChildren(raw.children).map(mapRoomType).filter(Boolean) : [];
}

// Turns a `selectCheapestAvailableRoomType` result (or the no-room-data
// fallback) into the shared shape every consumer reads. `displayPrice` is
// ALWAYS an exact real source price (with `source` provenance) — the
// `comparison.weeklyEquivalent` figure lives in a SEPARATE object
// specifically so a consumer can never accidentally destructure/render it
// as if it were the display amount (item 6 of the fake-price fix: display
// price and comparison price must be structurally impossible to confuse).
function deriveDisplayPricing(roomTypes, raw) {
  if (roomTypes.length > 0) {
    const selected = selectCheapestAvailableRoomType(roomTypes);
    if (!selected) {
      // Real per-room-type data exists and every single one is sold out
      // (or has no valid price) — this IS confidently "sold out", not an
      // ambiguous/missing-data case.
      return { isSoldOut: true, displayPrice: null, comparison: null, selectedRoomType: null };
    }
    return {
      isSoldOut: false,
      displayPrice: { amount: selected.amount, currency: selected.currency, duration: selected.duration, source: selected.priceSource },
      comparison: { weeklyEquivalent: weeklyEquivalentPrice(selected.amount, selected.duration) },
      selectedRoomType: { id: selected.sourceRoomId, name: selected.name, availability: "available", sourceTenancyId: selected.sourceTenancyId },
    };
  }

  // No room-type breakdown at all (older/sparse item shape) — there is no
  // authoritative per-room signal to check, so per item 6 ("do not fabricate
  // availability"), only mark sold out on POSITIVE evidence (the property's
  // own top-level `available` flag being explicitly false), never infer it
  // from absent data. Otherwise fall back to Amber's own availability-aware
  // aggregate field when present (min_available_price — confirmed live to
  // exclude sold-out rooms, see this file's getPrice() comment), only
  // falling further back to the raw, availability-UNAWARE min_price as the
  // last resort this codebase already used before this fix. Amount and
  // duration both come from this SAME top-level `pricing` object here, so
  // there's no cross-record mixing risk in this fallback branch either.
  if (raw?.available === false) return { isSoldOut: true, displayPrice: null, comparison: null, selectedRoomType: null };
  const pricing = raw?.pricing || {};
  const amount = toNumber(pricing.min_available_price ?? pricing.available_price ?? pricing.min_price ?? pricing.price);
  if (!Number.isFinite(amount) || amount <= 0) return { isSoldOut: false, displayPrice: null, comparison: null, selectedRoomType: null };
  const duration = pricing.duration ? String(pricing.duration).replace(/ly$/, "") : "week";
  return {
    isSoldOut: false,
    displayPrice: { amount, currency: currencySymbol(pricing.currency), duration, source: "aggregate" },
    comparison: { weeklyEquivalent: weeklyEquivalentPrice(amount, duration) },
    selectedRoomType: null,
  };
}

// Public entry point for callers that only have a raw Amber item (not an
// already-mapped roomTypes array) — e.g. mapAmberPropertyToListing below.
// Recommended shape (pricing-accuracy fix, item 12):
//   { propertyId, isSoldOut, displayPrice: {amount,currency,duration}|null, selectedRoomType: {id,name,availability}|null }
export function normalizeResidencePricing(raw) {
  const propertyId = raw?.id ?? raw?.inventory_id ?? raw?._id ?? null;
  return { propertyId, ...deriveDisplayPricing(buildRoomTypes(raw), raw) };
}

// Amber's `children` array occasionally contains stale/phantom duplicate
// room-type entries alongside the real one — same `name`, sometimes a bogus
// price, and no reliable single tell-tale shared across all real cases.
//
// CASE 1 (confirmed live, the original motivation): a property whose real
// "Studio in Premium Residence" is AED1,840/week with 2 (available)
// tenancies also carried 3 phantom copies of the same name — AED505,
// $1854, $1854 — each with zero tenancies. Amber's own site only ever
// renders the real one.
//
// CASE 2 (confirmed live, a REAL PRICE INTEGRITY bug this exact function
// caused): a Toronto property's "1 Bed 1 Bath | Shared Triple" has TWO
// entries — one available:true, CAD123/month, with NO tenancy breakdown
// (a real, simple, currently-bookable listing), and one available:false,
// CAD860/month, WITH 2 tenancies, both unavailable (a stale/sold-out
// duplicate). A naive "prefer whichever copy has tenancies" rule — this
// function's ORIGINAL logic — kept the wrong one: the sold-out $860 entry,
// discarding the genuinely available $123 one, which then became the
// property's incorrectly-selected display price.
//
// The rule that resolves BOTH cases correctly: within a same-name group,
// AVAILABILITY is checked FIRST (isRoomAvailable's own tenancy-priority
// rule) — if at least one copy is genuinely available, only available
// copies are kept (an unavailable duplicate, tenancies or not, is never
// preferred over one with real availability evidence); among the available
// ones, prefer whichever have real tenancy detail (richer data), falling
// back to the tenancy-less available ones only if none have tenancies —
// this is exactly the Toronto case. If NONE of the group is available, fall
// back to the original phantom-suppression rule (prefer tenancy-bearing
// entries; keep one representative if none have tenancies either) — this
// is exactly the Dubai case, still correctly handled.
function dedupeRoomChildren(children) {
  const list = Array.isArray(children) ? children.filter(Boolean) : [];
  const groups = new Map();
  for (const child of list) {
    const key = String(child.name || "").trim().toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(child);
  }

  const hasTenancies = (child) => Array.isArray(child.children) && child.children.length > 0;
  const isGenuinelyAvailable = (child) => {
    const tenancies = Array.isArray(child.children) ? child.children : [];
    return tenancies.length > 0 ? tenancies.some((t) => t && t.available === true) : child.available === true;
  };

  const result = [];
  for (const group of groups.values()) {
    if (group.length === 1) { result.push(group[0]); continue; }

    const available = group.filter(isGenuinelyAvailable);
    if (available.length > 0) {
      const availableWithTenancies = available.filter(hasTenancies);
      result.push(...(availableWithTenancies.length ? availableWithTenancies : available));
    } else {
      const withTenancies = group.filter(hasTenancies);
      result.push(...(withTenancies.length ? withTenancies : [group[0]]));
    }
  }
  return result;
}

function mapRoomType(child) {
  if (!child) return null;
  const { about, payment } = splitRoomDescriptionEntries(child.description);
  const tenancies = sortTenancies((Array.isArray(child.children) ? child.children : []).map(mapTenancy).filter(Boolean));
  const types = Array.isArray(child.meta?.types) ? child.meta.types.map(titleCase) : [];
  const unitType = child.meta?.unit_type ? titleCase(child.meta.unit_type) : "";
  const metaChips = Array.from(new Set([unitType, ...types].filter(Boolean)));

  const roomPricing = getPrice(child);
  const available = isRoomAvailable(child, tenancies);
  // Amount, currency, AND duration always come from the SAME source record
  // — either one specific available tenancy (all three fields read off that
  // one tenancy, never mixed with the room's own separate aggregate), or,
  // when there's no usable tenancy at all, the room-level aggregate as a
  // single self-consistent whole. Never amount-from-one + duration-from-
  // another. See selectCheapestAvailableTenancy()'s own header for the real
  // bug class this prevents.
  const cheapestTenancy = selectCheapestAvailableTenancy(tenancies);
  const price = cheapestTenancy
    ? {
        ...roomPricing,
        from: cheapestTenancy.price,
        currency: cheapestTenancy.currency || roomPricing.currency,
        duration: cheapestTenancy.priceDuration || roomPricing.duration,
        source: "tenancy",
        sourceTenancyId: cheapestTenancy.id,
      }
    : { ...roomPricing, source: roomPricing.from !== null ? "room" : null };

  return {
    id: child.id,
    name: child.name || "Room",
    unitType,
    types,
    metaChips,
    bedroomCount: toNumber(child.meta?.bedroom_count),
    bathroomCount: toNumber(child.meta?.bathroom_count),
    sizeSqft: sqmToSqft(child.meta?.area),
    price,
    image: getPrimaryImage(child),
    images: getGalleryImages(child, 6),
    available,
    availableFrom: available ? getRoomAvailableFrom(tenancies) : null,
    about,
    paymentNotes: payment,
    tenancies,
  };
}

// Tenancy-backed-and-available first, then aggregate-only-available, then
// sold out — cheapest (weekly-equivalent) first within each tier. Mirrors
// sortTenancies' own reasoning one level up, PLUS selectCheapestAvailableRoomType's
// tenancy-backed-over-aggregate precedence (see that function's own header
// for the Halsmere Studios case this tier ordering closes): without the
// tenancy-tier split, a room whose "available" price is really a zero-
// tenancy aggregate (no Enquire button ever renders for it — RoomTypeCard.js
// only shows one per tenancy) could still sort ahead of the actual selected/
// advertised room purely by having a numerically lower aggregate number,
// recreating the exact same "list doesn't match the sidebar price" confusion
// this function was written to prevent, just in the opposite direction.
// Confirmed live: Halsmere Studios, London had THREE identical zero-tenancy
// "Diamond Studio Plus" entries at £100 (Amber's own site shows the correct
// £410) that would otherwise render first, ahead of the real £410 selection.
// Separately, mapAmberPropertyDetails' roomTypes previously rendered in
// Amber's raw order entirely, which can bury the one room type matching the
// advertised "From" price deep in a long, mostly-sold-out list — confirmed
// live on AXO Waterloo, London: its true cheapest available room, "Silver
// Twin Room" at £203/week (exactly matching the sidebar price), was 11th of
// 15 room types, sandwiched between six sold-out entries ranging £232-£555.
// Only affects the visible list order here — buildRoomTypes() below (which
// feeds selectCheapestAvailableRoomType for the listing-card price) already
// scans the full array regardless of order, so this has zero effect on
// which price gets selected, only on the order a human sees them rendered in.
function sortRoomTypes(roomTypes) {
  const tier = (rt) => {
    if (!rt.available) return 2;
    return rt.price?.source === "tenancy" ? 0 : 1;
  };
  return [...roomTypes].sort((a, b) => {
    const ta = tier(a);
    const tb = tier(b);
    if (ta !== tb) return ta - tb;
    if (ta === 2) return 0; // sold out: relative order doesn't matter
    const aw = a.price?.from != null ? weeklyEquivalentPrice(a.price.from, a.price.duration) : null;
    const bw = b.price?.from != null ? weeklyEquivalentPrice(b.price.from, b.price.duration) : null;
    if (aw != null && bw != null) return aw - bw;
    if (aw != null) return -1;
    if (bw != null) return 1;
    return (a.price?.from ?? Infinity) - (b.price?.from ?? Infinity);
  });
}

export function mapAmberPropertyDetails(raw) {
  if (!raw || typeof raw !== "object") return null;

  const address = getAddress(raw);
  const { badges, offerText, billsIncluded } = getBadges(raw);
  const roomTypes = sortRoomTypes(dedupeRoomChildren(raw.children).map(mapRoomType).filter(Boolean));
  // The SAME cheapest-available-room decision the listing card uses (see
  // mapAmberPropertyToListing below) — computed from this page's own
  // already-built roomTypes (no duplicate parsing), so the property-detail
  // sidebar/sticky-bar price can never disagree with the card that linked
  // here (pricing-accuracy fix, item 15).
  const pricing = deriveDisplayPricing(roomTypes, raw);
  const basePrice = getPrice(raw);

  // Aggregate unique payment/fee notes found across room types into one property-level list.
  const paymentNotesSeen = new Set();
  const paymentInfo = [];
  roomTypes.forEach((rt) => {
    rt.paymentNotes.forEach((note) => {
      if (!paymentNotesSeen.has(note.label)) {
        paymentNotesSeen.add(note.label);
        paymentInfo.push(note);
      }
    });
  });

  const coordinates = raw.location_coordinates && typeof raw.location_coordinates.lat === "number"
    ? { lat: raw.location_coordinates.lat, lng: raw.location_coordinates.lng }
    : null;

  return {
    id: raw.id ?? null,
    slug: raw.canonical_name || null,
    name: raw.name || "Student Accommodation",
    address,
    coordinates,
    image: getPrimaryImage(raw),
    images: getGalleryImages(raw, 24),
    // `from`/`currency`/`duration` come from the availability-aware
    // selection above; `to`/`original`/`deposit` are unaffected by
    // availability and keep basePrice's own values.
    price: pricing.displayPrice
      ? { ...basePrice, from: pricing.displayPrice.amount, currency: pricing.displayPrice.currency, duration: pricing.displayPrice.duration, source: pricing.displayPrice.source }
      : { ...basePrice, from: null },
    priceWeekly: pricing.comparison?.weeklyEquivalent ?? null,
    isSoldOut: pricing.isSoldOut,
    selectedRoomType: pricing.selectedRoomType,
    distances: getDistances(raw, 8),
    amenityGroups: getAmenityGroups(raw),
    badges,
    offerText,
    billsIncluded,
    quickFacts: getQuickFacts(raw),
    policyLinks: getPolicyLinks(raw),
    paymentInfo,
    roomTypes,
    rating: getRating(raw),
    reviewSummary: raw.meta?.review_summary?.summary || null,
    social: getSocialProof(raw),
    available: raw.available !== false,
  };
}

function getAmenities(raw, limit = 10) {
  const out = [];
  const seen = new Set();

  const add = (name) => {
    const clean = (name || "").trim();
    if (!clean) return;
    // Normalize the same way titleCase() does (hyphens/underscores -> space)
    // before comparing, so e.g. "Wi-Fi" from raw.features and "Wi-Fi" -> "Wi
    // Fi" from raw.tags (after titleCase mangles the hyphen) are recognized
    // as the same amenity instead of both surviving as separate chips.
    const key = clean.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(clean);
  };

  if (Array.isArray(raw.features)) {
    for (const category of raw.features) {
      if (!category || !Array.isArray(category.values)) continue;
      for (const v of category.values) {
        if (v && v.name) add(v.name);
      }
    }
  }

  if (Array.isArray(raw.tags)) {
    for (const t of raw.tags) {
      if (typeof t !== "string" || t === "not_available") continue;
      add(titleCase(t));
    }
  }

  return {
    shown: out.slice(0, limit),
    moreCount: Math.max(0, out.length - limit),
    all: out, // full, untruncated list — used for filtering, not for card display
  };
}

function getBadges(raw) {
  const cro = raw.meta?.cro_tags || {};
  const badges = [];

  if (truthy(cro.is_student_choice)) badges.push("Student's Choice");
  if (truthy(cro.is_amber_exclusive)) badges.push("Exclusive");
  if (truthy(cro.is_property_of_the_day)) badges.push("Property of the Day");
  if (truthy(cro.is_filling_fast_v2) || truthy(cro.is_fast_filling)) badges.push("Filling Fast");
  if (truthy(cro.is_immediate_move_in)) badges.push("Immediate Move-in");
  if (truthy(cro.is_breakfast_included)) badges.push("Breakfast Included");
  if (truthy(cro.is_budget_friendly)) badges.push("Budget Friendly");

  const hasDiscount = truthy(cro.has_discounts);
  const offerText = cro.amber_sale && typeof cro.amber_sale.offer === "string" ? cro.amber_sale.offer : "";
  if (hasDiscount) badges.push("Offer Available");

  const billsIncluded =
    (Array.isArray(raw.features) && raw.features.some((f) => f && f.type === "bills_included")) ||
    (Array.isArray(raw.tags) && raw.tags.some((t) => typeof t === "string" && t.toLowerCase().includes("bills_included")));
  if (billsIncluded) badges.push("Bills Included");

  const dualOccupancy = Array.isArray(raw.tags) && raw.tags.includes("dual_occupancy");
  if (dualOccupancy) badges.push("Dual Occupancy");

  return { badges, offerText, billsIncluded };
}

function getRooms(raw) {
  const children = Array.isArray(raw.children) ? raw.children : [];
  const unitTypes = new Set();
  const addType = (t) => {
    if (!t || /^\d/.test(t)) return; // skip cryptic bedroom-count codes like "1b", "3b"
    unitTypes.add(titleCase(t));
  };
  (raw.meta?.unit_types || []).forEach(addType);
  children.forEach((c) => addType(c?.meta?.unit_type));

  return {
    count: toNumber(raw.children_count) ?? children.length,
    activeCount: toNumber(raw.active_children_count),
    bedroomCount: toNumber(raw.meta?.bedroom_count),
    bathroomCount: toNumber(raw.meta?.bathroom_count),
    types: Array.from(unitTypes).slice(0, 4),
  };
}

function getRating(raw) {
  const rating = raw.meta?.review_summary?.rating;
  if (!rating || typeof rating !== "object") return null;
  const categories = Object.entries(rating).filter(([, v]) => typeof v === "number");
  if (!categories.length) return null;
  const avg = categories.reduce((sum, [, v]) => sum + v, 0) / categories.length;
  return {
    overall: Math.round(avg * 10) / 10,
    categories: categories.map(([name, value]) => ({ name: titleCase(name), value })),
  };
}

function getSocialProof(raw) {
  const facts = Array.isArray(raw.meta?.facts) ? raw.meta.facts : [];
  const byName = Object.fromEntries(facts.filter((f) => f && f.name).map((f) => [f.name, f]));
  return {
    shortlisted: byName.shortlisted_in_30days?.value || null,
    recentEnquiries: byName.enquires_in_15days?.value || null,
    recentBooking: byName.recent_booking?.value || null,
  };
}

// Same raw field Amber reports on every listing item (already read the same
// way, independently, by api/_lib/accommodationIndex.js's
// mapAmberItemToResidence server-side) — never fabricated, explicit null
// when absent/invalid so a map component can honestly skip an unplottable
// property rather than guess a location for it.
function getCoordinates(raw) {
  const lat = raw?.location_coordinates?.lat;
  const lng = raw?.location_coordinates?.lng;
  return typeof lat === "number" && typeof lng === "number" ? { lat, lng } : null;
}

const MONTH_LABELS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// Lightweight tenancy scan — deliberately NOT a full mapRoomType() pass (that
// builds full room/tenancy objects with images/descriptions for the detail
// page; here we only need two small option lists for the Move-in Month /
// Stay Duration filters). Reads the same raw `children[].children[]`
// tenancy shape mapRoomType() does. If a listings response ever omits this
// nested tenancy data (unconfirmed either way — Amber's listings endpoint
// payload is large enough that it may or may not include it), these simply
// return empty arrays and the corresponding filter doesn't render, same
// "only show what the data actually supports" rule every other filter here
// already follows.
function getMoveInOptions(raw) {
  const rooms = Array.isArray(raw.children) ? raw.children : [];
  const months = new Set();
  for (const room of rooms) {
    const tenancies = Array.isArray(room?.children) ? room.children : [];
    for (const t of tenancies) {
      if (t?.available !== true) continue;
      const d = parseAmberDate(t?.available_from);
      if (d) months.add(`${MONTH_LABELS[d.getMonth()]} ${d.getFullYear()}`);
    }
  }
  return Array.from(months).sort((a, b) => new Date(a) - new Date(b));
}

function getStayDurationOptions(raw) {
  const rooms = Array.isArray(raw.children) ? raw.children : [];
  const durations = new Set();
  for (const room of rooms) {
    const tenancies = Array.isArray(room?.children) ? room.children : [];
    for (const t of tenancies) {
      const value = t?.meta?.lease_duration;
      const unit = t?.meta?.lease_duration_unit;
      if (value != null && unit) durations.add(`${value} ${unit}${Number(value) === 1 ? "" : "s"}`);
    }
  }
  return Array.from(durations).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
}

export function mapAmberPropertyToListing(raw) {
  if (!raw || typeof raw !== "object") return null;

  const id = raw.id ?? raw.inventory_id ?? raw._id ?? null;
  const address = getAddress(raw);
  const { badges, offerText, billsIncluded } = getBadges(raw);
  // Same cheapest-available-room derivation mapAmberPropertyDetails uses —
  // via the shared buildRoomTypes()/deriveDisplayPricing() helpers, so a
  // listing card can never show a different "from" price than the detail
  // page it links to (pricing-accuracy fix, items 11/15).
  const pricing = deriveDisplayPricing(buildRoomTypes(raw), raw);
  const basePrice = getPrice(raw);

  return {
    id,
    slug: raw.canonical_name || null,
    name: raw.name || "Student Accommodation",
    address,
    coordinates: getCoordinates(raw),
    image: getPrimaryImage(raw),
    images: getGalleryImages(raw),
    price: pricing.displayPrice
      ? { ...basePrice, from: pricing.displayPrice.amount, currency: pricing.displayPrice.currency, duration: pricing.displayPrice.duration, source: pricing.displayPrice.source }
      : { ...basePrice, from: null },
    // Weekly-equivalent of the displayed price, for cross-duration-safe
    // sort/rank comparisons ONLY (item 18/24) — never shown to the student;
    // the card always renders price.from/price.duration verbatim. Read from
    // deriveDisplayPricing's own `comparison` object (computed once, single
    // source of truth) rather than re-deriving it here a second time — null
    // whenever displayPrice itself is null/unrankable (never guessed).
    priceWeekly: pricing.comparison?.weeklyEquivalent ?? null,
    isSoldOut: pricing.isSoldOut,
    selectedRoomType: pricing.selectedRoomType,
    distances: getDistances(raw),
    amenities: getAmenities(raw),
    badges,
    offerText,
    billsIncluded,
    rooms: getRooms(raw),
    moveInOptions: getMoveInOptions(raw),
    stayDurationOptions: getStayDurationOptions(raw),
    rating: getRating(raw),
    social: getSocialProof(raw),
    available: raw.available !== false,
    detailUrl: raw.partner_inventory_url || null,
  };
}

export function safeListingList(rawArray) {
  if (!Array.isArray(rawArray)) return [];
  return rawArray.map(mapAmberPropertyToListing).filter(Boolean);
}

// Adapter for the Mongo-backed browse/search path (api/city-listings.js,
// src/services/amberApi.js's getCityListings) — produces the SAME "listing"
// shape mapAmberPropertyToListing does, so ListingCard.js/CompactPropertyCard.js
// need no changes, but from AccommodationResidence's already-reduced summary
// doc (see api/_lib/models/AccommodationResidence.js) instead of a full raw
// Amber item. That doc deliberately never stored amenities/room-tenancy
// detail/social proof/full address (see its own header comment on why — this
// index exists to avoid duplicating that), so those fields come back empty/
// null here rather than fabricated; the property detail page (opened via
// `slug`) still does its own full, live, per-property Amber fetch and shows
// the complete picture there. This is the exact same "may be a little thin
// until you open it" tradeoff the Student Planner's own residence cards
// already accept for the same underlying data.
function mapResidenceDocToListing(doc) {
  if (!doc || typeof doc !== "object") return null;
  const id = doc.propertyId ?? null;
  const lat = doc.latitude;
  const lng = doc.longitude;
  const hasCoords = typeof lat === "number" && typeof lng === "number" && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  const locality = doc.city ? titleCase(doc.city) : "";
  const addressParts = [locality, doc.country].filter(Boolean);

  return {
    id,
    slug: doc.slug || null,
    name: doc.propertyName || "Student Accommodation",
    address: { line: "", locality, country: doc.country || "", postcode: "", full: addressParts.join(", ") },
    coordinates: hasCoords ? { lat, lng } : null,
    image: doc.image || null,
    images: doc.image ? [{ url: doc.image, caption: "" }] : [],
    price: {
      from: Number.isFinite(doc.price?.amount) ? doc.price.amount : null,
      to: null,
      original: null,
      currency: doc.price?.currency || "",
      duration: doc.priceDuration || "",
      deposit: null,
    },
    priceWeekly: Number.isFinite(doc.priceWeekly) ? doc.priceWeekly : null,
    isSoldOut: doc.available === false,
    selectedRoomType: null,
    distances: {
      // Rounded to 1 decimal (same convention accommodationIndex.js's own
      // toOutputShape uses for this same field) — the stored value is a
      // parsed float (see parseDistanceKm), unlike the live-Amber path's
      // distances.cityCentre, which is Amber's own already-formatted
      // display string ("0.5 km") and never needed rounding.
      cityCentre: Number.isFinite(doc.distanceToCentreKm) ? `${Math.round(doc.distanceToCentreKm * 10) / 10} km` : null,
      nearby: Array.isArray(doc.nearbyPlaces) ? doc.nearbyPlaces.slice(0, 4).map((d) => ({ place: d.place, distance: d.distance })) : [],
    },
    amenities: {
      shown: Array.isArray(doc.amenities) ? doc.amenities.slice(0, 6) : [],
      moreCount: Array.isArray(doc.amenities) ? Math.max(0, doc.amenities.length - 6) : 0,
      all: Array.isArray(doc.amenities) ? doc.amenities : [],
    },
    badges: Array.isArray(doc.badges) ? doc.badges : [],
    offerText: doc.offerText || "",
    billsIncluded: !!doc.billsIncluded,
    rooms: {
      count: Number.isFinite(doc.roomsCount) ? doc.roomsCount : null,
      activeCount: null,
      bedroomCount: null,
      bathroomCount: null,
      types: Array.isArray(doc.roomTypes) && doc.roomTypes.length ? doc.roomTypes : (doc.roomType ? [doc.roomType] : []),
    },
    moveInOptions: [],
    stayDurationOptions: [],
    rating: Number.isFinite(doc.rating) ? { overall: doc.rating, categories: [] } : null,
    social: { shortlisted: doc.socialShortlisted || null, recentEnquiries: null, recentBooking: null },
    available: doc.available !== false,
    detailUrl: null,
    // Not read by any component today — a hook for a future "may be a few
    // hours old" affordance, since this card came from the background index
    // rather than a fresh live Amber call (see this function's own header).
    fromIndex: true,
  };
}

export function safeResidenceListingList(docs) {
  if (!Array.isArray(docs)) return [];
  return docs.map(mapResidenceDocToListing).filter(Boolean);
}