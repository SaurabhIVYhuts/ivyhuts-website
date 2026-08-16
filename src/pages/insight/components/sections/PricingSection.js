import React, { useMemo } from "react";
import { Tag, ArrowDownCircle, ArrowUpCircle } from "lucide-react";
import KpiCard from "../KpiCard";
import DataUnavailableCard from "../DataUnavailableCard";
import BarList from "../charts/BarList";
import { ChartSkeleton } from "../SkeletonBlocks";
import ErrorState, { EmptyState } from "../ErrorState";
import { CHART_COLORS } from "../../insightPalette";

// Real Amber data spans many currencies (£/€/$/AED/... — see
// insightsMarket.js's CURRENCY_SYMBOLS) — averaging raw numbers across them
// produces a meaningless blended figure (audit fix: this used to sum every
// currency together and label the result with whichever symbol the FIRST
// priced property happened to have). Scoped to whichever currency has the
// most samples instead of guessing an FX rate this codebase has no source
// for — sampleSize/totalPriced/mixedCurrencies make that scoping honest
// rather than silent.
function aggregatePrices(cities) {
  const allProps = cities.filter((c) => c.cached).flatMap((c) => c.properties);
  const priced = allProps.filter((p) => Number.isFinite(p.minPrice) && p.currency);
  if (!priced.length) return { avg: null, min: null, max: null, currency: "", sampleSize: 0, totalPriced: 0, mixedCurrencies: false };

  const byCurrency = new Map();
  for (const p of priced) {
    if (!byCurrency.has(p.currency)) byCurrency.set(p.currency, []);
    byCurrency.get(p.currency).push(p);
  }
  const [currency, dominant] = [...byCurrency.entries()].sort((a, b) => b[1].length - a[1].length)[0];

  return {
    avg: Math.round(dominant.reduce((s, p) => s + p.minPrice, 0) / dominant.length),
    min: Math.min(...dominant.map((p) => p.minPrice)),
    max: Math.max(...dominant.map((p) => p.minPrice)),
    currency,
    sampleSize: dominant.length,
    totalPriced: priced.length,
    mixedCurrencies: byCurrency.size > 1,
  };
}

// Grouped by country/city (in practice single-currency per real-world
// market), but each group keeps its OWN currency rather than assuming the
// caller's global `stats.currency` applies — audit fix: the by-country/
// by-city bar charts previously labeled every bar with one arbitrary global
// currency symbol regardless of which market it actually was (e.g. a German
// bar showing "£450" because the first cached property overall happened to
// be priced in pounds).
function avgPriceByKey(cities, keyFn) {
  const groups = new Map();
  for (const c of cities.filter((c) => c.cached)) {
    for (const p of c.properties) {
      if (!Number.isFinite(p.minPrice)) continue;
      const key = keyFn(p, c);
      if (!key) continue;
      const g = groups.get(key) || { label: key, sum: 0, count: 0, currency: p.currency || "" };
      g.sum += p.minPrice;
      g.count += 1;
      groups.set(key, g);
    }
  }
  return Array.from(groups.values())
    .map((g) => ({ label: g.label, value: Math.round(g.sum / g.count), currency: g.currency }))
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
        <KpiCard
          icon={<Tag size={18} />}
          label="Average Asking Price"
          value={stats.avg != null ? `${stats.currency}${stats.avg.toLocaleString()}` : "—"}
          description={
            stats.mixedCurrencies
              ? `n=${stats.sampleSize} ${stats.currency} properties (of ${stats.totalPriced} cached total — other currencies excluded, not blended)`
              : `n=${stats.sampleSize} cached properties`
          }
        />
        <KpiCard icon={<ArrowDownCircle size={18} />} label="Minimum Asking Price" value={stats.min != null ? `${stats.currency}${stats.min.toLocaleString()}` : "—"} />
        <KpiCard icon={<ArrowUpCircle size={18} />} label="Maximum Asking Price" value={stats.max != null ? `${stats.currency}${stats.max.toLocaleString()}` : "—"} />
        <DataUnavailableCard label="Average Discount / Booked vs. Listed" reason="Booked price is not currently captured — discount % cannot be computed." />
      </div>

      <div className="insight-card-grid-2">
        <div className="insight-card">
          <h3>Average Asking Price by Country</h3>
          <BarList data={byCountry} color={CHART_COLORS.gold} formatValue={(v, row) => `${row?.currency || stats.currency}${v.toLocaleString()}`} />
        </div>
        <div className="insight-card">
          <h3>Average Asking Price by City</h3>
          <BarList data={byCity} color={CHART_COLORS.gold} formatValue={(v, row) => `${row?.currency || stats.currency}${v.toLocaleString()}`} />
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
