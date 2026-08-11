import React from "react";
import { AlertCircle } from "lucide-react";

// The explicit "Data unavailable" pattern required across the /insight
// spec (§6, §12, §13, §18) wherever a metric has no real backing field
// (booked price, revenue, discount %) — rendered instead of a fabricated
// number or a silently-omitted section, so it's clear the gap is data, not
// a bug.
export default function DataUnavailableCard({ label, reason }) {
  return (
    <div className="insight-unavailable-card">
      <AlertCircle size={18} />
      <div>
        <span className="insight-unavailable-label">{label}</span>
        <span className="insight-unavailable-reason">{reason || "Data unavailable — not currently captured."}</span>
      </div>
    </div>
  );
}
