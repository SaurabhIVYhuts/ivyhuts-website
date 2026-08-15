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
  const route = loc.route?.long_name || loc.primary || "";
  const parts = [route, locality, postcode, country].filter(Boolean);
  return {
    line: route,
    locality,
    country,
    postcode,
    full: parts.join(", "),
  };
}

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
  };
}

// Available tenancies first (stable sort preserves Amber's own ordering within each group).
function sortTenancies(tenancies) {
  return [...tenancies].sort((a, b) => (a.available === b.available ? 0 : a.available ? -1 : 1));
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

// Cheapest price among AVAILABLE tenancies — falls back to the room-level
// pricing aggregate only when there's no usable tenancy data at all.
function getRoomLowestAvailablePrice(tenancies, fallbackPrice) {
  const prices = tenancies.filter((t) => t.available && t.price !== null).map((t) => t.price);
  return prices.length ? Math.min(...prices) : fallbackPrice;
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

  return {
    id: child.id,
    name: child.name || "Room",
    unitType,
    types,
    metaChips,
    bedroomCount: toNumber(child.meta?.bedroom_count),
    bathroomCount: toNumber(child.meta?.bathroom_count),
    sizeSqm: toNumber(child.meta?.area) || null,
    price: { ...roomPricing, from: getRoomLowestAvailablePrice(tenancies, roomPricing.from) },
    image: getPrimaryImage(child),
    images: getGalleryImages(child, 6),
    available,
    availableFrom: available ? getRoomAvailableFrom(tenancies) : null,
    about,
    paymentNotes: payment,
    tenancies,
  };
}

export function mapAmberPropertyDetails(raw) {
  if (!raw || typeof raw !== "object") return null;

  const address = getAddress(raw);
  const { badges, offerText, billsIncluded } = getBadges(raw);
  const roomTypes = (Array.isArray(raw.children) ? raw.children : []).map(mapRoomType).filter(Boolean);

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
    price: getPrice(raw),
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
    if (!clean || seen.has(clean.toLowerCase())) return;
    seen.add(clean.toLowerCase());
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

export function mapAmberPropertyToListing(raw) {
  if (!raw || typeof raw !== "object") return null;

  const id = raw.id ?? raw.inventory_id ?? raw._id ?? null;
  const address = getAddress(raw);
  const { badges, offerText, billsIncluded } = getBadges(raw);

  return {
    id,
    slug: raw.canonical_name || null,
    name: raw.name || "Student Accommodation",
    address,
    coordinates: getCoordinates(raw),
    image: getPrimaryImage(raw),
    images: getGalleryImages(raw),
    price: getPrice(raw),
    distances: getDistances(raw),
    amenities: getAmenities(raw),
    badges,
    offerText,
    billsIncluded,
    rooms: getRooms(raw),
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