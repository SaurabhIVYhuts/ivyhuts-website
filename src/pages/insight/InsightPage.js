import React, { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import InsightSidebar from "./components/InsightSidebar";
import InsightHeader from "./components/InsightHeader";
import FilterBar, { rangeFromPreset } from "./components/FilterBar";
import InsightCalendar from "./components/InsightCalendar";
import ModeBanner from "./components/ModeBanner";
import MarketSection from "./components/sections/MarketSection";
import TrendSection from "./components/sections/TrendSection";
import PricingSection from "./components/sections/PricingSection";
import PropertySection from "./components/sections/PropertySection";
import BookingSection from "./components/sections/BookingSection";
import { getInsightsOverview, getInsightsSnapshot, getInsightsSoldOutTrend, InsightsApiError } from "../../services/insightsApi";
import "./insight-theme.css";

// Every data endpoint this page calls (api/insights/overview.js, market.js,
// snapshot.js, snapshot-dates.js) already requires an internal-role session
// server-side (see api/_lib/insightsDevAuth.js, Milestone 22) — that's the
// real enforcement, not this component. What's added below is purely a UX
// gate: instead of rendering the full dashboard chrome around empty/error
// data for a visitor the server is already rejecting, the very first 401/403
// response from either endpoint short-circuits render into a clean
// "sign in required" / "admin access required" screen. A bypass of this
// client check (disabled JS, direct API calls, etc.) still gets nothing —
// the API responses this reads FROM are the actual security boundary.
function InsightAccessGate({ status }) {
  const loggedOut = status === 401;
  return (
    <div className="insight-app insight-gate">
      <div className="insight-gate-card">
        <h1>{loggedOut ? "Sign in required" : "Admin access required"}</h1>
        <p>
          {loggedOut
            ? "You need to sign in with an internal team account to view this page."
            : "This page is restricted to internal team members. Your account doesn't have access."}
        </p>
        <Link to="/" className="insight-gate-link">← Back to ivyhuts.com</Link>
      </div>
    </div>
  );
}

export default function InsightPage() {
  const [activeTab, setActiveTab] = useState("market");
  const [mobileOpen, setMobileOpen] = useState(false);
  const [filters, setFilters] = useState({ rangeKey: "30d", ...rangeFromPreset("30d") });
  // null = today, live. "YYYY-MM-DD" = a historical date picked from the
  // calendar — everything downstream (data source, polling, the mode
  // banner) branches on this one piece of state.
  const [selectedDate, setSelectedDate] = useState(null);

  // Overview/Booking Trends tabs were removed from the UI, but `overview`
  // (Leads/Enquiries CRM data) is still fetched — Market Intelligence's
  // Next-Year Opportunity ranking uses its byCity demand signal, and the
  // filter bar's Source dropdown is populated from it.
  const [overview, setOverview] = useState(null);
  const [market, setMarket] = useState(null);
  const [trend, setTrend] = useState(null);
  const [errorTrend, setErrorTrend] = useState(false);
  const [loadingMarket, setLoadingMarket] = useState(true);
  const [errorMarket, setErrorMarket] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // null = not yet determined; {status: 401|403} once a data endpoint has
  // confirmed this visitor can't be here — see InsightAccessGate above.
  const [accessDenied, setAccessDenied] = useState(null);
  // See the background-poll effect below for what this counts. A full
  // catalog crawl needs ~15 rounds at 6 pages/round for ~87 pages — capped
  // well above that for margin (skipped/failed rounds still count).
  const backgroundPollCountRef = useRef(0);
  const BACKGROUND_POLL_LIMIT = 40;

  const loadOverview = useCallback(async () => {
    try {
      const data = await getInsightsOverview({ from: filters.from, to: filters.to, city: filters.city, source: filters.source });
      setOverview(data);
    } catch (err) {
      if (err instanceof InsightsApiError && (err.status === 401 || err.status === 403)) {
        setAccessDenied({ status: err.status });
        return;
      }
      // Otherwise silently ignored — nothing on-screen depends solely on this
      // fetch succeeding (Market Intelligence's opportunity ranking simply
      // falls back to a demand signal of 0 if `overview` never loads).
    }
  }, [filters.from, filters.to, filters.city, filters.source]);

  // Month-by-month sold-out totals for the Market Intelligence trend chart —
  // independent of the calendar's selected date (it's a cross-day history
  // view, not a single-day one), scoped only to the country/city filter.
  // Same non-critical, silent-except-401/403 failure handling as
  // loadOverview: nothing else on screen depends on this succeeding.
  const loadTrend = useCallback(async () => {
    setErrorTrend(false);
    try {
      const data = await getInsightsSoldOutTrend({ country: filters.country, city: filters.city });
      setTrend(data);
    } catch (err) {
      if (err instanceof InsightsApiError && (err.status === 401 || err.status === 403)) {
        setAccessDenied({ status: err.status });
      } else {
        // Previously silently ignored, same as loadOverview — but unlike
        // overview (a secondary input other sections tolerate missing),
        // trend has no other data source: a swallowed error here left
        // TrendSection stuck on its loading skeleton forever, with no
        // indication anything failed and no way to retry short of a full
        // page reload. Surfaced properly instead.
        setErrorTrend(true);
      }
    }
  }, [filters.country, filters.city]);

  // `background: true` skips the loading/error UI state — used by the
  // auto-poll below so refilling coverage never flashes the skeleton over
  // sections that are already showing real data.
  const loadMarket = useCallback(
    async ({ background = false } = {}) => {
      if (!background) {
        setLoadingMarket(true);
        setErrorMarket(false);
      }
      try {
        const data = await getInsightsSnapshot({ date: selectedDate || undefined, country: filters.country, city: filters.city });
        setMarket(data);
      } catch (err) {
        if (err instanceof InsightsApiError && (err.status === 401 || err.status === 403)) {
          setAccessDenied({ status: err.status });
        } else if (!background) {
          setErrorMarket(true);
        }
      } finally {
        if (!background) setLoadingMarket(false);
      }
    },
    [filters.country, filters.city, selectedDate]
  );

  useEffect(() => {
    backgroundPollCountRef.current = 0;
    loadOverview();
    loadMarket();
    loadTrend();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.from, filters.to, filters.city, filters.source, filters.country, selectedDate]);

  // /api/insights/snapshot's live path (selectedDate === null) runs a
  // resumable, budget-safe crawl of Amber's ENTIRE catalog (see
  // api/_lib/insightsMarket.js) — each call advances it by at most one
  // shared budget window's worth of page fetches, never more, so a single
  // dashboard load can't burst Amber. To still end up with the full
  // breakdown, automatically re-fetch in the background every 15s until the
  // crawl reports complete. A historical date is a frozen stored document,
  // never re-fetched or polled — re-hitting Amber for a past date would
  // violate the whole point of storing a snapshot (spec §8/§17).
  useEffect(() => {
    if (selectedDate) return;
    if (!market) return;
    if (market.crawlProgress?.complete) return;
    if (backgroundPollCountRef.current >= BACKGROUND_POLL_LIMIT) return;
    const timer = setTimeout(() => {
      backgroundPollCountRef.current += 1;
      loadMarket({ background: true });
    }, 15000);
    return () => clearTimeout(timer);
  }, [market, loadMarket, selectedDate]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await Promise.all([loadOverview(), loadMarket(), loadTrend()]);
    setRefreshing(false);
  };

  const resetFilters = () => setFilters({ rangeKey: "30d", ...rangeFromPreset("30d") });

  const sourceOptions = overview ? overview.bySource.map((s) => s.source).filter(Boolean) : [];

  // Pricing/Property assume `market`, once truthy, always has real
  // cities[]/properties[] arrays — true for live mode and for any
  // historical date that actually has a snapshot. For a historical date
  // with no stored snapshot (available:false), fall back to null so those
  // components' existing "no data" empty state renders instead of crashing
  // on missing arrays. Market/Booking read the raw `market` object directly
  // so they can show the specific "no snapshot for this date" message.
  const marketForLegacyTabs = market && market.available !== false ? market : null;

  if (accessDenied) {
    return <InsightAccessGate status={accessDenied.status} />;
  }

  // Still waiting on the first response from either data endpoint — hold off
  // on rendering the dashboard shell so a denied visitor never even briefly
  // sees the sidebar/filters flash before InsightAccessGate takes over.
  if (loadingMarket && !market && !errorMarket) {
    return (
      <div className="route-loading">
        <div className="route-loading-spinner" aria-label="Loading" />
      </div>
    );
  }

  return (
    <div className="insight-app">
      <InsightSidebar active={activeTab} onSelect={setActiveTab} mobileOpen={mobileOpen} onCloseMobile={() => setMobileOpen(false)} />
      <div className="insight-main">
        <InsightHeader onRefresh={handleRefresh} refreshing={refreshing} onOpenMobileMenu={() => setMobileOpen(true)} />
        <FilterBar filters={filters} onChange={setFilters} onReset={resetFilters} sourceOptions={sourceOptions}>
          <InsightCalendar selectedDate={selectedDate} onSelect={setSelectedDate} />
        </FilterBar>
        {market && (
          <ModeBanner
            mode={market.mode || (selectedDate ? "historical" : "live")}
            date={market.date || selectedDate}
            generatedAt={market.generatedAt}
            crawlComplete={market.crawlProgress?.complete}
          />
        )}
        <div className="insight-content">
          {activeTab === "market" && (
            <MarketSection market={market} overview={overview} loading={loadingMarket} error={errorMarket} onRetry={loadMarket} onResetFilters={resetFilters} />
          )}
          {activeTab === "trends" && <TrendSection trend={trend} error={errorTrend} onRetry={loadTrend} onResetFilters={resetFilters} />}
          {activeTab === "pricing" && (
            <PricingSection market={marketForLegacyTabs} loading={loadingMarket} error={errorMarket} onRetry={loadMarket} onResetFilters={resetFilters} />
          )}
          {activeTab === "property" && (
            <PropertySection market={marketForLegacyTabs} loading={loadingMarket} error={errorMarket} onRetry={loadMarket} onResetFilters={resetFilters} />
          )}
          {activeTab === "booking" && <BookingSection data={market} loading={loadingMarket} error={errorMarket} onRetry={loadMarket} onResetFilters={resetFilters} />}
        </div>
      </div>
    </div>
  );
}
