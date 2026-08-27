import React from "react";
import { purpleRampAt } from "../../insightPalette";

// Sequential-magnitude heatmap — the dataviz skill's documented alternative
// to a bar form for "compare magnitude across many categories" (one hue,
// light->dark = low->high). Deliberately not a bar list: this is for
// scanning many countries/cities at once, where a grid of colored tiles
// reads faster than a long column of rows. The value is always printed on
// the tile itself, never color-alone — a color-blind reader (or anyone on
// grayscale) still gets the real number, not just a shade.
function relativeLuminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const toLinear = (c) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const r = toLinear((n >> 16) & 255);
  const g = toLinear((n >> 8) & 255);
  const b = toLinear(n & 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
// Text sits inside a colored fill — the one case where text legitimately
// wears a data-driven color, per the skill's own marks-and-anatomy rule:
// pick white or ink by the fill's luminance so it always clears contrast.
function textColorFor(bgHex) {
  return relativeLuminance(bgHex) > 0.5 ? "#2E1A2A" : "#FFFFFF";
}

export default function BreakdownHeatmap({ data, labelKey = "label", valueKey = "soldOut", emptyMessage = "No data for this view." }) {
  if (!data || data.length === 0) {
    return <p className="insight-chart-empty">{emptyMessage}</p>;
  }

  const maxValue = Math.max(1, ...data.map((d) => d[valueKey] || 0));

  return (
    <div className="insight-heatmap">
      <div className="insight-heatmap-grid">
        {data.map((row, i) => {
          const value = row[valueKey] || 0;
          const bg = purpleRampAt(value / maxValue);
          const ink = textColorFor(bg);
          return (
            <div key={row.id || row[labelKey] || i} className="insight-heatmap-cell" style={{ background: bg, color: ink }} title={`${row[labelKey]}${row.sublabel ? `, ${row.sublabel}` : ""}: ${value.toLocaleString()} sold out`}>
              <span className="insight-heatmap-value">{value.toLocaleString()}</span>
              <span className="insight-heatmap-label">
                {row[labelKey]}
                {row.sublabel && <em>{row.sublabel}</em>}
              </span>
            </div>
          );
        })}
      </div>
      <div className="insight-heatmap-scale">
        <span
          className="insight-heatmap-scale-swatch"
          style={{ background: `linear-gradient(90deg, ${purpleRampAt(0)}, ${purpleRampAt(1)})` }}
        />
        <span>Fewer sold out</span>
        <span className="insight-heatmap-scale-spacer" />
        <span>More sold out</span>
      </div>
    </div>
  );
}
