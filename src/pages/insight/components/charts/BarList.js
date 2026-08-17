import React from "react";
import { SEQUENTIAL_PURPLE } from "../../insightPalette";

// Horizontal ranked bar list — the dataviz skill's default form for "compare
// magnitude, low to high" (Top Countries, demand-by-city, asking price by
// market). Plain HTML/CSS bars, not SVG: a percentage-width div is simpler
// and fully responsive for this shape. Sequential single hue (magnitude,
// not identity) unless an explicit two-series comparison is requested via
// `secondaryKey` (e.g. sold-out vs available), in which case it uses the
// validated two-color categorical pair passed in.
export default function BarList({
  data,
  valueKey = "value",
  secondaryKey,
  labelKey = "label",
  color = SEQUENTIAL_PURPLE[3],
  secondaryColor,
  legendLabel,
  secondaryLegendLabel,
  formatValue = (v) => v.toLocaleString(),
  emptyMessage = "No data for this view.",
}) {
  if (!data || data.length === 0) {
    return <p className="insight-chart-empty">{emptyMessage}</p>;
  }

  const max = Math.max(
    1,
    ...data.map((d) => (secondaryKey ? d[valueKey] + d[secondaryKey] : d[valueKey]))
  );

  return (
    <div className="insight-barlist">
      {secondaryKey && (
        <div className="insight-barlist-legend">
          <span>
            <i style={{ background: color }} /> {legendLabel}
          </span>
          <span>
            <i style={{ background: secondaryColor }} /> {secondaryLegendLabel}
          </span>
        </div>
      )}
      {data.map((row, i) => {
        const primaryPct = (row[valueKey] / max) * 100;
        const secondaryPct = secondaryKey ? (row[secondaryKey] / max) * 100 : 0;
        return (
          <div className="insight-barlist-row" key={row.id || row[labelKey] || i}>
            <span className="insight-barlist-label" title={row[labelKey]}>
              {row[labelKey]}
              {row.sublabel && <em>{row.sublabel}</em>}
            </span>
            <div className="insight-barlist-track">
              <div className="insight-barlist-fill" style={{ width: `${primaryPct}%`, background: row.color || color }} />
              {secondaryKey && (
                <div
                  className="insight-barlist-fill insight-barlist-fill-secondary"
                  style={{ width: `${secondaryPct}%`, background: secondaryColor }}
                />
              )}
            </div>
            <span className="insight-barlist-value">
              {formatValue(row[valueKey], row)}
              {secondaryKey && <span className="insight-barlist-value-secondary"> / {formatValue(row[secondaryKey], row)}</span>}
            </span>
          </div>
        );
      })}
    </div>
  );
}
