import React, { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Building2, CheckCircle2, XCircle, PieChart } from "lucide-react";
import KpiCard from "../KpiCard";
import DataUnavailableCard from "../DataUnavailableCard";
import BarList from "../charts/BarList";
import { ChartSkeleton } from "../SkeletonBlocks";
import ErrorState, { EmptyState } from "../ErrorState";
import { CHART_COLORS } from "../../insightPalette";

const SHARE_DIMENSIONS = [
  { key: "country", label: "Country" },
  { key: "city", label: "City" },
  { key: "postcode", label: "Postcode" },
  { key: "property", label: "Property" },
];

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

function pct(fraction) {
  return fraction == null ? "—" : `${(fraction * 100).toFixed(1)}%`;
}

// Only ever renders a delta when both real numbers are present — never a
// fabricated trend arrow (spec §15's "Comparison unavailable" rule).
function DeltaBadge({ current, previous, invert = false, formatter }) {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
  const delta = current - previous;
  const fmt = formatter || ((v) => Math.abs(v).toLocaleString());
  if (delta === 0) return <span className="insight-delta insight-delta-flat">→ unchanged</span>;
  const up = delta > 0;
  const good = invert ? !up : up;
  return (
    <span className={`insight-delta ${good ? "insight-delta-up" : "insight-delta-down"}`}>
      {up ? "↑" : "↓"} {up ? "+" : "-"}
      {fmt(delta)}
    </span>
  );
}

// The main/default tab — Executive Overview + Market Share + Geographic
// breakdown (country/city/postcode) + Historical Comparison + Data & Cache
// Status all live here (folded in from a since-removed standalone Overview
// tab) alongside the original country/city/opportunity content.
export default function MarketSection({ market, overview, loading, error, onRetry, onResetFilters }) {
  const [expandedCity, setExpandedCity] = useState(null);
  const [shareDimension, setShareDimension] = useState("country");

  const byCountry = useMemo(() => (market ? aggregateByCountry(market.cities) : []), [market]);
  const cachedCities = useMemo(() => (market ? market.cities.filter((c) => c.cached).sort((a, b) => b.soldOut - a.soldOut) : []), [market]);
  // Items the breakdown crawl has counted so far — NOT the same as the
  // authoritative site-wide sold-out figure used in the KPI cards below
  // (see api/_lib/insightsMarket.js's buildFullBreakdown). Used only as the
  // denominator for "share of counted-so-far" percentages in this section.
  const crawlSoldOutCounted = useMemo(() => cachedCities.reduce((sum, c) => sum + c.soldOut, 0), [cachedCities]);
  const opportunities = useMemo(() => (market ? rankOpportunity(market.cities, overview?.byCity) : []), [market, overview]);

  const shareData = useMemo(() => {
    if (!market) return [];
    if (shareDimension === "country") return (market.countries || []).slice(0, 10).map((c) => ({ label: c.country, value: c.soldOut, id: c.country }));
    if (shareDimension === "city") return cachedCities.slice(0, 10).map((c) => ({ label: c.city, sublabel: c.country, value: c.soldOut, id: c.city }));
    if (shareDimension === "postcode") return (market.postcodes || []).slice(0, 10).map((p) => ({ label: p.postcode, sublabel: p.city, value: p.soldOut, id: p.postcode }));
    return (market.properties || []).slice(0, 10).map((p) => ({ label: p.name, sublabel: p.city, value: p.minPrice ?? 0, id: p.id || p.slug }));
  }, [market, shareDimension, cachedCities]);

  if (loading) {
    return (
      <div className="insight-section">
        <div className="insight-kpi-grid">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="insight-skeleton insight-skeleton-kpi" />
          ))}
        </div>
        <ChartSkeleton />
        <ChartSkeleton height={200} />
      </div>
    );
  }
  if (error) return <ErrorState onRetry={onRetry} />;
  if (!market) return <EmptyState onReset={onResetFilters} />;
  if (market.available === false) {
    return (
      <div className="insight-section">
        <EmptyState message={`No snapshot was stored for ${market.date} — this date predates the daily snapshot system, or the job hasn't run yet.`} onReset={onResetFilters} />
      </div>
    );
  }

  const totalInventory = market.totalInventory ?? 0;
  const soldOut = market.soldOutInventory ?? 0;
  const available = market.availableInventory ?? 0;
  const soldOutFraction = market.soldOutPercentage != null ? market.soldOutPercentage / 100 : null;
  const previous = market.comparison?.previous;
  const sevenDayAvg = market.comparison?.sevenDayAvg;

  return (
    <div className="insight-section">
      <div className="insight-section-intro">
        <h2>Market Intelligence</h2>
        <p>Where demand is strongest — sold-out vs. available inventory across IVYHUTS' active markets.</p>
        <p className="insight-coverage-note">
          {market.crawlProgress?.complete ? (
            <>
              Full catalog counted — {crawlSoldOutCounted.toLocaleString()} sold-out across {market.coverage.citiesWithData} real
              markets, reconciled against the homepage's site-wide Sold Out figure
              {market.siteWide?.ready ? ` (${market.siteWide.soldOut.toLocaleString()})` : ""}.
            </>
          ) : (
            <>
              Headline totals above are the exact site-wide figures. The country/city/postcode breakdown below is still
              filling in — {(market.crawlProgress?.soldOutFetched ?? 0).toLocaleString()}
              {market.crawlProgress?.soldOutExpected != null ? ` of ${market.crawlProgress.soldOutExpected.toLocaleString()}` : ""} sold-out
              and {(market.crawlProgress?.availableFetched ?? 0).toLocaleString()}
              {market.crawlProgress?.availableExpected != null ? ` of ${market.crawlProgress.availableExpected.toLocaleString()}` : ""} available
              properties counted so far. This continues automatically in the background.
            </>
          )}
        </p>
      </div>

      <div className="insight-kpi-grid">
        <KpiCard icon={<Building2 size={18} />} label="Total Inventory" value={totalInventory.toLocaleString()} />
        <KpiCard icon={<CheckCircle2 size={18} />} label="Available" value={available.toLocaleString()} />
        <KpiCard icon={<XCircle size={18} />} label="Sold Out" value={soldOut.toLocaleString()} />
        <KpiCard icon={<PieChart size={18} />} label="Sold Out %" value={pct(soldOutFraction)} />
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
          <div className="insight-table-toolbar">
            <h3 style={{ margin: 0 }}>Market Share — Sold-Out Inventory</h3>
            <div className="insight-dimension-switch">
              {SHARE_DIMENSIONS.map((d) => (
                <button key={d.key} type="button" className={shareDimension === d.key ? "active" : ""} onClick={() => setShareDimension(d.key)}>
                  {d.label}
                </button>
              ))}
            </div>
          </div>
          <BarList
            data={shareData}
            color={CHART_COLORS.purple}
            formatValue={(v) =>
              shareDimension === "property"
                ? `${market.pricing?.currency || ""}${v.toLocaleString()}`
                : `${v.toLocaleString()} (${crawlSoldOutCounted ? Math.round((v / crawlSoldOutCounted) * 100) : 0}%)`
            }
            emptyMessage={`No ${shareDimension} data available yet.`}
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
                    <td>{crawlSoldOutCounted ? `${Math.round((c.soldOut / crawlSoldOutCounted) * 100)}%` : "—"}</td>
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
        <h3>Top Postcodes</h3>
        {(market.postcodes || []).length === 0 ? (
          <DataUnavailableCard label="Postcode Breakdown" reason="No reliable postcode data has been captured yet for this date." />
        ) : (
          <div className="insight-table-scroll">
            <table className="insight-table">
              <thead>
                <tr>
                  <th>Rank</th>
                  <th>Postcode</th>
                  <th>City</th>
                  <th>Sold-Out</th>
                  <th>Share</th>
                </tr>
              </thead>
              <tbody>
                {market.postcodes.slice(0, 15).map((p) => (
                  <tr key={p.postcode}>
                    <td>{p.rank}</td>
                    <td>{p.postcode}</td>
                    <td>{p.city}</td>
                    <td>{p.soldOut.toLocaleString()}</td>
                    <td>{pct(p.soldOutShare)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
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

      <div className="insight-card">
        <h3>Historical Comparison</h3>
        {!previous ? (
          <p className="insight-chart-empty">Comparison unavailable — no prior snapshot exists yet.</p>
        ) : (
          <>
            <p className="insight-card-sub">vs. previous snapshot ({previous.date})</p>
            <div className="insight-comparison-grid">
              <div className="insight-comparison-item">
                <span className="insight-comparison-label">Total Inventory</span>
                <span className="insight-comparison-value">{totalInventory.toLocaleString()}</span>
                <DeltaBadge current={totalInventory} previous={previous.totalInventory} />
              </div>
              <div className="insight-comparison-item">
                <span className="insight-comparison-label">Sold Out</span>
                <span className="insight-comparison-value">{soldOut.toLocaleString()}</span>
                <DeltaBadge current={soldOut} previous={previous.soldOutInventory} />
              </div>
              <div className="insight-comparison-item">
                <span className="insight-comparison-label">Available</span>
                <span className="insight-comparison-value">{available.toLocaleString()}</span>
                <DeltaBadge current={available} previous={previous.availableInventory} invert />
              </div>
              {market.pricing?.average != null && previous.pricing?.average != null && (
                <div className="insight-comparison-item">
                  <span className="insight-comparison-label">Avg. Asking Price (Sold-Out)</span>
                  <span className="insight-comparison-value">
                    {market.pricing.currency}
                    {market.pricing.average.toLocaleString()}
                  </span>
                  <DeltaBadge
                    current={market.pricing.average}
                    previous={previous.pricing.average}
                    formatter={(v) => `${market.pricing.currency || ""}${Math.abs(v).toLocaleString()}`}
                  />
                </div>
              )}
            </div>
            {sevenDayAvg && (
              <p className="insight-card-sub" style={{ marginTop: 14 }}>
                7-day average ({sevenDayAvg.sampleSize} day{sevenDayAvg.sampleSize === 1 ? "" : "s"} of history):{" "}
                {sevenDayAvg.soldOutInventory != null ? sevenDayAvg.soldOutInventory.toLocaleString() : "—"} sold out,{" "}
                {sevenDayAvg.soldOutPercentage != null ? `${sevenDayAvg.soldOutPercentage}%` : "—"} sold-out rate.
              </p>
            )}
          </>
        )}
      </div>

      <div className="insight-card">
        <h3>Data &amp; Cache Status</h3>
        <dl className="insight-datastatus">
          <div>
            <dt>Source</dt>
            <dd>Amber</dd>
          </div>
          <div>
            <dt>Mode</dt>
            <dd>{market.mode === "live" ? "Live" : "Historical Snapshot"}</dd>
          </div>
          <div>
            <dt>Cache Status</dt>
            <dd>{market.crawlProgress?.complete ? "Fresh — full catalog crawl complete" : "Partial — catalog crawl still in progress"}</dd>
          </div>
          <div>
            <dt>Records Processed</dt>
            <dd>
              {(market.coverage?.itemsCounted ?? 0).toLocaleString()}
              {market.coverage?.itemsExpected != null ? ` of ${market.coverage.itemsExpected.toLocaleString()}` : ""}
            </dd>
          </div>
          <div>
            <dt>Sold-Out Records</dt>
            <dd>{soldOut.toLocaleString()}</dd>
          </div>
          {market.mode === "historical" && (
            <>
              <div>
                <dt>Snapshot Date</dt>
                <dd>{market.date}</dd>
              </div>
              <div>
                <dt>Generated At</dt>
                <dd>{market.generatedAt ? `${new Date(market.generatedAt).toLocaleString("en-GB", { timeZone: "Asia/Kolkata" })} IST` : "—"}</dd>
              </div>
              <div>
                <dt>Email Report</dt>
                <dd>{market.email?.sent ? "Sent" : market.email?.error ? "Failed" : "Not sent"}</dd>
              </div>
            </>
          )}
        </dl>
      </div>
    </div>
  );
}
