import React, { useEffect, lazy, Suspense } from "react";
import { BrowserRouter as Router, Routes, Route, useLocation, Navigate } from "react-router-dom";
import "./styles/global.css";
import HomePage from "./pages/HomePage";
import PropertyListingPage from "./pages/PropertyListingPage";
import { initMetaPixel, trackPageView } from "./lib/metaPixel";
import { bumpPageViewCount } from "./lib/pageViewCounter";
import { WishlistProvider } from "./context/WishlistContext";
import MobileBottomNav from "./components/layout/MobileBottomNav";

const LoginPage                = lazy(() => import("./pages/LoginPage"));
const WishlistPage             = lazy(() => import("./pages/WishlistPage"));
const PropertyDetailPage       = lazy(() => import("./pages/PropertyDetailPage"));
const LifeAbroadPage           = lazy(() => import("./pages/LifeAbroadPage"));
const ListYourStayPage         = lazy(() => import("./pages/ListYourStayPage"));
const ContactPage              = lazy(() => import("./pages/ContactPage"));
const StudentPlannerPage       = lazy(() => import("./pages/StudentPlannerPage"));
const UniversityHousingPage    = lazy(() => import("./pages/UniversityHousingPage"));
const PartnerPage              = lazy(() => import("./pages/PartnerPage"));
const TermsPage                = lazy(() => import("./pages/legal/TermsPage"));
const PrivacyPage              = lazy(() => import("./pages/legal/PrivacyPage"));
const InsightPage              = lazy(() => import("./pages/insight/InsightPage"));
const ThankYouPage             = lazy(() => import("./pages/ThankYouPage"));

/* ── DEDICATED MAP ROUTES — /properties/map and /find-rooms/map are thin
   redirects onto the SAME PropertyListingPage + ?view=map query param every
   other view mode already uses (see PropertyListingPage.js's own `view`
   state), rather than a second map-page implementation. Preserves whatever
   else is already in the query string (city/university/filters) so a link
   like /properties/map?city=London still lands on London's map, not a blank one. ── */
function MapRouteRedirect() {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  params.set("view", "map");
  return <Navigate to={`/properties?${params.toString()}`} replace />;
}

/* ── FIND ROOM COMPATIBILITY ROUTE (Milestone 10) ──────────────────────────
   /find-rooms and /properties are Find Room's legacy URLs. University
   Housing is now the primary accommodation-discovery experience, but real,
   evidence-based feature gaps still exist (see IVYHUTS_FIND_ROOM_FEATURE_PARITY.md):
   University Housing has no city/country-only browsing mode and no filter
   UI at all, both of which Find Room genuinely supports and real links
   (the Footer's 16 country links, any bookmarked/shared filtered search)
   depend on today.

   Redirecting UNCONDITIONALLY would silently discard that real user intent
   the moment a filter or city/country param was present — exactly what this
   milestone's own brief prohibits ("do not silently discard user intent").
   So the redirect is scoped to ONLY the one case with fully PROVEN parity:
   a link carrying nothing but `?university=<id>` — University Housing
   resolves that identically to Find Room's own `?university=` mode. Every
   other case (bare browse, ?city=, ?country=, ?property=, or any filter
   param) continues to render PropertyListingPage directly, unchanged. ── */
const FIND_ROOM_FILTER_PARAM_KEYS = ["q", "minPrice", "maxPrice", "roomType", "billsOnly", "near", "amenities", "moveInMonth", "stayDuration", "sortBy"];
function FindRoomCompatibilityRoute() {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const hasUniversity = params.has("university");
  const hasUnsupportedParam =
    params.has("city") || params.has("country") || params.has("property") ||
    FIND_ROOM_FILTER_PARAM_KEYS.some((key) => params.has(key));
  if (hasUniversity && !hasUnsupportedParam) {
    return <Navigate to={`/university-housing?${params.toString()}`} replace />;
  }
  return <PropertyListingPage />;
}

/* ── SCROLL TO TOP ON ROUTE CHANGE ── */
function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => { window.scrollTo(0, 0); }, [pathname]);
  return null;
}

/* ── META PIXEL — init once, PageView on every route change (incl. client-side nav) ── */
function MetaPixelTracker() {
  const { pathname } = useLocation();
  useEffect(() => { initMetaPixel(); }, []);
  useEffect(() => { trackPageView(); }, [pathname]);
  return null;
}

/* ── PAGE VIEW COUNTER — bumps a persisted count on every route change, so
   the homepage lead popup can re-arm itself after the visitor has explored
   a few more pages instead of relying on a fixed time cooldown. ── */
function PageViewCounter() {
  const { pathname } = useLocation();
  useEffect(() => { bumpPageViewCount(); }, [pathname]);
  return null;
}

/* ── MAIN APP ── */
function App() {
  return (
    <Router>
      <WishlistProvider>
        <ScrollToTop />
        <MetaPixelTracker />
        <PageViewCounter />
        <Suspense fallback={<div className="route-loading"><div className="route-loading-spinner" aria-label="Loading" /></div>}>
          <Routes>
            <Route path="/"               element={<HomePage />} />
            <Route path="/find-rooms"     element={<FindRoomCompatibilityRoute />} />
            <Route path="/property/:slug" element={<PropertyDetailPage />} />
            <Route path="/life-abroad"    element={<LifeAbroadPage />} />
            <Route path="/list-your-stay" element={<ListYourStayPage />} />
            <Route path="/contact"        element={<ContactPage />} />
            <Route path="/student-planner" element={<StudentPlannerPage />} />
            <Route path="/university-housing" element={<UniversityHousingPage />} />
            <Route path="/partner"        element={<PartnerPage />} />
            <Route path="/terms"          element={<TermsPage />} />
            <Route path="/privacy"        element={<PrivacyPage />} />
            <Route path="/login"          element={<LoginPage />} />
            <Route path="/wishlist"       element={<WishlistPage />} />
            <Route path="/properties" element={<FindRoomCompatibilityRoute />} />
            <Route path="/properties/map" element={<MapRouteRedirect />} />
            <Route path="/find-rooms/map" element={<MapRouteRedirect />} />
            <Route path="/insight"    element={<InsightPage />} />
            {/* Not linked from navbar/footer/sitemap — reached only via a successful form-submission redirect */}
            <Route path="/thank-you"  element={<ThankYouPage />} />
          </Routes>
        </Suspense>
        <MobileBottomNav />
      </WishlistProvider>
    </Router>
  );
}

export default App;
