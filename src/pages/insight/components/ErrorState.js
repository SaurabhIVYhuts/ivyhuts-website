import React from "react";
import { AlertTriangle } from "lucide-react";

// Shared "an analytics API call failed" state (§20) — never a raw backend
// error message, just a friendly retry.
export default function ErrorState({ message = "Unable to load analytics", onRetry }) {
  return (
    <div className="insight-error-state">
      <AlertTriangle size={22} />
      <p>{message}</p>
      {onRetry && (
        <button type="button" className="btn btn-outline btn-sm" onClick={onRetry}>
          Try Again
        </button>
      )}
    </div>
  );
}

// Shared "no data for these filters" state (§21).
export function EmptyState({ message = "No booking data found for the selected filters.", onReset }) {
  return (
    <div className="insight-empty-state">
      <p>{message}</p>
      {onReset && (
        <button type="button" className="btn btn-outline btn-sm" onClick={onReset}>
          Reset Filters
        </button>
      )}
    </div>
  );
}
