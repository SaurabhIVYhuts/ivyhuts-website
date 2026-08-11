import React, { useMemo } from "react";
import { Tag, ArrowDownCircle, ArrowUpCircle } from "lucide-react";
import KpiCard from "../KpiCard";
import DataUnavailableCard from "../DataUnavailableCard";
import BarList from "../charts/BarList";
import { ChartSkeleton } from "../SkeletonBlocks";
import ErrorState, { EmptyState } from "../ErrorState";
import { CHART_COLORS } from "../../insightPalette";

function aggregatePrices(cities) {
  const allProps = cities.filter((c) => c.cached).flatMap((c) => c.properties);
  const priced = allProps.filter((p) => Number.isFinite(p.minPrice));
  const currency = priced.find((p) => p.currency)?.currency || "";
  const avg = priced.length ? Math.round(priced.reduce((s, p) => s + p.minPrice, 0) / priced.length) : null;
  const min = priced.length ? Math.min(...priced.map((p) => p.minPrice)) : null;
  const max = priced.length ? Math.max(...priced.map((p) => p.minPrice)) : null;
  return { avg, min, max, currency, sampleSize: priced.length };
}

function avgPriceByKey(cities, keyFn) {
  const groups = new Map();
  for (const c of cities.filter((c) => c.cached)) {
    for (const p of c.properties) {
      if (!Number.isFinite(p.minPrice)) continue;
      const key = keyFn(p, c);
      if (!key) continue;
      const g = groups.get(key) || { label: key, sum: 0, count: 0 };
      g.sum += p.minPrice;
      g.count += 1;
      groups.set(key, g);
    }
  }
  return Array.from(groups.values())
    .map((g) => ({ label: g.label, value: Math.round(g.sum / g.count) }))
    .sort((a, b) => b.value - a.value);
}

export default function PricingSection({ market, loading, error, onRetry, onResetFilters }) {
  const stats = useMemo(() => (market ? aggregatePrices(market.cities) : null), [market]);
  const byCountry = useMemo(() => (market ? avgPriceByKey(market.cities, (p, c) => c.country) : []), [market]);
  const byCity = useMemo(() => (market ? avgPriceByKey(market.cities, (p, c) => c.city).slice(0, 10) : []), [market]);
  const priceVsDemand = useMemo(
    () =>
      market
        ? market.cities
            .filter((c) => c.cached && c.total > 0 && c.avgAskingPrice != null)
            .map((c) => ({ city: c.city, avgAskingPrice: c.avgAskingPrice, soldOutRate: c.soldOutRate, currency: c.currency }))
            .sort((a, b) => b.soldOutRate - a.soldOutRate)
            .slice(0, 10)
        : [],
    [market]
  );

  if (loading) {
    return (
      <div className="insight-section">
        <ChartSkeleton height={140} />
        <ChartSkeleton />
      </div>
    );
  }
  if (error) return <ErrorState onRetry={onRetry} />;
  if (!market) return <EmptyState onReset={onResetFilters} />;

  return (
    <div className="insight-section">
      <div className="insight-section-intro">
        <h2>Price Intelligence</h2>
        <p>
          Based on live Amber <strong>asking</strong> prices for cached properties — not booked/transaction prices, which
          IVYHUTS does not currently capture.
        </p>
      </div>

      <div className="insight-kpi-grid">
        <KpiCard icon={<Tag size={18} />} label="Average Asking Price" value={stats.avg != null ? `${stats.currency}${stats.avg.toLocaleString()}` : "—"} description={`n=${stats.sampleSize} cached properties`} />
        <KpiCard icon={<ArrowDownCircle size={18} />} label="Minimum Asking Price" value={stats.min != null ? `${stats.currency}${stats.min.toLocaleString()}` : "—"} />
        <KpiCard icon={<ArrowUpCircle size={18} />} label="Maximum Asking Price" value={stats.max != null ? `${stats.currency}${stats.max.toLocaleString()}` : "—"} />
        <DataUnavailableCard label="Average Discount / Booked vs. Listed" reason="Booked price is not currently captured — discount % cannot be computed." />
      </div>

      <div className="insight-card-grid-2">
        <div className="insight-card">
          <h3>Average Asking Price by Country</h3>
          <BarList data={byCountry} color={CHART_COLORS.gold} formatValue={(v) => `${stats.currency}${v.toLocaleString()}`} />
        </div>
        <div className="insight-card">
          <h3>Average Asking Price by City</h3>
          <BarList data={byCity} color={CHART_COLORS.gold} formatValue={(v) => `${stats.currency}${v.toLocaleString()}`} />
        </div>
      </div>

      <div className="insight-card">
        <h3>Price vs. Demand</h3>
        <p className="insight-card-sub">Asking price against sold-out rate (a real demand proxy) — cities ranked by demand.</p>
        <div className="insight-table-scroll">
          <table className="insight-table">
            <thead>
              <tr>
                <th>City</th>
                <th>Sold-Out Rate</th>
                <th>Avg. Asking Price</th>
              </tr>
            </thead>
            <tbody>
              {priceVsDemand.map((c) => (
                <tr key={c.city}>
                  <td>{c.city}</td>
                  <td>{Math.round(c.soldOutRate * 100)}%</td>
                  <td>
                    {c.currency}
                    {c.avgAskingPrice.toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
