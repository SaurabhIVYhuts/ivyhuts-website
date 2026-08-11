import React, { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import InsightSidebar from "./components/InsightSidebar";
import InsightHeader from "./components/InsightHeader";
import FilterBar, { rangeFromPreset } from "./components/FilterBar";
import MarketSection from "./components/sections/MarketSection";
import PricingSection from "./components/sections/PricingSection";
import PropertySection from "./components/sections/PropertySection";
import { getCurrentCustomer, getInsightsOverview, getInsightsMarket } from "../../services/insightsApi";
import "./insight-theme.css";

// Real protection lives server-side — in production every /api/insights/*
// endpoint calls requireRole() with this same list (see
// api/_lib/businessAuth.js). This check is UX only: it keeps an unauthorized
// visitor from ever seeing a half-loaded dashboard shell, per the spec's own
// "hiding the route is not security" note (§27).
const INTERNAL_ROLES = ["MARKETING_AGENT", "MARKETING_MANAGER", "ADMIN"];

// TEMPORARY local-development bypass, mirroring api/_lib/insightsDevAuth.js
// on the backend: there's no MongoDB connection / seeded admin account
// available locally yet, so the normal getCurrentCustomer() role check can
// never succeed in dev. process.env.NODE_ENV is baked in at build time by
// CRA (same convention as the `DEV` const in src/services/amberApi.js) — a
// real `npm run build` always has NODE_ENV=production, so this bypass can
// never ship. Scoped to this file only; no other page's auth behavior
// changes.
// TODO: Re-enable authentication/RBAC before production deployment — delete
// this bypass once a real admin account exists and restore the
// getCurrentCustomer()-only check below.
const DEV_RBAC_BYPASS = process.env.NODE_ENV !== "production";

export default function InsightPage() {
  const navigate = useNavigate();
  const [authState, setAuthState] = useState("checking"); // checking | ok | forbidden
  const [activeTab, setActiveTab] = useState("market");
  const [mobileOpen, setMobileOpen] = useState(false);
  const [filters, setFilters] = useState({ rangeKey: "30d", ...rangeFromPreset("30d") });

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

  useEffect(() => {
    if (DEV_RBAC_BYPASS) {
      // See DEV_RBAC_BYPASS comment above — never calls getCurrentCustomer()
      // at all in this mode, so opening /insight locally has no MongoDB
      // dependency (that endpoint resolves a Mongo user to check its role).
      setAuthState("ok");
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const customer = await getCurrentCustomer();
        if (cancelled) return;
        setAuthState(INTERNAL_ROLES.includes(customer.role) ? "ok" : "forbidden");
      } catch (err) {
        if (cancelled) return;
        if (err.status === 401) {
          navigate("/login?returnTo=/insight", { replace: true });
        } else {
          setAuthState("forbidden");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [navigate]);

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
        const data = await getInsightsMarket({ country: filters.country, city: filters.city });
        setMarket(data);
      } catch {
        if (!background) setErrorMarket(true);
      } finally {
        if (!background) setLoadingMarket(false);
      }
    },
    [filters.country, filters.city]
  );

  useEffect(() => {
    if (authState !== "ok") return;
    backgroundPollCountRef.current = 0;
    loadOverview();
    loadMarket();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authState, filters.from, filters.to, filters.city, filters.source, filters.country]);

  // /api/insights/market runs a resumable, budget-safe crawl of Amber's
  // ENTIRE catalog (see api/_lib/insightsMarket.js) — each call advances it
  // by at most one shared budget window's worth of page fetches, never more,
  // so a single dashboard load can't burst Amber. To still end up with the
  // full breakdown (which is what lets the totals reconcile exactly with the
  // homepage's Sold Out counter), automatically re-fetch in the background
  // every 15s until the crawl reports complete. Capped at
  // BACKGROUND_POLL_LIMIT rounds as a safety stop, not an expected outcome.
  useEffect(() => {
    if (!market) return;
    if (market.crawlProgress?.complete) return;
    if (backgroundPollCountRef.current >= BACKGROUND_POLL_LIMIT) return;
    const timer = setTimeout(() => {
      backgroundPollCountRef.current += 1;
      loadMarket({ background: true });
    }, 15000);
    return () => clearTimeout(timer);
  }, [market, loadMarket]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await Promise.all([loadOverview(), loadMarket()]);
    setRefreshing(false);
  };

  const resetFilters = () => setFilters({ rangeKey: "30d", ...rangeFromPreset("30d") });

  if (authState === "checking") {
    return <div className="insight-fullscreen-loading" />;
  }
  if (authState === "forbidden") {
    return (
      <div className="insight-forbidden">
        <h1>IVYHUTS Insights</h1>
        <p>You don&apos;t have access to this page. This dashboard is restricted to internal marketing and admin staff.</p>
      </div>
    );
  }

  const sourceOptions = overview ? overview.bySource.map((s) => s.source).filter(Boolean) : [];

  return (
    <div className="insight-app">
      <InsightSidebar active={activeTab} onSelect={setActiveTab} mobileOpen={mobileOpen} onCloseMobile={() => setMobileOpen(false)} />
      <div className="insight-main">
        <InsightHeader onRefresh={handleRefresh} refreshing={refreshing} onOpenMobileMenu={() => setMobileOpen(true)} />
        <FilterBar filters={filters} onChange={setFilters} onReset={resetFilters} sourceOptions={sourceOptions} />
        <div className="insight-content">
          {activeTab === "market" && (
            <MarketSection market={market} overview={overview} loading={loadingMarket} error={errorMarket} onRetry={loadMarket} onResetFilters={resetFilters} />
          )}
          {activeTab === "pricing" && (
            <PricingSection market={market} loading={loadingMarket} error={errorMarket} onRetry={loadMarket} onResetFilters={resetFilters} />
          )}
          {activeTab === "property" && (
            <PropertySection market={market} loading={loadingMarket} error={errorMarket} onRetry={loadMarket} onResetFilters={resetFilters} />
          )}
        </div>
      </div>
    </div>
  );
}
