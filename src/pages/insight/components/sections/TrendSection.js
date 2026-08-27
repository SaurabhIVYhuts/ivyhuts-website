import React, { useMemo, useState } from "react";
import BreakdownHeatmap from "../charts/BreakdownHeatmap";
import BarList from "../charts/BarList";
import TrendBarChart from "../charts/TrendBarChart";
import TrendLineChart from "../charts/TrendLineChart";
import { ChartSkeleton } from "../SkeletonBlocks";
import ErrorState, { EmptyState } from "../ErrorState";
import { CHART_COLORS } from "../../insightPalette";

const GRANULARITIES = [
  { key: "month", label: "Month" },
  { key: "day", label: "Day" },
];
const DIMENSIONS = [
  { key: "country", label: "Country" },
  { key: "city", label: "City" },
];
// Two views of the exact same ranked breakdown data — heatmap (sequential
// magnitude, the dataviz skill's own alternative to a bar form, good for
// scanning many places at once) and a plain bar chart (better for precise
// side-by-side length comparison of a shorter list). Same data either way,
// never a second source of truth.
const BREAKDOWN_VIEWS = [
  { key: "heatmap", label: "Heatmap" },
  { key: "bar", label: "Bar Chart" },
];

// Default caps the ranked list to a short "headline" view (matches the cap
// MarketSection already uses for its own ranked lists), but the dropdown
// below lets a reader who genuinely wants every place expand past it —
// "all" never re-sorts, it just stops slicing.
const BREAKDOWN_LIMIT_OPTIONS = [
  { key: "10", label: "Top 10" },
  { key: "25", label: "Top 25" },
  { key: "all", label: "All" },
];

// Latest-per-month rollup of the daily series — same "skip failed runs, keep
// the latest stored day within the month" rule the sold-out-trend endpoint
// used to apply server-side, now computed here so day and month views always
// share the exact same fetch and can never disagree with each other.
function rollUpByMonth(days) {
  const byMonth = new Map();
  for (const d of days) {
    byMonth.set(d.date.slice(0, 7), d); // ascending input -> last write wins
  }
  return Array.from(byMonth.entries()).map(([month, d]) => ({
    key: month,
    totalSoldOut: d.totalSoldOut,
    countries: d.countries,
    cities: d.cities,
    unresolvedCountrySoldOut: d.unresolvedCountrySoldOut,
    unresolvedCitySoldOut: d.unresolvedCitySoldOut,
  }));
}

// Dedicated section for "which month/day sold the most, and where" — split
// out of Market Intelligence into its own sidebar tab since it answers a
// different question (a history-over-time view) than that tab's
// point-in-time market snapshot.
export default function TrendSection({ trend, error, onRetry, onResetFilters }) {
  // Defaults to Day rather than Month: with under a full calendar month of
  // snapshot history so far, Month view is currently always exactly one
  // bar — Day already has every real point sitting there. Once there's a
  // few months of history both views are equally reasonable; this is a
  // one-click toggle either way.
  const [granularity, setGranularity] = useState("day");
  const [dimension, setDimension] = useState("country");
  const [selectedKey, setSelectedKey] = useState(null);
  const [breakdownLimit, setBreakdownLimit] = useState("10");
  const [breakdownView, setBreakdownView] = useState("heatmap");
  // null = "All" (top-N ranking + breakdown panel, the default view). Set to
  // a specific country name, or a "city||country" composite key (city names
  // collide across countries — e.g. two real "London"s in this data), to
  // drill the chart itself into just that one place's trend over time.
  const [focusKey, setFocusKey] = useState(null);

  const days = useMemo(() => trend?.days || [], [trend]);

  // Every distinct real country/city ever seen across the whole stored
  // history (not just the currently-active period) — "Unknown" is already
  // excluded server-side (sold-out-trend.js), so it can never appear here
  // either. Built from the raw days, not the (possibly month-rolled) points,
  // so a country/city that only shows up on one historical day still gets
  // listed. Ranked by total sold-out volume across all of history, not
  // alphabetically — the places someone actually wants to drill into (the
  // big markets) sit at the top of the dropdown instead of wherever their
  // name happens to fall in the alphabet.
  const allCountries = useMemo(() => {
    const totals = new Map();
    for (const d of days) for (const c of d.countries || []) if (c.country) totals.set(c.country, (totals.get(c.country) || 0) + (c.soldOut || 0));
    return Array.from(totals.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([country]) => country);
  }, [days]);
  const allCities = useMemo(() => {
    const totals = new Map(); // key -> { city, country, total }
    for (const d of days) {
      for (const c of d.cities || []) {
        if (!c.city) continue;
        const key = `${c.city}||${c.country || ""}`;
        const prev = totals.get(key) || { city: c.city, country: c.country || "", total: 0 };
        prev.total += c.soldOut || 0;
        totals.set(key, prev);
      }
    }
    return Array.from(totals.values()).sort((a, b) => b.total - a.total || a.city.localeCompare(b.city));
  }, [days]);

  const points = useMemo(() => {
    if (granularity === "day") {
      return days.map((d) => ({
        key: d.date,
        totalSoldOut: d.totalSoldOut,
        countries: d.countries,
        cities: d.cities,
        unresolvedCountrySoldOut: d.unresolvedCountrySoldOut,
        unresolvedCitySoldOut: d.unresolvedCitySoldOut,
      }));
    }
    return rollUpByMonth(days);
  }, [days, granularity]);

  // No point explicitly clicked yet — default the breakdown panel (and the
  // chart's "active" bar) to the highest point, since that's the headline
  // answer to "which month/day sold the most" the manager asked for.
  const defaultKey = useMemo(() => {
    if (points.length === 0) return null;
    return points.reduce((best, p) => ((p.totalSoldOut || 0) > (best?.totalSoldOut ?? -Infinity) ? p : best), null).key;
  }, [points]);
  const activeKey = selectedKey || defaultKey;
  const activeEntry = points.find((p) => p.key === activeKey) || null;
  // Sorted here, explicitly — the stored snapshot's array order isn't
  // guaranteed descending-by-soldOut (confirmed live: it wasn't), so
  // trusting it silently produced a visibly wrong ranking. Also: city names
  // collide across countries (a real "Sunderland" in more than one country
  // exists in this data, same issue MarketSection's Top Demand Markets table
  // already works around) — city rows get a country sublabel and a
  // country-qualified id so two same-named cities never look like a
  // duplicate row or collide on React key.
  const breakdownFull = useMemo(() => {
    const raw = activeEntry ? (dimension === "country" ? activeEntry.countries : activeEntry.cities) || [] : [];
    const sorted = [...raw].sort((a, b) => (b.soldOut || 0) - (a.soldOut || 0));
    if (dimension !== "city") return sorted;
    return sorted.map((c) => ({ ...c, sublabel: c.country, id: `${c.city}-${c.country}` }));
  }, [activeEntry, dimension]);
  const breakdownData = breakdownLimit === "all" ? breakdownFull : breakdownFull.slice(0, Number(breakdownLimit));

  const activeLabel = useMemo(() => {
    if (!activeEntry) return "";
    const d = new Date(granularity === "day" ? `${activeEntry.key}T00:00:00` : `${activeEntry.key}-01T00:00:00`);
    return granularity === "day"
      ? d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })
      : d.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
  }, [activeEntry, granularity]);

  // Human label for the dropdown's current selection — a plain country name,
  // or "City, Country" for the composite city key.
  const focusLabel = useMemo(() => {
    if (!focusKey) return "";
    if (dimension === "country") return focusKey;
    const [city, country] = focusKey.split("||");
    return country ? `${city}, ${country}` : city;
  }, [focusKey, dimension]);

  // Drills the chart itself into one specific place: each period's bar
  // becomes that place's own sold-out count (0 for a period it wasn't
  // cached in that day, never fabricated) instead of the site-wide total.
  const chartPoints = useMemo(() => {
    if (!focusKey) return points;
    if (dimension === "country") {
      return points.map((p) => ({ ...p, totalSoldOut: (p.countries || []).find((c) => c.country === focusKey)?.soldOut || 0 }));
    }
    const [city, country] = focusKey.split("||");
    return points.map((p) => ({ ...p, totalSoldOut: (p.cities || []).find((c) => c.city === city && (c.country || "") === country)?.soldOut || 0 }));
  }, [points, focusKey, dimension]);

  return (
    <div className="insight-section">
      <div className="insight-section-intro">
        <h2>Sold-Out Trend</h2>
        <p>Total sold-out inventory over time — see which month or day sold the most, and where.</p>
      </div>

      <div className="insight-card">
        <div className="insight-table-toolbar">
          <div>
            <h3 style={{ marginBottom: 4 }}>{focusKey ? `Sold-Out Inventory — ${focusLabel}` : "Sold-Out Inventory Over Time"}</h3>
            <p className="insight-card-sub" style={{ margin: 0 }}>
              {focusKey
                ? `${focusLabel}'s own sold-out count across every stored ${granularity}.`
                : `${
                    granularity === "month" ? "Each month's total is its latest stored snapshot." : "One point per stored daily snapshot."
                  } Click a bar for the ${dimension} breakdown.`}
            </p>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <div className="insight-dimension-switch">
              {GRANULARITIES.map((g) => (
                <button
                  key={g.key}
                  type="button"
                  className={granularity === g.key ? "active" : ""}
                  onClick={() => {
                    setGranularity(g.key);
                    setSelectedKey(null);
                  }}
                >
                  {g.label}
                </button>
              ))}
            </div>
            <div className="insight-dimension-switch">
              {DIMENSIONS.map((d) => (
                <button
                  key={d.key}
                  type="button"
                  className={dimension === d.key ? "active" : ""}
                  onClick={() => {
                    setDimension(d.key);
                    setFocusKey(null);
                  }}
                >
                  {d.label}
                </button>
              ))}
            </div>
            <select className="insight-filter-select" value={focusKey || ""} onChange={(e) => setFocusKey(e.target.value || null)}>
              <option value="">{dimension === "country" ? "All Countries" : "All Cities"}</option>
              {dimension === "country"
                ? allCountries.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))
                : allCities.map((c) => (
                    <option key={`${c.city}||${c.country}`} value={`${c.city}||${c.country}`}>
                      {c.city}, {c.country}
                    </option>
                  ))}
            </select>
          </div>
        </div>

        {error ? (
          <ErrorState onRetry={onRetry} />
        ) : !trend ? (
          <ChartSkeleton height={260} />
        ) : points.length === 0 ? (
          <EmptyState message="No sold-out snapshots recorded yet." onReset={onResetFilters} />
        ) : (
          <>
            {focusKey ? (
              <TrendLineChart points={chartPoints} granularity={granularity} label={focusLabel} />
            ) : (
              <TrendBarChart points={chartPoints} granularity={granularity} selectedKey={activeKey} onSelectKey={setSelectedKey} />
            )}
            {!focusKey && activeEntry && (
              <div className="insight-trendchart-breakdown">
                <div className="insight-table-toolbar" style={{ marginBottom: 12 }}>
                  <h4 style={{ margin: 0 }}>
                    {breakdownLimit === "all" ? "All" : `Top ${breakdownLimit}`} {dimension === "country" ? "countries" : "cities"} — {activeLabel}
                    {breakdownLimit !== "all" && breakdownFull.length > Number(breakdownLimit) ? ` (of ${breakdownFull.length})` : ""}
                  </h4>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <div className="insight-dimension-switch">
                      {BREAKDOWN_VIEWS.map((v) => (
                        <button key={v.key} type="button" className={breakdownView === v.key ? "active" : ""} onClick={() => setBreakdownView(v.key)}>
                          {v.label}
                        </button>
                      ))}
                    </div>
                    <select className="insight-filter-select" value={breakdownLimit} onChange={(e) => setBreakdownLimit(e.target.value)}>
                      {BREAKDOWN_LIMIT_OPTIONS.map((o) => (
                        <option key={o.key} value={o.key}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="insight-trendchart-breakdown-scroll">
                  {breakdownView === "heatmap" ? (
                    <BreakdownHeatmap data={breakdownData} valueKey="soldOut" labelKey={dimension} emptyMessage={`No ${dimension} data for this ${granularity}.`} />
                  ) : (
                    <BarList
                      data={breakdownData}
                      valueKey="soldOut"
                      labelKey={dimension}
                      color={CHART_COLORS.purple}
                      emptyMessage={`No ${dimension} data for this ${granularity}.`}
                    />
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
