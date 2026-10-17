import React, { useState, useMemo, useEffect } from "react";
import { Link, useNavigate, useLocation } from "react-router-dom";
import { MessageCircle, Mail, Phone, LifeBuoy, History, Zap, Tag, Search, FileText, PartyPopper, ArrowRight } from "lucide-react";
import SiteFooter from "../components/layout/SiteFooter";
import SiteNavbar from "../components/layout/SiteNavbar";
import "./HomePage.css";
import CityCard from "../components/cards/CityCard";
import LeadPopup from "../components/popups/LeadPopup";
import "../components/popups/LeadPopup.css";
import { DESTINATIONS, COUNTRIES, countryFullName, countryIsoCode, findDestination } from "../data/destinations";
import { getRecentSearches, addRecentSearch, getRecentProperties } from "../services/recentActivity";
import { getProperties } from "../services/amberApi";
import { safeListingList } from "../services/amberMapper";
import CompactPropertyCard from "../components/listing/CompactPropertyCard";
import AccommodationSearchExperience from "../components/universityHousing/AccommodationSearchExperience";
import HeroInventoryCards from "../components/home/HeroInventoryCards";
import { SEARCH_ANCHOR_ID, SEARCH_ANCHOR_HREF, citySearchHref, countrySearchHref } from "../lib/homeSearch";
import heroGlobe from "../assets/hero-globe.svg";
import heroHouses from "../assets/hero-houses.svg";

// --- Static Data for Marketing Sections ---
const STEPS = [
  { title: "Discover and Finalize", desc: "Choose from a plethora of verified student home listings.", icon: <Search size={22} strokeWidth={2} /> },
  { title: "Get your paperwork done", desc: "Paperwork's on us, no need to fuss.", icon: <FileText size={22} strokeWidth={2} /> },
  { title: "Accommodation Booked!", desc: "Relax, pack your bags, and unravel a new life chapter!", icon: <PartyPopper size={22} strokeWidth={2} /> }
];

const WA_HREF = `https://wa.me/918847725089?text=${encodeURIComponent("Hi IvyHuts! I'm looking for student accommodation abroad. Can you help?")}`;

// Quick picks under the hero search — real curated destinations only.
const QUICK_CITIES = ["London", "Manchester", "Sydney", "Toronto", "Dublin"]
  .map((name) => DESTINATIONS.find((d) => d.name === name))
  .filter(Boolean);

function HomeHero({ searchBox }) {
  return (
    <section className="home-hero" id={SEARCH_ANCHOR_ID} aria-labelledby="home-hero-title">
      {/* Decorative houses (left) and globe + flight path (right). Clipped by
          their own layer (not the section) so the search suggestions can
          still overflow the hero. */}
      <div className="home-hero-art" aria-hidden="true">
        <img src={heroHouses} alt="" className="home-hero-houses" width="640" height="320" decoding="async" />
        <img src={heroGlobe} alt="" className="home-hero-globe" width="900" height="760" decoding="async" />
      </div>
      <div className="home-hero-inner">
        <div className="home-hero-top">
          <p className="home-hero-eyebrow">A Venture By IIM Alums</p>
          <Link to="/contact" className="hero-advisor-btn">
            Talk to an Advisor
            <span className="hero-advisor-arrow">→</span>
          </Link>
        </div>

        <h1 id="home-hero-title" className="home-hero-title">
          From Housing to <span>Hiring</span>
        </h1>

        <HeroInventoryCards />

        <div className="home-hero-search">{searchBox}</div>

        {QUICK_CITIES.length > 0 && (
          <div className="home-hero-quick" aria-label="Popular searches">
            <span className="home-hero-quick-label">Popular:</span>
            {QUICK_CITIES.map((d) => (
              <Link key={d.name} to={citySearchHref(d.name, d.country)} className="home-hero-chip">
                {d.name}
              </Link>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function HomePage() {
  const navigate = useNavigate();
  const location = useLocation();

  /* ── RECENT HISTORY ── */
  const [recentSearches, setRecentSearches] = useState([]);
  const [recentProperties, setRecentProperties] = useState([]);
  const [globalProperties, setGlobalProperties] = useState([]);

  useEffect(() => {
    setRecentSearches(getRecentSearches());
    setRecentProperties(getRecentProperties());
    getProperties("London", 1, 4, "LOW", "homepage-global")
      .then(safeListingList)
      .then(setGlobalProperties)
      .catch(() => {});
  }, []);

  // "Find Accommodation" links elsewhere on the site point at
  // /#find-accommodation — bring the hero search into view when they land.
  useEffect(() => {
    if (location.hash !== `#${SEARCH_ANCHOR_ID}`) return;
    const el = document.getElementById(SEARCH_ANCHOR_ID);
    if (el && typeof el.scrollIntoView === "function") el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [location.hash, location.key]);

  /* ── RECENT SEARCHES ──
     Stores a plain past query string (a city, country, university or
     property name). A known city name opens the integrated homepage search;
     anything else keeps its existing generic `?property=` route, which
     PropertyListingPage resolves via the /api/search index. */
  const runSearch = (value) => {
    const clean = (value || "").trim();
    if (!clean) return;
    addRecentSearch(clean);
    const knownCity = findDestination(clean);
    navigate(knownCity ? citySearchHref(knownCity.name, knownCity.country) : `/properties?property=${encodeURIComponent(clean)}`);
  };

  /* ── POPULAR DESTINATIONS — COUNTRY FILTER TABS ── */
  const [popularCountry, setPopularCountry] = useState("All");
  const popularCountryTabs = useMemo(() => [
    ...COUNTRIES.map((code) => ({
      code,
      label: countryFullName(code),
      flag: DESTINATIONS.find((d) => d.country === code)?.flag || "",
    })),
  ], []);
  const visibleDestinations = useMemo(
    () => (popularCountry === "All" ? DESTINATIONS : DESTINATIONS.filter((d) => d.country === popularCountry)),
    [popularCountry]
  );

  /* ── MOBILE-ONLY: "Hundreds Of Cities" Cities/Countries tab strip ── */
  const [hocTab, setHocTab] = useState("cities");

  return (
    <div>
      <LeadPopup />

      <SiteNavbar />

      <main>

      {/* HERO + INTEGRATED ACCOMMODATION SEARCH — university, city, country
          and Google Maps links; results (list + map) render directly below
          the hero. Owns the page's <Seo>, which keeps the homepage defaults
          until a search is active. */}
      <AccommodationSearchExperience
        renderSearch={(searchBox) => <HomeHero searchBox={searchBox} />}
        resultsId="accommodation-results"
        basePath="/"
      />

      {/* RECENT SEARCHES */}
      {recentSearches.length > 0 && (
        <section className="section mobile-only recent-history-section" aria-label="Recent Searches">
          <div className="section-heading-minimal">
            <h2>Continue Your Search Journey</h2>
          </div>
          <div className="recent-searches-row" role="list">
            {recentSearches.map((city) => (
              <button
                key={city}
                type="button"
                className="recent-search-pill"
                onClick={() => runSearch(city)}
              >
                <History size={16} className="recent-search-icon" color="#B05E72" />
                <span>{city}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {/* RECENT PROPERTIES */}
      {recentProperties.length > 0 && (
        <section className="section mobile-only recent-history-section has-top-border" aria-label="Recently Viewed Properties">
          <div className="section-heading-minimal">
            <h2>Continue Where You Left From</h2>
          </div>
          <div className="recent-properties-scroller">
            {recentProperties.map((p) => (
              <CompactPropertyCard key={p.slug || p.id} listing={p} />
            ))}
          </div>
        </section>
      )}

      {/* POPULAR DESTINATIONS — every card and country button opens the
          integrated homepage search in city / country mode. */}
      <section className="section discovery-section" aria-labelledby="popular-destinations-title">
        <div className="section-heading-popular">
          <h2 id="popular-destinations-title" className="section-title">Popular Cities Across The Globe</h2>
          <p className="section-subtitle">Book student accommodations near top cities and universities around the world.</p>
        </div>
        <div className="city-tab-row" role="group" aria-label="Filter popular cities by country">
          {popularCountryTabs.map((tab) => (
            <button
              key={tab.code}
              type="button"
              className={`country-filter-btn${tab.code === popularCountry ? " active" : ""}`}
              aria-pressed={tab.code === popularCountry}
              onClick={() => setPopularCountry(tab.code)}
            >
              <div className="country-filter-flag-wrap">
                <img src={`https://flagcdn.com/${countryIsoCode(tab.code).toLowerCase()}.svg`} alt="" loading="lazy" className="country-filter-flag" />
              </div>
              <span className="country-filter-label">{tab.code === "All" ? "All" : tab.code}</span>
            </button>
          ))}
        </div>
        <ul className="city-grid">
          {visibleDestinations.map((city) => (
            <CityCard key={`${city.name}-${city.country}`} city={city} compact to={citySearchHref(city.name, city.country)} />
          ))}
        </ul>
        {popularCountry !== "All" && (
          <div className="home-country-cta">
            <Link to={countrySearchHref(popularCountry)} className="btn btn-secondary">
              See all accommodation in {countryFullName(popularCountry)} <ArrowRight size={16} aria-hidden="true" />
            </Link>
          </div>
        )}
      </section>

      {/* BROWSE BY COUNTRY — a whole-country search (every city, not just the capital). */}
      <section className="section home-countries-section" aria-labelledby="home-countries-title">
        <div className="section-heading-popular">
          <h2 id="home-countries-title" className="section-title">Study Destinations by Country</h2>
          <p className="section-subtitle">See student accommodation across every city we cover in a country.</p>
        </div>
        <ul className="home-country-grid">
          {COUNTRIES.map((code) => (
            <li key={code}>
              <Link to={countrySearchHref(code)} className="home-country-card">
                <img src={`https://flagcdn.com/${countryIsoCode(code).toLowerCase()}.svg`} alt="" loading="lazy" className="home-country-flag" />
                <span className="home-country-name">{countryFullName(code)}</span>
                <ArrowRight size={16} aria-hidden="true" className="home-country-arrow" />
              </Link>
            </li>
          ))}
        </ul>
      </section>

      {/* 1. THOUSANDS OF PROPERTIES GLOBALLY (Mobile Only) */}
      <section className="section mobile-only thousands-properties-section">
        <h2 className="section-title left-aligned">Thousands Of Properties Globally</h2>
        <p className="section-copy">Explore student flats, private rooms & shared apartments, we've got it all.</p>
        <div className="filter-pills-row">
          <div className="filter-pill active">
            <span className="filter-icon">🇬🇧</span> United Kingdom <span className="chevron">▼</span>
          </div>
          <div className="filter-pill">London <span className="chevron">▼</span></div>
          <span className="showing-text">Showing</span>
        </div>
        <ul className="property-scroller">
          {globalProperties.map((prop, i) => (
            <li key={prop.id || i} className="property-scroller-item">
              <CompactPropertyCard listing={prop} />
            </li>
          ))}
        </ul>
      </section>

      {/* 3. BOOK YOUR PERFECT ACCOMMODATION (Mobile Only) */}
      <section className="section mobile-only perfect-acc-section">
        <h2 className="section-title left-aligned">Book Your Perfect Accommodation</h2>
        <p className="section-copy">Take the hassle out of securing your student home for the best years of your life</p>
        <div className="perfect-acc-grid">
          <div className="perfect-acc-item">
            <div className="perfect-acc-icon"><Zap size={22} strokeWidth={2} /></div>
            <h4>Fast & Easy Bookings</h4>
            <p>Time is money. Save both when you book with us.</p>
          </div>
          <div className="perfect-acc-item">
            <div className="perfect-acc-icon"><Tag size={22} strokeWidth={2} /></div>
            <h4>Lowest Price Guaranteed</h4>
            <p>Find a lower price and we'll match it. T&C Apply</p>
          </div>
        </div>
      </section>

      {/* BOOK YOUR PLACE IN 3 EASY STEPS — shown at every width now (was
          mobile-only); same copy. */}
      <section className="section steps-section home-steps" aria-labelledby="home-steps-title">
        <h2 id="home-steps-title" className="section-title">Book Your Place in 3 Easy Steps</h2>
        <p className="section-copy">Book places in major cities and universities across the globe</p>
        <div className="steps-list">
          {STEPS.map((step, i) => (
            <div key={i} className="step-item">
              <div className="step-icon">{step.icon}</div>
              <div className="step-content">
                <h4>{step.title}</h4>
                <p>{step.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* PARTNER WITH US / LIST YOUR STAY — mobile-only; desktop already
          reaches both via the navbar/footer, so this promo strip is purely
          additive, never rendered at desktop widths (see global.css). */}
      <section className="section mobile-only partner-list-strip" aria-label="Partner or list with IvyHuts">
        <div className="partner-list-row">
          <Link to="/partner" className="partner-list-card partner-list-card--partner">
            <p className="partner-list-eyebrow">Grow With IvyHuts</p>
            <h3>Partner With Us</h3>
            <p>Join our network of trusted property providers and connect with thousands of pre-verified international students.</p>
            <span className="btn btn-secondary btn-sm">Partner With Us</span>
          </Link>
          <Link to="/list-your-stay" className="partner-list-card partner-list-card--list">
            <p className="partner-list-eyebrow">Reach More Students</p>
            <h3>List Your Stay</h3>
            <p>List your property and reach thousands of verified international students searching for their next home.</p>
            <span className="btn btn-secondary btn-sm">List Your Stay</span>
          </Link>
        </div>
      </section>

      {/* FAQ */}
      <section className="section faq-section">
        <p className="section-eyebrow">Got Questions?</p>
        <h2 className="section-title">Frequently Asked Questions</h2>
        <div className="section-underline" />
        <div className="faq">
          <details className="faq-item">
            <summary><span className="faq-q">What is "No Visa No Pay"?</span><span className="faq-icon">+</span></summary>
            <p>If your student visa is refused after you have paid a booking deposit, we will refund you in full. No deductions, no admin fees. We carry that risk so you do not have to book without certainty.</p>
          </details>
          <details className="faq-item">
            <summary><span className="faq-q">Are utilities included in the price?</span><span className="faq-icon">+</span></summary>
            <p>Many of our listings are bills-included, which means electricity, water, heating, and WiFi are all covered in the weekly or monthly price. Let us know your preference and we will match accordingly.</p>
          </details>
          <details className="faq-item">
            <summary><span className="faq-q">Can I book from my home country before arriving?</span><span className="faq-icon">+</span></summary>
            <p>Yes, this is what most of our students do. You fill in our form, we send you verified options, and you can confirm your room entirely remotely before you even travel.</p>
          </details>
          <details className="faq-item">
            <summary><span className="faq-q">Do I need a local guarantor?</span><span className="faq-icon">+</span></summary>
            <p>For some private landlord properties, yes. We offer a guarantor service for international students so you are never blocked from securing accommodation due to lack of a local guarantor.</p>
          </details>
          <details className="faq-item">
            <summary><span className="faq-q">How early should I book my accommodation?</span><span className="faq-icon">+</span></summary>
            <p>We recommend reaching out 4 to 6 months before your intended move-in date, especially for popular cities like London, Sydney, and Toronto. September intake rooms fill up fast from January onwards.</p>
          </details>
          <details className="faq-item">
            <summary><span className="faq-q">What documents do I need to book?</span><span className="faq-icon">+</span></summary>
            <p>Usually your university offer or enrolment letter, a copy of your passport, and proof of funding (bank statement). Some properties may also ask for a reference. Our team will guide you through every step.</p>
          </details>
          <details className="faq-item">
            <summary><span className="faq-q">Is IvyHuts free to use?</span><span className="faq-icon">+</span></summary>
            <p>Completely free for students. We are paid a referral fee by the property owners. There is no cost to you for our search service, advice, or support at any stage.</p>
          </details>
        </div>
      </section>

      {/* HUNDREDS OF CITIES — Cities/Countries tab strip, mobile-only. Opens
          the integrated homepage search, same as the destination cards. */}
      <section className="section mobile-only hundreds-cities-strip" aria-label="Browse by city or country">
        <div className="section-heading">
          <h2 className="section-title left-aligned">Hundreds Of Cities Around The World</h2>
        </div>
        <div className="hoc-tab-row" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={hocTab === "cities"}
            className={`hoc-tab${hocTab === "cities" ? " active" : ""}`}
            onClick={() => setHocTab("cities")}
          >
            Cities
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={hocTab === "countries"}
            className={`hoc-tab${hocTab === "countries" ? " active" : ""}`}
            onClick={() => setHocTab("countries")}
          >
            Countries
          </button>
        </div>
        <div className="hoc-link-grid">
          {hocTab === "cities"
            ? DESTINATIONS.map((d) => (
                <Link key={`${d.name}-${d.country}`} to={citySearchHref(d.name, d.country)} className="hoc-link">
                  {d.name}
                </Link>
              ))
            : COUNTRIES.map((code) => (
                <Link key={code} to={countrySearchHref(code)} className="hoc-link">
                  {countryFullName(code)}
                </Link>
              ))}
        </div>
      </section>

      {/* NEED HELP? LET'S CONNECT — 2x2 contact tile grid, mobile-only.
          Every channel here already exists in SiteFooter.js — reused, not
          re-authored. */}
      <section className="section need-help-strip mobile-only" aria-label="Contact IvyHuts">
        <div className="section-heading">
          <h2 className="section-title left-aligned">Need Help? Let's Connect</h2>
          <p className="section-copy">If you have any queries, feel free to contact us.</p>
        </div>
        <div className="need-help-grid">
          <a href={WA_HREF} target="_blank" rel="noopener noreferrer" className="need-help-tile">
            <MessageCircle aria-hidden="true" />
            <span>Chat on WhatsApp</span>
          </a>
          <a href="mailto:contact@ivyhuts.com" className="need-help-tile">
            <Mail aria-hidden="true" />
            <span>Email Us</span>
          </a>
          <a href="tel:+918847725089" className="need-help-tile">
            <Phone aria-hidden="true" />
            <span>+91 88477 25089</span>
          </a>
          <Link to="/contact" className="need-help-tile">
            <LifeBuoy aria-hidden="true" />
            <span>Contact Us</span>
          </Link>
        </div>
      </section>

      {/* CTA — back to the homepage search, or the existing enquiry flow. */}
      <section className="cta-section">
        <div className="cta-inner">
          <p className="cta-eyebrow">Ready to Find Your Home?</p>
          <h2>Your perfect student stay is one search away</h2>
          <p className="cta-sub">Search by university, city or country — or tell us what you need and our team will do the rest. Free service, personalised results, within 24 hours.</p>
          <div className="cta-actions">
            <Link to={SEARCH_ANCHOR_HREF} className="primary-btn" style={{ display: "inline-block" }}>Search Accommodation</Link>
            <Link to="/contact" className="btn btn-outline home-cta-secondary">Find My Stay →</Link>
          </div>
        </div>
      </section>

      </main>

      {/* FOOTER */}
      <SiteFooter />

    </div>
  );
}


export default HomePage;
