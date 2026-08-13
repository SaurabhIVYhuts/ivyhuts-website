import React from "react";
import DataUnavailableCard from "../DataUnavailableCard";
import BarList from "../charts/BarList";
import ErrorState, { EmptyState } from "../ErrorState";
import { ChartSkeleton } from "../SkeletonBlocks";
import { CHART_COLORS } from "../../insightPalette";

// Section 6 of the /insight spec: "How far in advance are bookings being
// made?" No real booking-transaction data (booking date vs. stay/start date)
// exists in Amber's responses today — see api/_lib/insightsMarket.js's
// normalizeItem, which has no such field. This renders the honest
// "unavailable" state, per the spec's explicit "do NOT fabricate this
// metric" rule, while already reading the exact shape
// (data.bookingLeadTime) a future real data source would populate — no
// redesign needed when that day comes.
export default function BookingSection({ data, loading, error, onRetry, onResetFilters }) {
  if (loading) {
    return (
      <div className="insight-section">
        <ChartSkeleton height={160} />
      </div>
    );
  }
  if (error) return <ErrorState onRetry={onRetry} />;
  if (!data) return <EmptyState onReset={onResetFilters} />;
  if (data.available === false) {
    return (
      <div className="insight-section">
        <EmptyState message={`No snapshot was stored for ${data.date}.`} onReset={onResetFilters} />
      </div>
    );
  }

  const leadTime = data.bookingLeadTime;

  return (
    <div className="insight-section">
      <div className="insight-section-intro">
        <h2>Booking Intelligence</h2>
        <p>How far in advance bookings are made, by property and city — requires real booking-transaction data, not asking-price listings.</p>
      </div>

      {!leadTime || !leadTime.available ? (
        <DataUnavailableCard
          label="Booking Lead-Time"
          reason={
            leadTime?.message ||
            "Booking lead-time data will appear here once booking transaction data is available — IVYHUTS/Amber does not currently capture when a booking was made relative to the stay start date."
          }
        />
      ) : (
        <>
          <div className="insight-kpi-grid">
            <div className="insight-kpi-card">
              <div className="insight-kpi-body">
                <span className="insight-kpi-label">Average Lead Time</span>
                <span className="insight-kpi-value">{leadTime.averageDays != null ? `${leadTime.averageDays} days` : "—"}</span>
              </div>
            </div>
            <div className="insight-kpi-card">
              <div className="insight-kpi-body">
                <span className="insight-kpi-label">Median Lead Time</span>
                <span className="insight-kpi-value">{leadTime.medianDays != null ? `${leadTime.medianDays} days` : "—"}</span>
              </div>
            </div>
          </div>
          {leadTime.distribution && (
            <div className="insight-card">
              <h3>Lead-Time Distribution</h3>
              <BarList data={Object.entries(leadTime.distribution).map(([label, value]) => ({ label, value }))} color={CHART_COLORS.blue} />
            </div>
          )}
          {leadTime.byCity && (
            <div className="insight-card">
              <h3>Average Lead Time by City</h3>
              <BarList
                data={Object.entries(leadTime.byCity).map(([label, value]) => ({ label, value }))}
                color={CHART_COLORS.gold}
                formatValue={(v) => `${v} days`}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}
