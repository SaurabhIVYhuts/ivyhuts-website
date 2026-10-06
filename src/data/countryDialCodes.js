// Dial codes + national-number length rules for the phone input used by
// every lead form on the site (see src/components/forms/PhoneField.js).
//
// `min`/`max` are the length of the NATIONAL number only — the part after
// the dial code, with any trunk prefix (the UK's leading 0, India's 0)
// already dropped, which is exactly what the field stores. They are
// deliberately a RANGE rather than one exact length: most countries really
// do allow several lengths (Germany's national numbers run from 6 to 11
// digits), and a too-strict rule silently rejects a real customer. Where a
// country genuinely has a single length (India 10, UAE 9, China 11) the
// range is that one number, which is what makes "India numbers are 10
// digits" possible as an error message.
//
// E.164 caps the whole number at 15 digits including the dial code, so no
// `max` here is ever larger than 15 minus the dial code's own length.
//
// Several countries share a dial code (+1 US/Canada, +7 Russia/Kazakhstan)
// — `code` (the ISO 3166-1 alpha-2) is the identity, never `dial`.
// Ordering: India first (most of our traffic and the placeholder the forms
// used before this field existed), then the UK/US and the rest of our
// study destinations, then alphabetical.

const COUNTRY_DIAL_CODES = [
  { code: "IN", name: "India", dial: "+91", flag: "🇮🇳", min: 10, max: 10 },
  { code: "GB", name: "United Kingdom", dial: "+44", flag: "🇬🇧", min: 9, max: 10 },
  { code: "US", name: "United States", dial: "+1", flag: "🇺🇸", min: 10, max: 10 },
  { code: "CA", name: "Canada", dial: "+1", flag: "🇨🇦", min: 10, max: 10 },
  { code: "AU", name: "Australia", dial: "+61", flag: "🇦🇺", min: 9, max: 9 },
  { code: "IE", name: "Ireland", dial: "+353", flag: "🇮🇪", min: 7, max: 9 },
  { code: "DE", name: "Germany", dial: "+49", flag: "🇩🇪", min: 6, max: 11 },
  { code: "AE", name: "United Arab Emirates", dial: "+971", flag: "🇦🇪", min: 9, max: 9 },
  { code: "NZ", name: "New Zealand", dial: "+64", flag: "🇳🇿", min: 8, max: 10 },
  { code: "SG", name: "Singapore", dial: "+65", flag: "🇸🇬", min: 8, max: 8 },

  { code: "AM", name: "Armenia", dial: "+374", flag: "🇦🇲", min: 8, max: 8 },
  { code: "AR", name: "Argentina", dial: "+54", flag: "🇦🇷", min: 10, max: 10 },
  { code: "AT", name: "Austria", dial: "+43", flag: "🇦🇹", min: 7, max: 13 },
  { code: "AZ", name: "Azerbaijan", dial: "+994", flag: "🇦🇿", min: 9, max: 9 },
  { code: "BD", name: "Bangladesh", dial: "+880", flag: "🇧🇩", min: 10, max: 10 },
  { code: "BE", name: "Belgium", dial: "+32", flag: "🇧🇪", min: 8, max: 9 },
  { code: "BG", name: "Bulgaria", dial: "+359", flag: "🇧🇬", min: 8, max: 9 },
  { code: "BH", name: "Bahrain", dial: "+973", flag: "🇧🇭", min: 8, max: 8 },
  { code: "BR", name: "Brazil", dial: "+55", flag: "🇧🇷", min: 10, max: 11 },
  { code: "CH", name: "Switzerland", dial: "+41", flag: "🇨🇭", min: 9, max: 9 },
  { code: "CL", name: "Chile", dial: "+56", flag: "🇨🇱", min: 9, max: 9 },
  { code: "CN", name: "China", dial: "+86", flag: "🇨🇳", min: 11, max: 11 },
  { code: "CO", name: "Colombia", dial: "+57", flag: "🇨🇴", min: 10, max: 10 },
  { code: "CY", name: "Cyprus", dial: "+357", flag: "🇨🇾", min: 8, max: 8 },
  { code: "CZ", name: "Czechia", dial: "+420", flag: "🇨🇿", min: 9, max: 9 },
  { code: "DK", name: "Denmark", dial: "+45", flag: "🇩🇰", min: 8, max: 8 },
  { code: "EE", name: "Estonia", dial: "+372", flag: "🇪🇪", min: 7, max: 8 },
  { code: "EG", name: "Egypt", dial: "+20", flag: "🇪🇬", min: 9, max: 10 },
  { code: "ES", name: "Spain", dial: "+34", flag: "🇪🇸", min: 9, max: 9 },
  { code: "FI", name: "Finland", dial: "+358", flag: "🇫🇮", min: 6, max: 10 },
  { code: "FR", name: "France", dial: "+33", flag: "🇫🇷", min: 9, max: 9 },
  { code: "GE", name: "Georgia", dial: "+995", flag: "🇬🇪", min: 9, max: 9 },
  { code: "GH", name: "Ghana", dial: "+233", flag: "🇬🇭", min: 9, max: 9 },
  { code: "GR", name: "Greece", dial: "+30", flag: "🇬🇷", min: 10, max: 10 },
  { code: "HK", name: "Hong Kong", dial: "+852", flag: "🇭🇰", min: 8, max: 8 },
  { code: "HR", name: "Croatia", dial: "+385", flag: "🇭🇷", min: 8, max: 9 },
  { code: "HU", name: "Hungary", dial: "+36", flag: "🇭🇺", min: 8, max: 9 },
  { code: "ID", name: "Indonesia", dial: "+62", flag: "🇮🇩", min: 9, max: 12 },
  { code: "IL", name: "Israel", dial: "+972", flag: "🇮🇱", min: 8, max: 9 },
  { code: "IS", name: "Iceland", dial: "+354", flag: "🇮🇸", min: 7, max: 7 },
  { code: "IT", name: "Italy", dial: "+39", flag: "🇮🇹", min: 9, max: 10 },
  { code: "JP", name: "Japan", dial: "+81", flag: "🇯🇵", min: 9, max: 10 },
  { code: "KE", name: "Kenya", dial: "+254", flag: "🇰🇪", min: 9, max: 9 },
  { code: "KR", name: "South Korea", dial: "+82", flag: "🇰🇷", min: 9, max: 10 },
  { code: "KW", name: "Kuwait", dial: "+965", flag: "🇰🇼", min: 8, max: 8 },
  { code: "KZ", name: "Kazakhstan", dial: "+7", flag: "🇰🇿", min: 10, max: 10 },
  { code: "LK", name: "Sri Lanka", dial: "+94", flag: "🇱🇰", min: 9, max: 9 },
  { code: "LT", name: "Lithuania", dial: "+370", flag: "🇱🇹", min: 8, max: 8 },
  { code: "LU", name: "Luxembourg", dial: "+352", flag: "🇱🇺", min: 9, max: 9 },
  { code: "LV", name: "Latvia", dial: "+371", flag: "🇱🇻", min: 8, max: 8 },
  { code: "MA", name: "Morocco", dial: "+212", flag: "🇲🇦", min: 9, max: 9 },
  { code: "MT", name: "Malta", dial: "+356", flag: "🇲🇹", min: 8, max: 8 },
  { code: "MU", name: "Mauritius", dial: "+230", flag: "🇲🇺", min: 7, max: 8 },
  { code: "MX", name: "Mexico", dial: "+52", flag: "🇲🇽", min: 10, max: 10 },
  { code: "MY", name: "Malaysia", dial: "+60", flag: "🇲🇾", min: 7, max: 10 },
  { code: "NG", name: "Nigeria", dial: "+234", flag: "🇳🇬", min: 7, max: 10 },
  { code: "NL", name: "Netherlands", dial: "+31", flag: "🇳🇱", min: 9, max: 9 },
  { code: "NO", name: "Norway", dial: "+47", flag: "🇳🇴", min: 8, max: 8 },
  { code: "NP", name: "Nepal", dial: "+977", flag: "🇳🇵", min: 10, max: 10 },
  { code: "OM", name: "Oman", dial: "+968", flag: "🇴🇲", min: 8, max: 8 },
  { code: "PE", name: "Peru", dial: "+51", flag: "🇵🇪", min: 9, max: 9 },
  { code: "PH", name: "Philippines", dial: "+63", flag: "🇵🇭", min: 10, max: 10 },
  { code: "PK", name: "Pakistan", dial: "+92", flag: "🇵🇰", min: 10, max: 10 },
  { code: "PL", name: "Poland", dial: "+48", flag: "🇵🇱", min: 9, max: 9 },
  { code: "PT", name: "Portugal", dial: "+351", flag: "🇵🇹", min: 9, max: 9 },
  { code: "QA", name: "Qatar", dial: "+974", flag: "🇶🇦", min: 8, max: 8 },
  { code: "RO", name: "Romania", dial: "+40", flag: "🇷🇴", min: 9, max: 9 },
  { code: "RS", name: "Serbia", dial: "+381", flag: "🇷🇸", min: 8, max: 9 },
  { code: "RU", name: "Russia", dial: "+7", flag: "🇷🇺", min: 10, max: 10 },
  { code: "SA", name: "Saudi Arabia", dial: "+966", flag: "🇸🇦", min: 9, max: 9 },
  { code: "SE", name: "Sweden", dial: "+46", flag: "🇸🇪", min: 7, max: 9 },
  { code: "SI", name: "Slovenia", dial: "+386", flag: "🇸🇮", min: 8, max: 8 },
  { code: "SK", name: "Slovakia", dial: "+421", flag: "🇸🇰", min: 9, max: 9 },
  { code: "TH", name: "Thailand", dial: "+66", flag: "🇹🇭", min: 9, max: 9 },
  { code: "TR", name: "Türkiye", dial: "+90", flag: "🇹🇷", min: 10, max: 10 },
  { code: "TW", name: "Taiwan", dial: "+886", flag: "🇹🇼", min: 9, max: 9 },
  { code: "TZ", name: "Tanzania", dial: "+255", flag: "🇹🇿", min: 9, max: 9 },
  { code: "UA", name: "Ukraine", dial: "+380", flag: "🇺🇦", min: 9, max: 9 },
  { code: "UG", name: "Uganda", dial: "+256", flag: "🇺🇬", min: 9, max: 9 },
  { code: "VN", name: "Vietnam", dial: "+84", flag: "🇻🇳", min: 9, max: 10 },
  { code: "ZA", name: "South Africa", dial: "+27", flag: "🇿🇦", min: 9, max: 9 },
  { code: "ZW", name: "Zimbabwe", dial: "+263", flag: "🇿🇼", min: 9, max: 9 },
];

export const DEFAULT_COUNTRY_CODE = "IN";

export function findCountry(code) {
  return COUNTRY_DIAL_CODES.find((c) => c.code === code) || COUNTRY_DIAL_CODES[0];
}

// Matches on country name, ISO code and dial code, so "ire", "IE", "353"
// and "+353" all find Ireland. The leading + is optional on purpose —
// typing it is fiddly on a phone keypad.
export function searchCountries(query) {
  const q = query.trim().toLowerCase();
  if (!q) return COUNTRY_DIAL_CODES;
  const digits = q.replace(/^\+/, "");
  return COUNTRY_DIAL_CODES.filter(
    (c) =>
      c.name.toLowerCase().includes(q) ||
      c.code.toLowerCase() === q ||
      c.dial.replace("+", "").startsWith(digits)
  );
}

// The one place the "is this number usable" rule lives, so the popup and
// the contact form can never drift apart on it. Returns an error string or
// null — the message names the country's own expected length because
// "invalid phone number" tells someone nothing about what to fix.
export function validateNationalNumber(country, nationalNumber) {
  const digits = String(nationalNumber || "").replace(/\D/g, "");
  if (!digits) return "Please enter your phone number.";
  if (digits.length < country.min || digits.length > country.max) {
    const expected =
      country.min === country.max
        ? `${country.min} digits`
        : `${country.min}–${country.max} digits`;
    return `${country.name} numbers are ${expected}.`;
  }
  return null;
}

// What every form submits and stores: dial code + national number, e.g.
// "+91 9876543210". Keeps the country visible to whoever reads the lead in
// the inbox/CRM instead of making them guess from a bare 10-digit string.
export function formatFullNumber(country, nationalNumber) {
  return `${country.dial} ${String(nationalNumber || "").replace(/\D/g, "")}`.trim();
}

export default COUNTRY_DIAL_CODES;
