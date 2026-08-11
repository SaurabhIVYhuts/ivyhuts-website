import React, { useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import BarList from "../charts/BarList";
import { ChartSkeleton } from "../SkeletonBlocks";
import ErrorState, { EmptyState } from "../ErrorState";
import { CHART_COLORS } from "../../insightPalette";

function aggregateByCountry(cities) {
  const byCountry = new Map();
  for (const c of cities) {
    if (!c.cached) continue;
    const prev = byCountry.get(c.country) || { label: c.country, value: 0, secondary: 0 };
    prev.value += c.soldOut;
    prev.secondary += c.available;
    byCountry.set(c.country, prev);
  }
  return Array.from(byCountry.values()).sort((a, b) => b.value - a.value);
}

function rankOpportunity(cities, overviewByCity) {
  const demandByCity = new Map((overviewByCity || []).map((d) => [d.city, d.count]));
  return cities
    .filter((c) => c.cached && c.total > 0)
    .map((c) => ({
      ...c,
      demandSignal: demandByCity.get(c.city) || 0,
      // Transparent composite: real sold-out rate + real enquiry/lead volume,
      // no invented weighting scheme presented as AI insight — the underlying
      // numbers are shown alongside it (spec §15 explicitly requires this).
      score: c.soldOutRate * 100 + (demandByCity.get(c.city) || 0),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);
}

export default function MarketSection({ market, overview, loading, error, onRetry, onResetFilters }) {
  const [expandedCity, setExpandedCity] = useState(null);

  const byCountry = useMemo(() => (market ? aggregateByCountry(market.cities) : []), [market]);
  const cachedCities = useMemo(() => (market ? market.cities.filter((c) => c.cached).sort((a, b) => b.soldOut - a.soldOut) : []), [market]);
  const totalSoldOut = useMemo(() => cachedCities.reduce((sum, c) => sum + c.soldOut, 0), [cachedCities]);
  const opportunities = useMemo(() => (market ? rankOpportunity(market.cities, overview?.byCity) : []), [market, overview]);

  if (loading) {
    return (
      <div className="insight-section">
        <ChartSkeleton />
        <ChartSkeleton height={200} />
      </div>
    );
  }
  if (error) return <ErrorState onRetry={onRetry} />;
  if (!market) return <EmptyState onReset={onResetFilters} />;

  return (
    <div className="insight-section">
      <div className="insight-section-intro">
        <h2>Market Intelligence</h2>
        <p>Where demand is strongest — sold-out vs. available inventory across IVYHUTS' active markets.</p>
        <p className="insight-coverage-note">
          {market.crawlProgress?.complete ? (
            <>
              Full catalog counted — {totalSoldOut.toLocaleString()} sold-out across {market.coverage.citiesWithData} real
              markets, reconciled against the homepage's site-wide Sold Out figure
              {market.siteWide?.ready ? ` (${market.siteWide.soldOut.toLocaleString()})` : ""}.
            </>
          ) : (
            <>
              Counting Amber's full catalog — {(market.crawlProgress?.soldOutFetched ?? 0).toLocaleString()}
              {market.crawlProgress?.soldOutExpected != null ? ` of ${market.crawlProgress.soldOutExpected.toLocaleString()}` : ""} sold-out
              and {(market.crawlProgress?.availableFetched ?? 0).toLocaleString()}
              {market.crawlProgress?.availableExpected != null ? ` of ${market.crawlProgress.availableExpected.toLocaleString()}` : ""} available
              properties counted so far ({totalSoldOut.toLocaleString()} sold-out across {market.coverage.citiesWithData} real markets
              found so far). This continues automatically in the background and will reach the homepage's exact total (
              {market.siteWide?.ready ? market.siteWide.soldOut.toLocaleString() : "…"}) once the crawl completes, in a
              few minutes.
            </>
          )}
        </p>
      </div>

      <div className="insight-card-grid-2">
        <div className="insight-card">
          <h3>Top Countries — Sold-Out vs. Available</h3>
          <BarList
            data={byCountry}
            valueKey="value"
            secondaryKey="secondary"
            labelKey="label"
            color={CHART_COLORS.purple}
            secondaryColor={CHART_COLORS.blue}
            legendLabel="Sold Out"
            secondaryLegendLabel="Available"
          />
        </div>
        <div className="insight-card">
          <h3>Market Share (Sold-Out Units)</h3>
          <BarList
            data={cachedCities.slice(0, 8).map((c) => ({
              label: c.city,
              sublabel: c.country,
              value: c.soldOut,
              id: c.city,
            }))}
            color={CHART_COLORS.purple}
            formatValue={(v) => `${v} (${totalSoldOut ? Math.round((v / totalSoldOut) * 100) : 0}%)`}
          />
        </div>
      </div>

      <div className="insight-card">
        <h3>Top Demand Markets</h3>
        <p className="insight-card-sub">
          Sold-Out and Available counts are exact (Amber's own filtered totals, the same method the homepage's Sold Out
          counter uses). Click a city for up to 4 sample properties (locality &amp; pincode).
        </p>
        <div className="insight-table-scroll">
          <table className="insight-table">
            <thead>
              <tr>
                <th>Rank</th>
                <th>Country</th>
                <th>City</th>
                <th>Sold-Out</th>
                <th>Available</th>
                <th>Market Share</th>
                <th>Avg. Asking Price</th>
              </tr>
            </thead>
            <tbody>
              {cachedCities.map((c, i) => (
                <React.Fragment key={c.city}>
                  <tr className={i === 0 ? "insight-table-row-top" : ""} onClick={() => setExpandedCity(expandedCity === c.city ? null : c.city)}>
                    <td>{i + 1}</td>
                    <td>{c.country}</td>
                    <td className="insight-table-expand-cell">
                      {expandedCity === c.city ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      {c.city}
                    </td>
                    <td>{c.soldOut}</td>
                    <td>{c.available}</td>
                    <td>{totalSoldOut ? `${Math.round((c.soldOut / totalSoldOut) * 100)}%` : "—"}</td>
                    <td>{c.avgAskingPrice != null ? `${c.currency || ""}${c.avgAskingPrice.toLocaleString()}` : "—"}</td>
                  </tr>
                  {expandedCity === c.city && (
                    <tr className="insight-table-drilldown-row">
                      <td colSpan={7}>
                        <table className="insight-table insight-table-nested">
                          <thead>
                            <tr>
                              <th>Property</th>
                              <th>Locality</th>
                              <th>Pincode</th>
                              <th>Status</th>
                              <th>Asking Price</th>
                            </tr>
                          </thead>
                          <tbody>
                            {c.properties.slice(0, 25).map((p) => (
                              <tr key={p.id || p.slug}>
                                <td>{p.name}</td>
                                <td>{p.locality || "—"}</td>
                                <td>{p.pincode || "—"}</td>
                                <td>
                                  <span className={`insight-status-pill ${p.available ? "available" : "sold-out"}`}>
                                    {p.available ? "Available" : "Sold Out"}
                                  </span>
                                </td>
                                <td>{p.minPrice != null ? `${p.currency || ""}${p.minPrice.toLocaleString()}` : "—"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="insight-card">
        <h3>Next-Year Opportunity</h3>
        <p className="insight-card-sub">
          Markets showing the strongest sold-out demand — ranked by real sold-out rate + enquiry/lead volume, underlying
          numbers shown, not an AI score.
        </p>
        <ol className="insight-opportunity-list">
          {opportunities.map((c, i) => (
            <li key={c.city}>
              <span className="insight-opportunity-rank">#{i + 1}</span>
              <div className="insight-opportunity-body">
                <strong>
                  {c.city}, {c.country}
                </strong>
                <div className="insight-opportunity-metrics">
                  <span>Sold-Out: {c.soldOut}</span>
                  <span>Sold-Out Rate: {Math.round(c.soldOutRate * 100)}%</span>
                  <span>Avg. Asking Price: {c.avgAskingPrice != null ? `${c.currency || ""}${c.avgAskingPrice.toLocaleString()}` : "—"}</span>
                  <span>Enquiries/Leads (period): {c.demandSignal}</span>
                </div>
                {i === 0 && <span className="insight-priority-badge">Priority opportunity</span>}
              </div>
            </li>
          ))}
        </ol>
        {opportunities.length === 0 && <p className="insight-chart-empty">Not enough cached market data yet to rank opportunities.</p>}
      </div>
    </div>
  );
}
