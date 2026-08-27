import React, { useMemo, useState } from "react";
import { CHART_COLORS, TEXT_MUTED, GRID_LINE } from "../../insightPalette";
import { formatShort, formatFull, niceStep } from "./timeChartUtils";

// Single-series line chart — for watching ONE place's sold-out count move up
// and down over time (dataviz skill: "Trend over time -> line; area for a
// single series"). TrendBarChart stays the right form for comparing many
// periods side by side; this is the right form once a reader has drilled
// into one specific country/city and wants to see its shape over time, not
// compare it against anything else. Same brand-purple identity color, same
// axis/label conventions as TrendBarChart (shared via timeChartUtils) so the
// two charts read as one system, not two different tools bolted together.
const VB_H = 260;
const PAD_LEFT = 44;
const PAD_RIGHT = 16;
const PAD_TOP = 32;
const PAD_BOTTOM = 38;
const LINE_WIDTH = 2;
const DOT_RADIUS = 4; // >= 8px diameter per the mark spec
const ACTIVE_DOT_RADIUS = 6;

export default function TrendLineChart({ points, granularity, label }) {
  const [hoverKey, setHoverKey] = useState(null);

  const sorted = useMemo(() => [...(points || [])].sort((a, b) => a.key.localeCompare(b.key)), [points]);

  if (sorted.length === 0) {
    return <p className="insight-chart-empty">No sold-out snapshots recorded yet.</p>;
  }

  const maxValue = Math.max(1, ...sorted.map((p) => p.totalSoldOut || 0));
  const step = niceStep(maxValue);
  const niceMax = Math.ceil(maxValue / step) * step;
  const ticks = [];
  for (let v = 0; v <= niceMax; v += step) ticks.push(v);

  const plotLeft = PAD_LEFT;
  const plotRight = 800 - PAD_RIGHT;
  const plotTop = PAD_TOP;
  const plotBottom = VB_H - PAD_BOTTOM;
  const plotWidth = plotRight - plotLeft;
  const plotHeight = plotBottom - plotTop;

  // A single point still needs an x position — centers it rather than
  // dividing by zero. Two or more points space evenly across the full width.
  const stepX = sorted.length > 1 ? plotWidth / (sorted.length - 1) : 0;
  const xFor = (i) => (sorted.length > 1 ? plotLeft + i * stepX : plotLeft + plotWidth / 2);
  const yFor = (v) => plotBottom - (v / (niceMax || 1)) * plotHeight;

  const linePath = sorted.map((p, i) => `${i === 0 ? "M" : "L"}${xFor(i)},${yFor(p.totalSoldOut || 0)}`).join(" ");
  // Soft area wash under the line — the documented single-series exception
  // (~10% opacity, never a saturated block), closing back down to the
  // baseline so it reads as "area under the curve," not a stray shape.
  const areaPath = `${linePath} L${xFor(sorted.length - 1)},${plotBottom} L${xFor(0)},${plotBottom} Z`;

  const maxIndex = sorted.reduce((best, p, i) => ((p.totalSoldOut || 0) > (sorted[best]?.totalSoldOut || -Infinity) ? i : best), 0);
  const activeEntry = sorted.find((p) => p.key === hoverKey) || null;
  const activeIndex = activeEntry ? sorted.indexOf(activeEntry) : -1;

  return (
    <div className="insight-trendchart-wrap">
      <svg
        className="insight-trendchart-svg"
        viewBox={`0 0 800 ${VB_H}`}
        role="img"
        aria-label={`${label ? `${label}'s ` : ""}sold-out inventory by ${granularity}, ${formatFull(sorted[0].key, granularity)} to ${formatFull(sorted[sorted.length - 1].key, granularity)}`}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={plotLeft} x2={plotRight} y1={yFor(t)} y2={yFor(t)} stroke={GRID_LINE} strokeWidth="1" />
            <text x={plotLeft - 10} y={yFor(t)} textAnchor="end" dominantBaseline="middle" fontSize="11" fill={TEXT_MUTED}>
              {t.toLocaleString()}
            </text>
          </g>
        ))}

        {/* Vertical crosshair on hover — "finds the X," per the dataviz
            skill's interaction rule for line charts. */}
        {activeEntry && <line x1={xFor(activeIndex)} x2={xFor(activeIndex)} y1={plotTop} y2={plotBottom} stroke={GRID_LINE} strokeWidth="1" />}

        <path d={areaPath} fill={CHART_COLORS.purple} opacity="0.08" stroke="none" />
        <path d={linePath} fill="none" stroke={CHART_COLORS.purple} strokeWidth={LINE_WIDTH} strokeLinejoin="round" strokeLinecap="round" />

        {sorted.map((p, i) => {
          const isActive = i === activeIndex;
          const isHighest = i === maxIndex && sorted.length > 1;
          const x = xFor(i);
          const y = yFor(p.totalSoldOut || 0);
          return (
            <g key={p.key}>
              {/* Surface ring keeps the dot legible where the line crosses
                  or dots sit close together — the documented spacer, not a
                  border-as-separator. */}
              <circle cx={x} cy={y} r={isActive ? ACTIVE_DOT_RADIUS : DOT_RADIUS} fill={CHART_COLORS.purple} stroke="#FFFFFF" strokeWidth="2" style={{ transition: "r 0.15s ease" }} />
              {isHighest && (
                <text x={x} y={y - 12} textAnchor="middle" fontSize="12" fontWeight="700" fill={TEXT_MUTED}>
                  {(p.totalSoldOut || 0).toLocaleString()}
                </text>
              )}
              <text x={x} y={plotBottom + 20} textAnchor="middle" fontSize="11" fill={TEXT_MUTED}>
                {formatShort(p.key, granularity)}
              </text>
              {/* Hit target well beyond the 8px dot — a pinpoint nobody
                  reliably hits otherwise. */}
              <rect
                x={x - Math.max(stepX / 2, 16)}
                y={plotTop}
                width={Math.max(stepX, 32)}
                height={plotHeight}
                fill="transparent"
                tabIndex={0}
                role="img"
                aria-label={`${formatFull(p.key, granularity)}: ${(p.totalSoldOut || 0).toLocaleString()} sold out`}
                onPointerEnter={() => setHoverKey(p.key)}
                onPointerLeave={() => setHoverKey(null)}
                onFocus={() => setHoverKey(p.key)}
                onBlur={() => setHoverKey(null)}
              />
            </g>
          );
        })}
      </svg>

      {activeEntry && (
        <div className="insight-trendchart-tooltip">
          <strong>{(activeEntry.totalSoldOut || 0).toLocaleString()}</strong>
          <span>{formatFull(activeEntry.key, granularity)}</span>
        </div>
      )}

      <table className="sr-only">
        <caption>{label ? `${label}'s sold-out inventory` : "Sold-out inventory"} by {granularity}</caption>
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
