import React, { useCallback, useEffect, useRef, useState } from "react";
import InsightSidebar from "./components/InsightSidebar";
import InsightHeader from "./components/InsightHeader";
import FilterBar, { rangeFromPreset } from "./components/FilterBar";
import InsightCalendar from "./components/InsightCalendar";
import ModeBanner from "./components/ModeBanner";
import MarketSection from "./components/sections/MarketSection";
import PricingSection from "./components/sections/PricingSection";
import PropertySection from "./components/sections/PropertySection";
import BookingSection from "./components/sections/BookingSection";
import { getInsightsOverview, getInsightsSnapshot } from "../../services/insightsApi";
import "./insight-theme.css";

// /insight access is temporarily unrestricted for now.
// Backend auth is also bypassed in api/_lib/insightsDevAuth.js.

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
  const [loadingMarket, setLoadingMarket] = useState(true);
  const [errorMarket, setErrorMarket] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // See the background-poll effect below for what this counts. A full
  // catalog crawl needs ~15 rounds at 6 pages/round for ~87 pages — capped
  // well above that for margin (skipped/failed rounds still count).
  const backgroundPollCountRef = useRef(0);
  const BACKGROUND_POLL_LIMIT = 40;

  const loadOverview = useCallback(async () => {
    try {
      const data = await getInsightsOverview({ from: filters.from, to: filters.to, city: filters.city, source: filters.source });
      setOverview(data);
    } catch {
      // Silently ignored here — nothing on-screen depends solely on this
      // fetch succeeding (Market Intelligence's opportunity ranking simply
      // falls back to a demand signal of 0 if `overview` never loads).
    }
  }, [filters.from, filters.to, filters.city, filters.source]);

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
      } catch {
        if (!background) setErrorMarket(true);
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
    await Promise.all([loadOverview(), loadMarket()]);
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
