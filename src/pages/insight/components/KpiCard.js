import React from "react";

// Stat-tile contract (dataviz skill): label, value (compact), optional
// signed delta, optional description. Trend is only ever rendered when the
// caller actually has comparison data — never a fabricated percentage (see
// the /insight spec's own "no fake trends" rule).
export default function KpiCard({ icon, label, value, description, trend }) {
  return (
    <div className="insight-kpi-card">
      <div className="insight-kpi-icon">{icon}</div>
      <div className="insight-kpi-body">
        <span className="insight-kpi-label">{label}</span>
        <span className="insight-kpi-value">{value}</span>
        {trend != null && (
          <span className={`insight-kpi-trend ${trend >= 0 ? "up" : "down"}`}>
            {trend >= 0 ? "+" : ""}
            {trend.toFixed(1)}% vs previous period
          </span>
        )}
        {description && <span className="insight-kpi-desc">{description}</span>}
      </div>
    </div>
  );
}
