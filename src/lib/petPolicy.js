// Amber's pet-policy amenity strings are free text with no fixed enum —
// confirmed live across 708 real properties: at least 20 distinct real
// variants exist ("Pet Friendly", "No Pets Allowed", "Pets not allowed",
// "Not Pet-Friendly", "Pet-Friendly Community", ...), so a "Pets Allowed" /
// "Pets Not Allowed" filter can't just check for one literal string the way
// the generic amenities filter does (that would silently miss most real
// matches). NOT_ALLOWED is checked before ALLOWED specifically because a
// string like "No Pets Allowed" contains the substring "pets allowed" —
// checking negatives first means that never gets misread as a positive.
// Pure pet-facility amenities with no explicit policy statement ("Pet Park",
// "Pet Washroom", "Carpets") are deliberately left unclassified rather than
// assumed — a facility existing doesn't confirm the policy either way.
const NOT_ALLOWED_RE = /no\s*pets?\b|pets?\s*(are\s*)?not\s*allowed|not\s*pet[\s-]?friendly/i;
const ALLOWED_RE = /pets?\s*allowed|pet[\s-]?friendly/i;

export function classifyPetPolicyText(name) {
  const text = String(name || "");
  if (NOT_ALLOWED_RE.test(text)) return "not_allowed";
  if (ALLOWED_RE.test(text)) return "allowed";
  return null;
}

// Scans a property's full real amenity list and returns the property's own
// stated policy — "allowed" if any amenity says so, "not_allowed" if any
// says so (checked first, same precedence reasoning as above so a property
// that also happens to list an unrelated positive-sounding amenity can't
// override an explicit "no pets" statement), or null if the property never
// states a policy either way (never fabricated).
export function classifyPetPolicy(amenityNames) {
  const list = Array.isArray(amenityNames) ? amenityNames : [];
  let sawAllowed = false;
  for (const name of list) {
    const result = classifyPetPolicyText(name);
    if (result === "not_allowed") return "not_allowed";
    if (result === "allowed") sawAllowed = true;
  }
  return sawAllowed ? "allowed" : null;
}
