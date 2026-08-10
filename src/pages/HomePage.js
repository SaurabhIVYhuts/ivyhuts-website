import React, { useState, useEffect, useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";
import SiteFooter from "../components/layout/SiteFooter";
import SiteNavbar from "../components/layout/SiteNavbar";
import TrustStrip from "../components/layout/TrustStrip";
import "./HomePage.css";
import CityCard from "../components/cards/CityCard";
import HeroInventoryCards from "../components/home/HeroInventoryCards";
import HeroJourneyStrip from "../components/home/HeroJourneyStrip";
import LeadPopup from "../components/popups/LeadPopup";
import "../components/popups/LeadPopup.css";
import { getCachedCityStats } from "../services/amberApi";
import { DESTINATIONS, COUNTRIES, countryFullName } from "../data/destinations";

function HomePage() {
  const navigate = useNavigate();

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
    navigate(`/properties?city=${encodeURIComponent(clean)}`);
  };

  /* Cached city stats are display-only. Destination cards never fetch Amber;
     they only read real stats previously derived from a city inventory response. */
  const [cityStats, setCityStats] = useState({});

  useEffect(() => {
    let cancelled = false;
    async function loadCachedCityStats() {
      // IndexedDB reads only: a cache miss intentionally stays blank.
      const results = await Promise.all(DESTINATIONS.map(async (d) => [d.name, await getCachedCityStats(d.name)]));
      if (cancelled) return;
      const updates = Object.fromEntries(results.filter(([, stats]) => stats));
      if (Object.keys(updates).length) setCityStats((prev) => ({ ...prev, ...updates }));
    }
    loadCachedCityStats();
    return () => { cancelled = true; };
  }, []);
  const totalVerifiedProperties = useMemo(
    () => Object.values(cityStats).reduce((sum, s) => sum + (s.count || 0), 0),
    [cityStats]
  );
  const statsLoadedCount = Object.keys(cityStats).length;

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
                <h1>
                  <span className="hero-h1-line1">From housing to hiring —</span>
                  <br />
                  <span className="hero-h1-line2">we've got you covered, globally</span>
                </h1>
                <p className="hero-sub-tagline">Verified student homes, matched to your university and budget.</p>
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
                <svg className="hero-search-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <circle cx="11" cy="11" r="7" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                <input
                  type="text"
                  className="hero-search-input"
                  placeholder="Search by city, university or property"
                  value={searchValue}
                  onChange={(e) => { setSearchValue(e.target.value); setSuggestionsOpen(true); }}
                  onFocus={() => setSuggestionsOpen(true)}
                  onBlur={() => setTimeout(() => setSuggestionsOpen(false), 150)}
                  aria-label="Search by city, university or property"
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
              <button type="submit" className="hero-search-btn">Find Rooms →</button>
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

      {/* POPULAR CITIES */}
      <section className="section discovery-section">
        <div className="section-heading">
          <p className="section-eyebrow">Popular Cities</p>
          <h2 className="section-title">Popular Cities Across The Globe</h2>
          <p className="section-copy">
            Book student accommodations near top cities and universities around the world.
            {statsLoadedCount > 0 && (
              <> <strong>{totalVerifiedProperties}+</strong> verified properties live across our {statsLoadedCount} popular cities right now.</>
            )}
          </p>
        </div>
        <div className="city-tab-row" role="group" aria-label="Filter popular cities by country">
          {popularCountryTabs.map((tab) => (
            <button
              key={tab.code}
              type="button"
              className={`pill-btn${tab.code === popularCountry ? " active" : ""}`}
              aria-pressed={tab.code === popularCountry}
              onClick={() => setPopularCountry(tab.code)}
            >
              <span aria-hidden="true">{tab.flag}</span> {tab.label}
            </button>
          ))}
        </div>
        <ul className="city-grid">
          {visibleDestinations.map((city) => (
            <CityCard key={`${city.name}-${city.country}`} city={city} compact />
          ))}
        </ul>
      </section>

      {/* TRUST BADGES */}
      <TrustStrip />

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