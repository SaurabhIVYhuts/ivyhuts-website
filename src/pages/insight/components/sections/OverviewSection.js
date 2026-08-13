import React, { useMemo, useState } from "react";
import { Building2, CheckCircle2, XCircle, PieChart } from "lucide-react";
import KpiCard from "../KpiCard";
import DataUnavailableCard from "../DataUnavailableCard";
import BarList from "../charts/BarList";
import { ChartSkeleton, TableSkeleton } from "../SkeletonBlocks";
import ErrorState, { EmptyState } from "../ErrorState";
import { CHART_COLORS } from "../../insightPalette";

const SHARE_DIMENSIONS = [
  { key: "country", label: "Country" },
  { key: "city", label: "City" },
  { key: "postcode", label: "Postcode" },
  { key: "property", label: "Property" },
];

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

// Primary feed for Sections 1, 2, 3, 4 (partial), 7 and 8 of the /insight
// spec — Executive Overview, Market Share, Geographic Intelligence,
// Historical Comparison, and Data & Cache Status. `data` is
// /api/insights/snapshot's response (live or historical — same shape).
export default function OverviewSection({ data, loading, error, onRetry, onResetFilters }) {
  const [shareDimension, setShareDimension] = useState("country");

  const shareData = useMemo(() => {
    if (!data) return [];
    if (shareDimension === "country") return (data.countries || []).slice(0, 10).map((c) => ({ label: c.country, value: c.soldOut, id: c.country }));
    if (shareDimension === "city") return (data.cities || []).slice(0, 10).map((c) => ({ label: c.city, sublabel: c.country, value: c.soldOut, id: c.city }));
    if (shareDimension === "postcode") return (data.postcodes || []).slice(0, 10).map((p) => ({ label: p.postcode, sublabel: p.city, value: p.soldOut, id: p.postcode }));
    return (data.properties || [])
      .slice(0, 10)
      .map((p) => ({ label: p.name, sublabel: p.city, value: p.minPrice ?? 0, id: p.id || p.slug }));
  }, [data, shareDimension]);

  if (loading) {
    return (
      <div className="insight-section">
        <div className="insight-kpi-grid">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="insight-skeleton insight-skeleton-kpi" />
          ))}
        </div>
        <ChartSkeleton />
        <TableSkeleton rows={6} />
      </div>
    );
  }
  if (error) return <ErrorState onRetry={onRetry} />;
  if (!data) return <EmptyState onReset={onResetFilters} />;
  if (data.available === false) {
    return (
      <div className="insight-section">
        <EmptyState message={`No snapshot was stored for ${data.date} — this date predates the daily snapshot system, or the job hasn't run yet.`} onReset={onResetFilters} />
      </div>
    );
  }

  const totalInventory = data.totalInventory ?? (data.totalSoldOut ?? 0) + (data.totalAvailable ?? 0);
  const soldOut = data.soldOutInventory ?? data.totalSoldOut ?? 0;
  const available = data.availableInventory ?? data.totalAvailable ?? 0;
  const soldOutFraction = data.soldOutPercentage != null ? data.soldOutPercentage / 100 : null;

  const previous = data.comparison?.previous;
  const sevenDayAvg = data.comparison?.sevenDayAvg;

  return (
    <div className="insight-section">
      <div className="insight-section-intro">
        <h2>Executive Overview</h2>
        <p>Sold-out market intelligence across every property Amber's full catalog crawl has counted.</p>
      </div>

      <div className="insight-kpi-grid">
        <KpiCard icon={<Building2 size={18} />} label="Total Inventory" value={totalInventory.toLocaleString()} />
        <KpiCard icon={<CheckCircle2 size={18} />} label="Available" value={available.toLocaleString()} />
        <KpiCard icon={<XCircle size={18} />} label="Sold Out" value={soldOut.toLocaleString()} />
        <KpiCard icon={<PieChart size={18} />} label="Sold Out %" value={pct(soldOutFraction)} />
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
            shareDimension === "property" ? `${data.pricing?.currency || ""}${v.toLocaleString()}` : `${v.toLocaleString()} (${soldOut ? Math.round((v / soldOut) * 100) : 0}%)`
          }
          emptyMessage={`No ${shareDimension} data available yet.`}
        />
      </div>

      <div className="insight-card-grid-2">
        <div className="insight-card">
          <h3>Top Countries</h3>
          <div className="insight-table-scroll">
            <table className="insight-table">
              <thead>
                <tr>
                  <th>Rank</th>
                  <th>Country</th>
                  <th>Sold-Out</th>
                  <th>Share</th>
                </tr>
              </thead>
              <tbody>
                {(data.countries || []).slice(0, 10).map((c) => (
                  <tr key={c.country}>
                    <td>{c.rank}</td>
                    <td>{c.country}</td>
                    <td>{c.soldOut.toLocaleString()}</td>
                    <td>{pct(c.soldOutShare)}</td>
                  </tr>
                ))}
                {(data.countries || []).length === 0 && (
                  <tr>
                    <td colSpan={4} className="insight-chart-empty">
                      No country data yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
        <div className="insight-card">
          <h3>Top Cities</h3>
          <div className="insight-table-scroll">
            <table className="insight-table">
              <thead>
                <tr>
                  <th>Rank</th>
                  <th>City</th>
                  <th>Sold-Out</th>
                  <th>Share</th>
                </tr>
              </thead>
              <tbody>
                {(data.cities || []).slice(0, 10).map((c, i) => (
                  <tr key={c.city}>
                    <td>{i + 1}</td>
                    <td>{c.city}</td>
                    <td>{c.soldOut.toLocaleString()}</td>
                    <td>{soldOut ? pct(c.soldOut / soldOut) : "—"}</td>
                  </tr>
                ))}
                {(data.cities || []).length === 0 && (
                  <tr>
                    <td colSpan={4} className="insight-chart-empty">
                      No city data yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="insight-card">
        <h3>Top Postcodes</h3>
        {(data.postcodes || []).length === 0 ? (
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
                {data.postcodes.slice(0, 15).map((p) => (
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
              {data.pricing?.average != null && previous.pricing?.average != null && (
                <div className="insight-comparison-item">
                  <span className="insight-comparison-label">Avg. Asking Price (Sold-Out)</span>
                  <span className="insight-comparison-value">
                    {data.pricing.currency}
                    {data.pricing.average.toLocaleString()}
                  </span>
                  <DeltaBadge
                    current={data.pricing.average}
                    previous={previous.pricing.average}
                    formatter={(v) => `${data.pricing.currency || ""}${Math.abs(v).toLocaleString()}`}
                  />
                </div>
              )}
            </div>
            {sevenDayAvg && (
              <p className="insight-card-sub" style={{ marginTop: 14 }}>
                7-day average ({sevenDayAvg.sampleSize} day{sevenDayAvg.sampleSize === 1 ? "" : "s"} of history): {sevenDayAvg.soldOutInventory != null ? sevenDayAvg.soldOutInventory.toLocaleString() : "—"} sold
                out, {sevenDayAvg.soldOutPercentage != null ? `${sevenDayAvg.soldOutPercentage}%` : "—"} sold-out rate.
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
            <dd>{data.mode === "live" ? "Live" : "Historical Snapshot"}</dd>
          </div>
          <div>
            <dt>Cache Status</dt>
            <dd>{data.crawlProgress?.complete ? "Fresh — full catalog crawl complete" : "Partial — catalog crawl still in progress"}</dd>
          </div>
          <div>
            <dt>Records Processed</dt>
            <dd>
              {(data.coverage?.itemsCounted ?? 0).toLocaleString()}
              {data.coverage?.itemsExpected != null ? ` of ${data.coverage.itemsExpected.toLocaleString()}` : ""}
            </dd>
          </div>
          <div>
            <dt>Sold-Out Records</dt>
            <dd>{soldOut.toLocaleString()}</dd>
          </div>
          {data.mode === "historical" && (
            <>
              <div>
                <dt>Snapshot Date</dt>
                <dd>{data.date}</dd>
              </div>
              <div>
                <dt>Generated At</dt>
                <dd>{data.generatedAt ? `${new Date(data.generatedAt).toLocaleString("en-GB", { timeZone: "Asia/Kolkata" })} IST` : "—"}</dd>
              </div>
              <div>
                <dt>Email Report</dt>
                <dd>{data.email?.sent ? "Sent" : data.email?.error ? "Failed" : "Not sent"}</dd>
              </div>
            </>
          )}
        </dl>
      </div>
    </div>
  );
}
