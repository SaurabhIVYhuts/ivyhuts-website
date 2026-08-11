// Chart color palette for /insight — derived from IVYHUTS' own brand hues
// (src/styles/global.css's --brand-* tokens), then nudged onto passing
// OKLCH lightness/chroma steps and verified with the dataviz skill's
// six-checks validator (all PASS at light mode; gold carries a contrast
// WARN, mitigated by always pairing it with a direct label — never
// color-alone). Do not hand-edit these hexes without re-running:
//   node scripts/validate_palette.js "<hexes>" --mode light
// from the dataviz skill's base directory.
export const CHART_COLORS = {
  purple: "#8552A0", // primary — leads, sold-out, "us"
  gold: "#C8960C", // secondary — enquiries, asking price (brand-gold, unchanged)
  blue: "#4A90D9", // tertiary — available/remaining inventory
  puce: "#B05E72", // quaternary — accent/highlight (brand-puce-deep, unchanged)
};

// One-hue sequential ramp (light -> dark = low -> high magnitude), same
// purple family as CHART_COLORS.purple, for ranked bar lists (demand by
// city, asking price by market) where only one series exists.
export const SEQUENTIAL_PURPLE = ["#EDE3F1", "#D3B8DE", "#B187C6", "#8552A0", "#6B3D87"];

export const TEXT_MUTED = "#7B5B70"; // --ink-softer
export const TEXT_SOFT = "#6B4E5E"; // --ink-soft
export const GRID_LINE = "#EDD5E3"; // --border-soft

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function toHex(n) {
  return Math.round(n).toString(16).padStart(2, "0");
}

// Ordinal ramp helper — one hue (purple), monotone lightness, for a
// sequence where position carries meaning (funnel stage, lead-time bucket)
// rather than identity. t=0 lightest (earliest/lowest), t=1 darkest.
export function purpleRampAt(t) {
  const light = hexToRgb("#EDE3F1");
  const dark = hexToRgb("#5E3A6B");
  const clamped = Math.max(0, Math.min(1, t));
  const r = light.r + (dark.r - light.r) * clamped;
  const g = light.g + (dark.g - light.g) * clamped;
  const b = light.b + (dark.b - light.b) * clamped;
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}
