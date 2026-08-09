import React, { useEffect, lazy, Suspense } from "react";
import { BrowserRouter as Router, Routes, Route, useLocation } from "react-router-dom";
import "./styles/global.css";
import HomePage from "./pages/HomePage";
import PropertyListingPage from "./pages/PropertyListingPage";
import { initMetaPixel, trackPageView } from "./lib/metaPixel";
import { bumpPageViewCount } from "./lib/pageViewCounter";

const AccommodationFinderPage = lazy(() => import("./pages/AccommodationFinderPage"));
const PropertyDetailPage       = lazy(() => import("./pages/PropertyDetailPage"));
const LifeAbroadPage           = lazy(() => import("./pages/LifeAbroadPage"));
const ListYourStayPage         = lazy(() => import("./pages/ListYourStayPage"));
const ContactPage              = lazy(() => import("./pages/ContactPage"));
const PartnerPage              = lazy(() => import("./pages/PartnerPage"));
const TermsPage                = lazy(() => import("./pages/legal/TermsPage"));
const PrivacyPage              = lazy(() => import("./pages/legal/PrivacyPage"));

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
      <ScrollToTop />
      <MetaPixelTracker />
      <PageViewCounter />
      <Suspense fallback={<div style={{ minHeight: "100vh", background: "#FBF4F8" }} />}>
        <Routes>
          <Route path="/"               element={<HomePage />} />
          <Route path="/find-rooms"     element={<PropertyListingPage />} />
          <Route path="/enquire"        element={<AccommodationFinderPage />} />
          <Route path="/property/:slug" element={<PropertyDetailPage />} />
          <Route path="/life-abroad"    element={<LifeAbroadPage />} />
          <Route path="/list-your-stay" element={<ListYourStayPage />} />
          <Route path="/contact"        element={<ContactPage />} />
          <Route path="/partner"        element={<PartnerPage />} />
          <Route path="/terms"          element={<TermsPage />} />
          <Route path="/privacy"        element={<PrivacyPage />} />
          <Route path="/properties" element={<PropertyListingPage />} />
        </Routes>
      </Suspense>
    </Router>
  );
}

export default App;
