import React, { useMemo, useState } from "react";
import { CHART_COLORS, SEQUENTIAL_PURPLE, TEXT_MUTED, GRID_LINE } from "../../insightPalette";
import { formatShort, formatFull, niceStep } from "./timeChartUtils";

// Active-bar fill is the ramp's own darkest documented step, not an eyeballed
// shade — dataviz skill's "every slot is a hex from the instance file" rule.
const ACTIVE_BAR_FILL = SEQUENTIAL_PURPLE[SEQUENTIAL_PURPLE.length - 1];

// Hand-rolled SVG bar chart — sold-out inventory totals over time, day or
// month granularity. One series, so one flat identity color throughout
// (dataviz skill: "never color nominal bars by their value" — the tallest
// bar is called out with a direct value label + text badge instead of a
// different bar color, so magnitude is never double-encoded).
const VB_H = 300;
const PAD_LEFT = 44;
const PAD_RIGHT = 16;
const PAD_TOP = 32;
const PAD_BOTTOM = 38;
const BAR_MAX_W = 24;
const BAR_RADIUS = 4;
// Below this many bars, the chart stretches to fill the card (viewBox 800
// wide, scaled by CSS aspect-ratio). Past it, bars would be squeezed below a
// legible width, so the chart switches to a fixed-pixel width in a
// horizontally-scrolling container instead of shrinking further — mainly
// hits the day view once history runs past a few weeks.
const RESPONSIVE_MAX_POINTS = 20;
const FIXED_BAND_PX = 40;
// Comfortable band width when there are too few points to naturally fill the
// chart (e.g. one month of history so far = one bar). Without this, a single
// bar's band stretches to the full 800-wide plot and ends up looking lost in
// a mostly-empty grid — capping it and centering the used width keeps a
// sparse chart looking like a deliberately compact block instead.
const IDEAL_BAND_PX = 100;

function roundedTopRectPath(x, y, w, h, r) {
  const radius = Math.min(r, w / 2, Math.max(h, 0));
  if (h <= 0) return "";
  return `M${x},${y + radius} Q${x},${y} ${x + radius},${y} L${x + w - radius},${y} Q${x + w},${y} ${x + w},${y + radius} L${x + w},${y + h} L${x},${y + h} Z`;
}

// `points`: [{ key, totalSoldOut }], ascending. `granularity`: "day" | "month"
// — chooses axis/tooltip label formatting only, the geometry is identical.
export default function TrendBarChart({ points, granularity, selectedKey, onSelectKey }) {
  const [hoverKey, setHoverKey] = useState(null);

  const sorted = useMemo(() => [...(points || [])].sort((a, b) => a.key.localeCompare(b.key)), [points]);

  if (sorted.length === 0) {
    return <p className="insight-chart-empty">No sold-out snapshots recorded yet.</p>;
  }

  const scrollMode = sorted.length > RESPONSIVE_MAX_POINTS;
  const chartWidth = scrollMode ? PAD_LEFT + PAD_RIGHT + sorted.length * FIXED_BAND_PX : 800;

  const maxValue = Math.max(1, ...sorted.map((p) => p.totalSoldOut || 0));
  const step = niceStep(maxValue);
  const niceMax = Math.ceil(maxValue / step) * step;
  const ticks = [];
  for (let v = 0; v <= niceMax; v += step) ticks.push(v);

  const fullPlotWidth = chartWidth - PAD_LEFT - PAD_RIGHT;
  // In scroll mode every band is already the fixed ideal width, so there's
  // nothing to cap/center — the chart is exactly as wide as its content.
  const plotWidth = scrollMode ? fullPlotWidth : Math.min(fullPlotWidth, sorted.length * IDEAL_BAND_PX);
  const plotLeft = PAD_LEFT + (fullPlotWidth - plotWidth) / 2;
  const plotRight = plotLeft + plotWidth;
  const plotTop = PAD_TOP;
  const plotBottom = VB_H - PAD_BOTTOM;
  const plotHeight = plotBottom - plotTop;

  const bandWidth = plotWidth / sorted.length;
  const yFor = (v) => plotBottom - (v / (niceMax || 1)) * plotHeight;

  const maxIndex = sorted.reduce((best, p, i) => ((p.totalSoldOut || 0) > (sorted[best]?.totalSoldOut || -Infinity) ? i : best), 0);

  const activeKey = hoverKey || selectedKey;
  const activeEntry = sorted.find((p) => p.key === activeKey) || null;
  const activeIndex = activeEntry ? sorted.indexOf(activeEntry) : -1;

  return (
    <div className="insight-trendchart-scroll">
      <div className="insight-trendchart-wrap" style={scrollMode ? { width: chartWidth } : undefined}>
        <svg
          className={scrollMode ? "insight-trendchart-svg-fixed" : "insight-trendchart-svg"}
          width={scrollMode ? chartWidth : undefined}
          height={scrollMode ? VB_H : undefined}
          viewBox={`0 0 ${chartWidth} ${VB_H}`}
          role="img"
          aria-label={`Sold-out inventory by ${granularity}, ${formatFull(sorted[0].key, granularity)} to ${formatFull(sorted[sorted.length - 1].key, granularity)}`}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line x1={plotLeft} x2={plotRight} y1={yFor(t)} y2={yFor(t)} stroke={GRID_LINE} strokeWidth="1" />
              <text x={plotLeft - 10} y={yFor(t)} textAnchor="end" dominantBaseline="middle" fontSize="11" fill={TEXT_MUTED}>
                {t.toLocaleString()}
              </text>
            </g>
          ))}

          {sorted.map((p, i) => {
            const bandX = plotLeft + i * bandWidth;
            const barW = Math.min(BAR_MAX_W, bandWidth * 0.6);
            const barX = bandX + (bandWidth - barW) / 2;
            const barY = yFor(p.totalSoldOut || 0);
            const barH = plotBottom - barY;
            const isActive = i === activeIndex;
            const isHighest = i === maxIndex && sorted.length > 1;

            return (
              <g key={p.key}>
                {/* A light full-height wash behind the active column — gives
                    hover/selection some presence even when there's only one
                    or two bars on the chart, without introducing a second
                    hue (still just the one identity color, at low opacity). */}
                {isActive && <rect x={bandX + 2} y={plotTop} width={Math.max(bandWidth - 4, 0)} height={plotHeight} fill={CHART_COLORS.purple} opacity="0.06" rx="4" />}
                <path
                  d={roundedTopRectPath(barX, barY, barW, barH, BAR_RADIUS)}
                  fill={isActive ? ACTIVE_BAR_FILL : CHART_COLORS.purple}
                  style={{ transition: "fill 0.15s ease" }}
                />
                {isHighest && (
                  <text x={barX + barW / 2} y={barY - 8} textAnchor="middle" fontSize="12" fontWeight="700" fill={TEXT_MUTED}>
                    {(p.totalSoldOut || 0).toLocaleString()}
                  </text>
                )}
                <text x={bandX + bandWidth / 2} y={plotBottom + 20} textAnchor="middle" fontSize="11" fill={TEXT_MUTED}>
                  {formatShort(p.key, granularity)}
                </text>
                {isHighest && (
                  <text x={bandX + bandWidth / 2} y={plotTop - 10} textAnchor="middle" fontSize="10" fontWeight="700" fill={TEXT_MUTED}>
                    Highest
                  </text>
                )}
                {/* Hit target is wider than the visible bar and covers the
                    full plot height, per the dataviz skill's hover-layer
                    guidance. */}
                <rect
                  className="insight-trendchart-hit"
                  x={bandX}
                  y={plotTop}
                  width={bandWidth}
                  height={plotHeight}
                  fill="transparent"
                  tabIndex={0}
                  role="button"
                  aria-label={`${formatFull(p.key, granularity)}: ${(p.totalSoldOut || 0).toLocaleString()} sold out. Activate to see breakdown.`}
                  onPointerEnter={() => setHoverKey(p.key)}
                  onPointerLeave={() => setHoverKey(null)}
                  onFocus={() => setHoverKey(p.key)}
                  onBlur={() => setHoverKey(null)}
                  onClick={() => onSelectKey(p.key)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelectKey(p.key);
                    }
                  }}
                />
              </g>
            );
          })}
        </svg>

        {/* Fixed to a corner rather than floating above the bar's own height
            (same pattern as this file's sibling line-chart tooltip) — a
            bar near the top of the y-axis would otherwise push a
            height-following tooltip off the top of the chart. */}
        {activeEntry && (
          <div className="insight-trendchart-tooltip">
            <strong>{(activeEntry.totalSoldOut || 0).toLocaleString()}</strong>
            <span>{formatFull(activeEntry.key, granularity)}</span>
          </div>
        )}
      </div>

      <table className="sr-only">
        <caption>Sold-out inventory by {granularity}</caption>
        <thead>
          <tr>
            <th>{granularity === "day" ? "Date" : "Month"}</th>
            <th>Total sold out</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((p) => (
            <tr key={p.key}>
              <td>{formatFull(p.key, granularity)}</td>
              <td>{(p.totalSoldOut || 0).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
