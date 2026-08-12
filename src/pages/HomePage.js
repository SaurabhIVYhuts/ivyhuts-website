import React, { useState, useMemo, useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { MessageCircle, Mail, Phone, LifeBuoy, History, Zap, Tag, Search, FileText, PartyPopper } from "lucide-react";
import SiteFooter from "../components/layout/SiteFooter";
import SiteNavbar from "../components/layout/SiteNavbar";
import TrustStrip from "../components/layout/TrustStrip";
import "./HomePage.css";
import CityCard from "../components/cards/CityCard";
import HeroInventoryCards from "../components/home/HeroInventoryCards";
import HeroJourneyStrip from "../components/home/HeroJourneyStrip";
import LeadPopup from "../components/popups/LeadPopup";
import "../components/popups/LeadPopup.css";
import { DESTINATIONS, COUNTRIES, countryFullName, countryIsoCode } from "../data/destinations";
import { getRecentSearches, addRecentSearch, getRecentProperties } from "../services/recentActivity";
import { getProperties } from "../services/amberApi";
import { safeListingList } from "../services/amberMapper";
import CompactPropertyCard from "../components/listing/CompactPropertyCard";

// --- Static Data for Marketing Sections ---
const STEPS = [
  { title: "Discover and Finalize", desc: "Choose from a plethora of verified student home listings.", icon: <Search size={22} strokeWidth={2} /> },
  { title: "Get your paperwork done", desc: "Paperwork's on us, no need to fuss.", icon: <FileText size={22} strokeWidth={2} /> },
  { title: "Accommodation Booked!", desc: "Relax, pack your bags, and unravel a new life chapter!", icon: <PartyPopper size={22} strokeWidth={2} /> }
];

const WA_HREF = `https://wa.me/918847725089?text=${encodeURIComponent("Hi IvyHuts! I'm looking for student accommodation abroad. Can you help?")}`;

function HomePage() {
  const navigate = useNavigate();

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

  /* ── SEARCH ── */
  const [searchValue, setSearchValue] = useState("");
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const suggestions = useMemo(() => {
    const q = searchValue.trim().toLowerCase();
    if (!q) return [];
    return DESTINATIONS.filter((d) => d.name.toLowerCase().startsWith(q)).slice(0, 6);
  }, [searchValue]);

  const runSearch = (value) => {
    const clean = (value || "").trim();
    if (!clean) return;
    setSuggestionsOpen(false);
    addRecentSearch(clean);
    navigate(`/properties?city=${encodeURIComponent(clean)}`);
  };

  /* ── POPULAR CITIES — COUNTRY FILTER TABS ── */
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

      {/* HERO */}
      <section className="hero">
      <div className="hero-row">

        {/* Card group — wraps the purple hero card and supplies its
            background/rounded shape (see .hero-card-group), including a
            house photo behind the purple gradient. */}
        <div className="hero-card-group">
        {/* Purple content box — centered */}
        <div className="hero-purple-box">
          <div className="hero-bg-ring" />
          <div className="hero-bg-lines" />
          <svg className="hero-pin-pattern" viewBox="0 0 860 500" fill="none" aria-hidden="true">
            <circle cx="60" cy="400" r="26" stroke="#C47A8A" strokeWidth="1" />
            <circle cx="640" cy="40" r="18" stroke="#C47A8A" strokeWidth="1" />
          </svg>

        <div className="hero-content">
          <div className="hero-text">
            {/* Tagline + advisor button share one row, so the button sits
                in the card's top-right corner exactly in line with "A
                Venture By IIM Alums" instead of further down. */}
            <div className="hero-top-line">
              <p className="hero-tagline">A Venture By IIM Alums</p>
              <Link to="/contact" className="hero-advisor-btn">
                Talk to an Advisor
                <span className="hero-advisor-arrow">→</span>
              </Link>
            </div>

            {/* Headline + subtitle beside the live inventory cards, where
                the accommodation photo used to sit. */}
            <div className="hero-header-row">
              <div className="hero-header-text">
                <div className="desktop-hero-text">
                  <h1>
                    <span className="hero-h1-line1">From housing to hiring —</span>
                    <br />
                    <span className="hero-h1-line2">we've got you covered, globally</span>
                  </h1>
                  <p className="hero-sub-tagline">Verified student homes, matched to your university and budget.</p>
                </div>
                <div className="mobile-hero-text new-mobile-hero-design">
                  <div className="mobile-hero-title">
                    <h1>From housing to hiring — we've got you covered, globally</h1>
                    <p className="hero-sub-tagline">Verified student homes, matched to your university and budget.</p>
                  </div>

                  {/* Same live Total/Sold Out/Remaining cards the desktop
                      column shows (see .hero-inventory-stack below) — real
                      data via useInventoryStats, not a hardcoded number.
                      Horizontal scroll, ~2 cards visible at a time. */}
                  <div className="mobile-stats-carousel">
                    <HeroInventoryCards />
                  </div>

                  <div className="mobile-process-card">
                    <div className="process-step">
                      <div className="process-icon">
                        <div className="process-badge">01</div>
                        <svg viewBox="0 0 24 24" fill="none" width="18" height="18" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M18 20V10M12 20V4M6 20v-4"></path></svg>
                      </div>
                      <span className="process-text">Book<br/>Accommodation</span>
                    </div>
                    
                    <svg className="process-arrow" viewBox="0 0 24 24" fill="none" width="12" height="12" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
                    
                    <div className="process-step">
                      <div className="process-icon">
                        <div className="process-badge">02</div>
                        <svg viewBox="0 0 24 24" fill="none" width="18" height="18" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M22 10v6M2 10l10-5 10 5-10 5zM6 12v5c3 3 9 3 12 0v-5"></path></svg>
                      </div>
                      <span className="process-text">Mentorship by<br/>IIM Grads</span>
                    </div>

                    <svg className="process-arrow" viewBox="0 0 24 24" fill="none" width="12" height="12" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
                    
                    <div className="process-step">
                      <div className="process-icon">
                        <div className="process-badge">03</div>
                        <svg viewBox="0 0 24 24" fill="none" width="18" height="18" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 7a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"></path></svg>
                      </div>
                      <span className="process-text">Exclusive<br/>IVYHUTS<br/>Community</span>
                    </div>
                  </div>
                </div>
              </div>
              <div className="hero-inventory-stack">
                <HeroInventoryCards />
              </div>
            </div>

            {/* LIVE ACCOMMODATION SEARCH */}
            <form
              className="hero-search-form"
              role="search"
              onSubmit={(e) => { e.preventDefault(); runSearch(searchValue); }}
            >
              <div className="hero-search-input-wrap">
                <svg className="hero-search-icon desktop-only-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <circle cx="11" cy="11" r="7" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                <input
                  type="text"
                  className="hero-search-input desktop-only-input"
                  placeholder="Search by city, university or property"
                  value={searchValue}
                  onChange={(e) => { setSearchValue(e.target.value); setSuggestionsOpen(true); }}
                  onFocus={() => setSuggestionsOpen(true)}
                  onBlur={() => setTimeout(() => setSuggestionsOpen(false), 150)}
                  aria-label="Search by city, university or property"
                  autoComplete="off"
                />
                <input
                  type="text"
                  className="hero-search-input mobile-only-input"
                  placeholder="Search by"
                  value={searchValue}
                  onChange={(e) => { setSearchValue(e.target.value); setSuggestionsOpen(true); }}
                  onFocus={() => setSuggestionsOpen(true)}
                  onBlur={() => setTimeout(() => setSuggestionsOpen(false), 150)}
                  aria-label="Search by"
                  autoComplete="off"
                />
                {searchValue && (
                  <button
                    type="button"
                    className="hero-search-clear"
                    aria-label="Clear search"
                    onMouseDown={() => setSearchValue("")}
                  >
                    ×
                  </button>
                )}
                {suggestionsOpen && suggestions.length > 0 && (
                  <ul className="hero-search-suggestions" role="listbox">
                    {suggestions.map((d) => (
                      <li key={d.name}>
                        <button type="button" onMouseDown={() => runSearch(d.name)}>
                          <span className="hero-suggestion-flag">{d.flag}</span> {d.name}
                          <span className="hero-suggestion-country">{d.country}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <button type="submit" className="hero-search-btn">
                <span className="hero-search-btn-text">Find Rooms →</span>
                <svg className="hero-search-btn-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                  <circle cx="11" cy="11" r="7" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
              </button>
            </form>
          </div>

          {/* HOUSING → CAREER JOURNEY — full-width row below the text
              column. Purely visual storytelling, no interaction. */}
          <HeroJourneyStrip />
        </div>
        </div>{/* end hero-purple-box */}
        </div>{/* end hero-card-group */}
      </div>
      </section>

      {/* MOBILE-ONLY — the two blocks below duplicate HeroInventoryCards and
          HeroJourneyStrip as their own standalone sections outside the
          purple card, matching Amber's compact-hero-then-plain-sections
          skeleton. The in-hero originals above are untouched (still what
          desktop renders) and are hidden at mobile widths purely via CSS
          (see ".hero .hero-inventory-stack" / ".hero .hero-journey-flow"
          in global.css) — nothing here is a JSX move. */}


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

      {/* POPULAR CITIES */}
      <section className="section discovery-section">
        <div className="section-heading-popular">
          <h2 className="section-title">Popular Cities Across The Globe</h2>
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
            <CityCard key={`${city.name}-${city.country}`} city={city} compact />
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

      {/* 5. BOOK YOUR PLACE IN 3 EASY STEPS (Mobile Only) */}
      <section className="section mobile-only steps-section">
        <h2 className="section-title left-aligned">Book Your Place in 3 Easy Steps</h2>
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



      {/* TRUST BADGES (Desktop) */}
      <div className="desktop-only">
        <TrustStrip />
      </div>

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

      {/* HUNDREDS OF CITIES — Cities/Countries tab strip, mobile-only.
          Reuses the same DESTINATIONS/COUNTRIES data and the same
          /properties?city=/?country= routes as the rest of the page. */}
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
                <Link key={d.name} to={`/properties?city=${encodeURIComponent(d.name)}`} className="hoc-link">
                  {d.name}
                </Link>
              ))
            : COUNTRIES.map((code) => (
                <Link key={code} to={`/properties?country=${encodeURIComponent(code)}`} className="hoc-link">
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

      {/* CTA */}
      <section className="cta-section">
        <div className="cta-inner">
          <p className="cta-eyebrow">Ready to Find Your Home?</p>
          <h2>Your perfect student stay is one form away</h2>
          <p className="cta-sub">Tell us what you need and our team will do the rest. Free service, personalised results, within 24 hours.</p>
          <div className="cta-actions">
            <Link to="/contact" className="primary-btn" style={{ display: "inline-block" }}>Find My Stay →</Link>
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