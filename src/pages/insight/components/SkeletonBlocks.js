import React from "react";

// Polished loading placeholders (§19 of the spec) — never an empty white
// gap while a section is fetching.
export function ChartSkeleton({ height = 260 }) {
  return <div className="insight-skeleton insight-skeleton-chart" style={{ height }} />;
}

export function TableSkeleton({ rows = 6 }) {
  return (
    <div className="insight-skeleton-table">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="insight-skeleton insight-skeleton-row" />
      ))}
    </div>
  );
}
