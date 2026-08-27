// Shared helpers between TrendBarChart (many periods, compared) and
// TrendLineChart (one place, watched over time) — kept in sync in one place
// rather than copy-pasted, since both charts share the same date-key shape
// and axis-labeling rules.
export function formatShort(key, granularity) {
  const d = new Date(granularity === "day" ? `${key}T00:00:00` : `${key}-01T00:00:00`);
  return granularity === "day"
    ? d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })
    : d.toLocaleDateString("en-GB", { month: "short", year: "2-digit" });
}
export function formatFull(key, granularity) {
  const d = new Date(granularity === "day" ? `${key}T00:00:00` : `${key}-01T00:00:00`);
  return granularity === "day"
    ? d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })
    : d.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
}

// "Nice" tick step (1/2/5 x 10^n) so the y-axis reads 0 / 500 / 1,000 rather
// than an arbitrary fraction of the max value.
export function niceStep(roughMax) {
  if (roughMax <= 0) return 1;
  const rough = roughMax / 4;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const norm = rough / mag;
  const step = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
  return step * mag;
}
