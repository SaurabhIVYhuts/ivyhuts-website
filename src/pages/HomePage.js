import React, { useState, useRef, useEffect, useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";
import SiteFooter from "../components/layout/SiteFooter";
import SiteNavbar from "../components/layout/SiteNavbar";
import "./HomePage.css";
import { ROOM_TYPES } from "../data/accommodations.backup";
import CityCard from "../components/cards/CityCard";
import CompactPropertyCard from "../components/listing/CompactPropertyCard";
import { getProperties, getPropertyBySlug, getCityStats } from "../services/amberApi";
import { mapAmberPropertyToListing, safeListingList } from "../services/amberMapper";
import { getRecentSearches, getRecentProperties } from "../services/recentActivity";
import { DESTINATIONS, COUNTRIES } from "../data/destinations";

function HomePage() {
  const navigate = useNavigate();
  const [whyActive, setWhyActive] = useState(0);
  const [hutsVisible, setHutsVisible] = useState(true);
  const [hutsBottom, setHutsBottom] = useState(0);
  const whyRef = useRef(null);
  const heroRef = useRef(null);
  const purpleBoxRef = useRef(null);
  const hutsStopRef = useRef(null);

  const whyBoxRef = useRef(null);

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

  /* ── RECENT SEARCHES ── */
  const [recentSearches, setRecentSearches] = useState([]);
  useEffect(() => { setRecentSearches(getRecentSearches()); }, []);

  /* ── CONTINUE EXPLORING / POPULAR STUDENT HOMES ── */
  const [continueListings, setContinueListings] = useState([]);
  const [continueTitle, setContinueTitle] = useState("Continue Exploring");
  const [continueLoading, setContinueLoading] = useState(true);
  const [continueError, setContinueError] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function loadContinue() {
      setContinueLoading(true);
      setContinueError(false);
      const recent = getRecentProperties();

      try {
        if (recent.length > 0) {
          const raws = await Promise.all(recent.map((r) => getPropertyBySlug(r.slug).catch(() => null)));
          const mapped = raws.filter(Boolean).map(mapAmberPropertyToListing).filter(Boolean);
          if (mapped.length > 0) {
            if (!cancelled) {
              setContinueListings(mapped);
              setContinueTitle("Continue Exploring");
            }
            return;
          }
        }
        // No history yet (or none of those properties resolved) — show real popular homes instead.
        const fallback = await getProperties(DESTINATIONS[0].name, 1, 6);
        if (!cancelled) {
          setContinueListings(safeListingList(fallback));
          setContinueTitle("Popular Student Homes");
        }
      } catch (err) {
        console.error("HomePage continue-exploring error:", err);
        if (!cancelled) setContinueError(true);
      } finally {
        if (!cancelled) setContinueLoading(false);
      }
    }

    loadContinue();
    return () => { cancelled = true; };
  }, []);

  /* ── REAL PER-CITY STATS FOR POPULAR DESTINATIONS ──
     amberApi throttles/caches every request centrally now, so this can just
     ask for all of them — the service layer paces the actual network calls
     and repeat visits within the cache window cost nothing at all. */
  const [cityStats, setCityStats] = useState({});
  useEffect(() => {
    let cancelled = false;

    async function loadCityStats() {
      const results = await Promise.all(DESTINATIONS.map((d) => getCityStats(d.name).then((stats) => [d.name, stats])));
      if (cancelled) return;
      const updates = Object.fromEntries(results.filter(([, stats]) => stats));
      if (Object.keys(updates).length) setCityStats((prev) => ({ ...prev, ...updates }));
    }

    loadCityStats();
    return () => { cancelled = true; };
  }, []);

  const totalVerifiedProperties = useMemo(
    () => Object.values(cityStats).reduce((sum, s) => sum + (s.count || 0), 0),
    [cityStats]
  );
  const statsLoadedCount = Object.keys(cityStats).length;

  /* ── EXPLORE BY COUNTRY / CITY ── */
  const [activeCountry, setActiveCountry] = useState(COUNTRIES[0]);
  const citiesForCountry = useMemo(() => DESTINATIONS.filter((d) => d.country === activeCountry), [activeCountry]);
  const [activeCity, setActiveCity] = useState(citiesForCountry[0]?.name || null);
  const [exploreCache, setExploreCache] = useState({});
  const [exploreLoading, setExploreLoading] = useState(false);

  useEffect(() => {
    const first = DESTINATIONS.find((d) => d.country === activeCountry);
    setActiveCity(first ? first.name : null);
  }, [activeCountry]);

  useEffect(() => {
    if (!activeCity || exploreCache[activeCity]) return;
    let cancelled = false;
    setExploreLoading(true);
    getProperties(activeCity, 1, 8)
      .then((raw) => {
        if (cancelled) return;
        setExploreCache((prev) => ({ ...prev, [activeCity]: safeListingList(raw) }));
      })
      .catch((err) => console.error("HomePage explore error:", err))
      .finally(() => { if (!cancelled) setExploreLoading(false); });
    return () => { cancelled = true; };
  }, [activeCity, exploreCache]);

  const handleWhyScroll = (e) => {
    const el = e.currentTarget;
    const total = el.scrollHeight - el.clientHeight;
    const progress = total > 0 ? Math.max(0, Math.min(1, el.scrollTop / total)) : 0;
    setWhyActive(Math.min(5, Math.floor(progress * 6)));
  };

  useEffect(() => {
    const onScroll = () => {
      if (purpleBoxRef.current) {
        const rect = purpleBoxRef.current.getBoundingClientRect();
        setHutsVisible(rect.bottom > 72);
        setHutsBottom(Math.max(0, window.innerHeight - rect.bottom));
      }
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    const section = whyRef.current;
    if (!section) return;
    const handleWheel = (e) => {
      const box = whyBoxRef.current;
      if (!box) return;
      const atTop = box.scrollTop <= 0 && e.deltaY < 0;
      const atBottom = box.scrollTop >= box.scrollHeight - box.clientHeight - 1 && e.deltaY > 0;
      if (!atTop && !atBottom) {
        e.preventDefault();
        box.scrollTop += e.deltaY;
      }
    };
    section.addEventListener('wheel', handleWheel, { passive: false });
    return () => section.removeEventListener('wheel', handleWheel);
  }, []);


  return (
    <div>

      <SiteNavbar />

      <main>

      {/* HERO */}
      <section className="hero" ref={heroRef}>

        {/* Left building illustrations — on light bg sides */}
        <div className={`hero-huts-left${hutsVisible ? "" : " hero-huts-hidden"}`} style={{ bottom: hutsBottom }}>
          <svg viewBox="0 0 220 280" fill="none" xmlns="http://www.w3.org/2000/svg">
            {/* Cottage */}
            <rect x="6" y="168" width="84" height="96" rx="2" stroke="currentColor" strokeWidth="1.5" fill="rgba(94,58,107,0.05)"/>
            <path d="M0 168 L48 118 L96 168" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
            <rect x="64" y="124" width="9" height="28" rx="1" stroke="currentColor" strokeWidth="1.2" fill="rgba(94,58,107,0.05)"/>
            <rect x="61" y="122" width="15" height="4" rx="1" stroke="currentColor" strokeWidth="1.2"/>
            <rect x="11" y="180" width="22" height="18" rx="1" stroke="currentColor" strokeWidth="1.1"/>
            <line x1="22" y1="180" x2="22" y2="198" stroke="currentColor" strokeWidth="0.8"/>
            <line x1="11" y1="189" x2="33" y2="189" stroke="currentColor" strokeWidth="0.8"/>
            <rect x="59" y="180" width="22" height="18" rx="1" stroke="currentColor" strokeWidth="1.1"/>
            <line x1="70" y1="180" x2="70" y2="198" stroke="currentColor" strokeWidth="0.8"/>
            <line x1="59" y1="189" x2="81" y2="189" stroke="currentColor" strokeWidth="0.8"/>
            <rect x="37" y="218" width="22" height="46" rx="2" stroke="currentColor" strokeWidth="1.2"/>
            <circle cx="56" cy="242" r="1.5" stroke="currentColor" strokeWidth="1"/>
            {/* Tree */}
            <line x1="97" y1="152" x2="97" y2="168" stroke="currentColor" strokeWidth="1.2"/>
            <circle cx="97" cy="143" r="9" stroke="currentColor" strokeWidth="1.1"/>
            {/* Apartment */}
            <rect x="103" y="74" width="112" height="190" rx="2" stroke="currentColor" strokeWidth="1.5" fill="rgba(94,58,107,0.05)"/>
            <rect x="98" y="68" width="122" height="7" rx="1" stroke="currentColor" strokeWidth="1.2" fill="rgba(94,58,107,0.08)"/>
            <rect x="111" y="84" width="22" height="16" rx="1" stroke="currentColor" strokeWidth="1"/>
            <rect x="157" y="84" width="22" height="16" rx="1" stroke="currentColor" strokeWidth="1"/>
            <rect x="111" y="110" width="22" height="16" rx="1" stroke="currentColor" strokeWidth="1"/>
            <rect x="157" y="110" width="22" height="16" rx="1" stroke="currentColor" strokeWidth="1"/>
            <rect x="111" y="136" width="22" height="16" rx="1" stroke="currentColor" strokeWidth="1"/>
            <rect x="157" y="136" width="22" height="16" rx="1" stroke="currentColor" strokeWidth="1"/>
            <rect x="111" y="162" width="22" height="16" rx="1" stroke="currentColor" strokeWidth="1"/>
            <rect x="157" y="162" width="22" height="16" rx="1" stroke="currentColor" strokeWidth="1"/>
            <rect x="145" y="218" width="28" height="46" rx="2" stroke="currentColor" strokeWidth="1.2"/>
            <path d="M145 218 Q159 206 173 218" stroke="currentColor" strokeWidth="1" fill="none"/>
            <line x1="0" y1="264" x2="220" y2="264" stroke="currentColor" strokeWidth="1" strokeDasharray="4 3"/>
          </svg>
        </div>

        {/* Right building illustrations — same SVG, mirrored by CSS scaleX(-1) */}
        <div className={`hero-huts-right${hutsVisible ? "" : " hero-huts-hidden"}`} style={{ bottom: hutsBottom }}>
          <svg viewBox="0 0 220 280" fill="none" xmlns="http://www.w3.org/2000/svg">
            {/* Cottage */}
            <rect x="6" y="168" width="84" height="96" rx="2" stroke="currentColor" strokeWidth="1.5" fill="rgba(94,58,107,0.05)"/>
            <path d="M0 168 L48 118 L96 168" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
            <rect x="64" y="124" width="9" height="28" rx="1" stroke="currentColor" strokeWidth="1.2" fill="rgba(94,58,107,0.05)"/>
            <rect x="61" y="122" width="15" height="4" rx="1" stroke="currentColor" strokeWidth="1.2"/>
            <rect x="11" y="180" width="22" height="18" rx="1" stroke="currentColor" strokeWidth="1.1"/>
            <line x1="22" y1="180" x2="22" y2="198" stroke="currentColor" strokeWidth="0.8"/>
            <line x1="11" y1="189" x2="33" y2="189" stroke="currentColor" strokeWidth="0.8"/>
            <rect x="59" y="180" width="22" height="18" rx="1" stroke="currentColor" strokeWidth="1.1"/>
            <line x1="70" y1="180" x2="70" y2="198" stroke="currentColor" strokeWidth="0.8"/>
            <line x1="59" y1="189" x2="81" y2="189" stroke="currentColor" strokeWidth="0.8"/>
            <rect x="37" y="218" width="22" height="46" rx="2" stroke="currentColor" strokeWidth="1.2"/>
            <circle cx="56" cy="242" r="1.5" stroke="currentColor" strokeWidth="1"/>
            {/* Tree */}
            <line x1="97" y1="152" x2="97" y2="168" stroke="currentColor" strokeWidth="1.2"/>
            <circle cx="97" cy="143" r="9" stroke="currentColor" strokeWidth="1.1"/>
            {/* Apartment */}
            <rect x="103" y="74" width="112" height="190" rx="2" stroke="currentColor" strokeWidth="1.5" fill="rgba(94,58,107,0.05)"/>
            <rect x="98" y="68" width="122" height="7" rx="1" stroke="currentColor" strokeWidth="1.2" fill="rgba(94,58,107,0.08)"/>
            <rect x="111" y="84" width="22" height="16" rx="1" stroke="currentColor" strokeWidth="1"/>
            <rect x="157" y="84" width="22" height="16" rx="1" stroke="currentColor" strokeWidth="1"/>
            <rect x="111" y="110" width="22" height="16" rx="1" stroke="currentColor" strokeWidth="1"/>
            <rect x="157" y="110" width="22" height="16" rx="1" stroke="currentColor" strokeWidth="1"/>
            <rect x="111" y="136" width="22" height="16" rx="1" stroke="currentColor" strokeWidth="1"/>
            <rect x="157" y="136" width="22" height="16" rx="1" stroke="currentColor" strokeWidth="1"/>
            <rect x="111" y="162" width="22" height="16" rx="1" stroke="currentColor" strokeWidth="1"/>
            <rect x="157" y="162" width="22" height="16" rx="1" stroke="currentColor" strokeWidth="1"/>
            <rect x="145" y="218" width="28" height="46" rx="2" stroke="currentColor" strokeWidth="1.2"/>
            <path d="M145 218 Q159 206 173 218" stroke="currentColor" strokeWidth="1" fill="none"/>
            <line x1="0" y1="264" x2="220" y2="264" stroke="currentColor" strokeWidth="1" strokeDasharray="4 3"/>
          </svg>
        </div>

        {/* Purple content box — centered */}
        <div className="hero-purple-box" ref={purpleBoxRef}>
          <div className="hero-bg-ring" />
          <div className="hero-bg-lines" />
        <div className="hero-content">
          <div className="hero-text">
            <p className="hero-tagline">A Venture By IIM Alums</p>
            <h1>From housing to hiring - we've got you covered, globally</h1>
            <ul className="hero-pointers">
              <li>Data driven: best rooms for your budget</li>
              <li>IIM community events</li>
              <li>IVYhuts placement cell keeps floating internships and full time roles</li>
            </ul>

            {/* LIVE ACCOMMODATION SEARCH */}
            <form
              className="hero-search-form"
              role="search"
              onSubmit={(e) => { e.preventDefault(); runSearch(searchValue); }}
            >
              <div className="hero-search-input-wrap">
                <input
                  type="text"
                  className="hero-search-input"
                  placeholder="Search by city or university"
                  value={searchValue}
                  onChange={(e) => { setSearchValue(e.target.value); setSuggestionsOpen(true); }}
                  onFocus={() => setSuggestionsOpen(true)}
                  onBlur={() => setTimeout(() => setSuggestionsOpen(false), 150)}
                  aria-label="Search by city or university"
                  autoComplete="off"
                />
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
              <button type="submit" className="hero-search-btn">Search →</button>
            </form>

            <div className="hero-actions">
              <Link to="/find-rooms" className="hero-secondary-btn">Prefer we search for you? Fill our form →</Link>
            </div>
            <div className="hero-stats" ref={hutsStopRef}>
              <div className="hero-stat">
                <span className="hero-stat-num">15+</span>
                <span className="hero-stat-label">Countries</span>
              </div>
              <div className="hero-stat-divider" />
              <div className="hero-stat">
                <span className="hero-stat-num">50+</span>
                <span className="hero-stat-label">Cities</span>
              </div>
              <div className="hero-stat-divider" />
              <div className="hero-stat">
                <span className="hero-stat-num">100%</span>
                <span className="hero-stat-label">Verified</span>
              </div>
              <div className="hero-stat-divider" />
              <div className="hero-stat">
                <span className="hero-stat-num">Free</span>
                <span className="hero-stat-label">To Enquire</span>
              </div>
            </div>
          </div>
          <div className="hero-img-wrap">
            <img
              src="https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?w=600&q=80&auto=format&fit=crop"
              alt="Modern student accommodation interior"
              className="hero-img"
              width="600"
              height="400"
              fetchPriority="high"
              decoding="async"
            />
          </div>
        </div>
          {/* VIRTUAL TOUR BANNER — inside hero, visible on load */}
          <div className="rooms-promise-banner rooms-promise-in-hero">
            <div className="rooms-promise-inner">
              <div className="rooms-promise-icon">
                <svg viewBox="0 0 40 40" fill="none">
                  <circle cx="20" cy="20" r="16" stroke="currentColor" strokeWidth="2"/>
                  <path d="M16 14l10 6-10 6V14z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/>
                </svg>
              </div>
              <div className="rooms-promise-text">
                <strong>Book a free virtual tour</strong>
                <span>Start with a free virtual tour, then visit in person, compare rooms and finalize your booking</span>
              </div>
              <Link to="/contact" className="rooms-promise-cta">Get Started →</Link>
            </div>
          </div>
        </div>{/* end hero-purple-box */}
      </section>

      {/* RECENT SEARCHES — only shown when real search history exists */}
      {recentSearches.length > 0 && (
        <section className="section recent-searches-section">
          <div className="recent-searches-row">
            <span className="recent-searches-label">Recent Searches</span>
            {recentSearches.map((s) => (
              <button key={s} type="button" className="pill-btn pill-btn-sm" onClick={() => runSearch(s)}>
                {s}
              </button>
            ))}
          </div>
        </section>
      )}

      {/* CONTINUE EXPLORING / POPULAR STUDENT HOMES */}
      {!continueError && (continueLoading || continueListings.length > 0) && (
        <section className="section">
          <div className="section-heading">
            <p className="section-eyebrow">Pick Up Where You Left Off</p>
            <h2 className="section-title">{continueTitle}</h2>
          </div>
          <div className="chp-row">
            {continueLoading
              ? Array.from({ length: 4 }).map((_, i) => <div key={i} className="chp-skeleton" />)
              : continueListings.map((listing) => <CompactPropertyCard key={listing.id} listing={listing} />)}
          </div>
        </section>
      )}

      {/* TRUST BADGES */}
      <section className="trust-strip">
        <div className="trust-strip-inner">
          <div className="trust-badge">
            <svg className="trust-icon" viewBox="0 0 32 32" fill="none"><circle cx="16" cy="16" r="15" stroke="#5E3A6B" strokeWidth="2"/><path d="M9 16.5l4.5 4.5 9-9" stroke="#5E3A6B" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
            <div>
              <div className="trust-label">100% Verified</div>
              <div className="trust-sub">Every listing checked</div>
            </div>
          </div>
          <div className="trust-divider" />
          <div className="trust-badge">
            <svg className="trust-icon" viewBox="0 0 32 32" fill="none"><path d="M16 3l11 4v8c0 6-4.5 10.5-11 13C9.5 25.5 5 21 5 15V7l11-4z" stroke="#2E7D32" strokeWidth="2" strokeLinejoin="round"/><path d="M11 16l3.5 3.5 6-6" stroke="#2E7D32" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
            <div>
              <div className="trust-label">No Visa No Pay</div>
              <div className="trust-sub">Full refund if visa refused</div>
            </div>
          </div>
          <div className="trust-divider" />
          <div className="trust-badge">
            <svg className="trust-icon" viewBox="0 0 32 32" fill="none"><rect x="4" y="9" width="24" height="16" rx="3" stroke="#C8960C" strokeWidth="2"/><path d="M4 14h24" stroke="#C8960C" strokeWidth="2"/><circle cx="10" cy="20" r="2" fill="#C8960C"/></svg>
            <div>
              <div className="trust-label">No Hidden Fees</div>
              <div className="trust-sub">Price shown is price paid</div>
            </div>
          </div>
          <div className="trust-divider" />
          <div className="trust-badge">
            <svg className="trust-icon" viewBox="0 0 32 32" fill="none"><circle cx="16" cy="16" r="13" stroke="#4A90D9" strokeWidth="2"/><path d="M13 13c0-1.7 1.3-3 3-3s3 1.3 3 3c0 2-3 2.5-3 5" stroke="#4A90D9" strokeWidth="2" strokeLinecap="round"/><circle cx="16" cy="22" r="1.2" fill="#4A90D9"/></svg>
            <div>
              <div className="trust-label">24/7 Support</div>
              <div className="trust-sub">Always here for you</div>
            </div>
          </div>
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
        <div className="city-grid">
          {DESTINATIONS.map((city) => (
            <CityCard
              key={`${city.name}-${city.country}`}
              city={{
                ...city,
                currency: cityStats[city.name] ? currencySymbolLocal(cityStats[city.name].currency) : null,
                price: cityStats[city.name]?.price ?? null,
                properties: cityStats[city.name]?.count ?? null,
              }}
            />
          ))}
        </div>
      </section>

      {/* EXPLORE BY COUNTRY / CITY */}
      <section className="section explore-section">
        <div className="section-heading">
          <p className="section-eyebrow">Discover</p>
          <h2 className="section-title">Explore Student Homes</h2>
          <p className="section-copy">Browse live, verified availability by country and city.</p>
        </div>

        <div className="explore-pill-row">
          {COUNTRIES.map((c) => (
            <button
              key={c}
              type="button"
              className={`pill-btn${c === activeCountry ? " active" : ""}`}
              onClick={() => setActiveCountry(c)}
            >
              {c}
            </button>
          ))}
        </div>

        <div className="explore-pill-row explore-pill-row-cities">
          {citiesForCountry.map((d) => (
            <button
              key={d.name}
              type="button"
              className={`pill-btn pill-btn-sm${d.name === activeCity ? " active" : ""}`}
              onClick={() => setActiveCity(d.name)}
            >
              {d.name}
            </button>
          ))}
        </div>

        <div className="chp-row">
          {exploreLoading && !exploreCache[activeCity]
            ? Array.from({ length: 4 }).map((_, i) => <div key={i} className="chp-skeleton" />)
            : (exploreCache[activeCity] || []).length > 0
              ? exploreCache[activeCity].slice(0, 8).map((listing) => <CompactPropertyCard key={listing.id} listing={listing} />)
              : <p className="explore-empty">No live listings found for {activeCity} right now.</p>}
        </div>
      </section>

      {/* ROOM TYPES */}
      <section className="section roomtypes-section">
        <p className="section-eyebrow">What We Offer</p>
        <h2 className="section-title">Find the Right Room Type</h2>
        <div className="section-underline" />
        <div className="roomtypes-scroll-wrap">
          <div className="roomtypes-grid">
            {ROOM_TYPES.map((rt) => (
              <div key={rt.type} className="roomtype-card">
                <div className="roomtype-name">{rt.type}</div>
                <div className="roomtype-desc">{rt.description}</div>
                <div className="roomtype-footer">
                  <span className="roomtype-best">Best for: {rt.bestFor}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* WHY IVYHUTS — internal scroll stacking cards */}
      <section className="why-section" ref={whyRef}>
        <p className="section-eyebrow">Why Choose Us</p>
        <h2 className="section-title">Built for Students Like You</h2>
        <div className="section-underline" />
        <div className="why-scroll-box" ref={whyBoxRef} onScroll={handleWhyScroll}>
          <div className="why-sticky-win">
            <div className="why-deck">
              <div className={`why-stack-card${whyActive >= 0 ? ' wc-on' : ''}`} style={{zIndex:1,'--depth':Math.max(0,whyActive-0)}}>
                <svg className="why-icon" viewBox="0 0 44 44" fill="none"><rect x="8" y="12" width="28" height="22" rx="4" stroke="#5E3A6B" strokeWidth="2"/><path d="M15 12V9a7 7 0 0 1 14 0v3" stroke="#5E3A6B" strokeWidth="2" strokeLinecap="round"/><circle cx="22" cy="22" r="3" fill="#5E3A6B"/><path d="M22 25v3" stroke="#5E3A6B" strokeWidth="2" strokeLinecap="round"/></svg>
                <div className="why-card-text"><h3>Verified Listings Only</h3><p>Every property on IvyHuts is verified by our team. No scams, no fake listings. Just real, safe homes for students.</p></div>
              </div>
              <div className={`why-stack-card${whyActive >= 1 ? ' wc-on' : ''}`} style={{zIndex:2,'--depth':Math.max(0,whyActive-1)}}>
                <svg className="why-icon" viewBox="0 0 44 44" fill="none"><rect x="6" y="11" width="32" height="22" rx="4" stroke="#C8960C" strokeWidth="2"/><path d="M6 18h32" stroke="#C8960C" strokeWidth="2"/><circle cx="13" cy="27" r="2.5" fill="#C8960C"/><rect x="19" y="25" width="10" height="4" rx="2" fill="#C8960C" opacity=".35"/></svg>
                <div className="why-card-text"><h3>No Hidden Costs</h3><p>What you see is what you pay. Many of our listings include all bills, so you know exactly what you are committing to.</p></div>
              </div>
              <div className={`why-stack-card${whyActive >= 2 ? ' wc-on' : ''}`} style={{zIndex:3,'--depth':Math.max(0,whyActive-2)}}>
                <svg className="why-icon" viewBox="0 0 44 44" fill="none"><path d="M22 5l14 5v10c0 8-5.5 13.5-14 16C13.5 33.5 8 28 8 20V10l14-5z" stroke="#2E7D32" strokeWidth="2" strokeLinejoin="round"/><path d="M15 21l4.5 4.5 9-9" stroke="#2E7D32" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                <div className="why-card-text"><h3>No Visa No Pay</h3><p>Book with confidence. If your student visa is refused, you get a full refund. We carry the risk so you do not have to.</p></div>
              </div>
              <div className={`why-stack-card${whyActive >= 3 ? ' wc-on' : ''}`} style={{zIndex:4,'--depth':Math.max(0,whyActive-3)}}>
                <svg className="why-icon" viewBox="0 0 44 44" fill="none"><circle cx="22" cy="22" r="15" stroke="#4A90D9" strokeWidth="2"/><path d="M13 22a9 9 0 0 0 18 0" stroke="#4A90D9" strokeWidth="1.5" strokeDasharray="3 2"/><path d="M22 7v3M22 34v3M7 22h3M34 22h3" stroke="#4A90D9" strokeWidth="1.8" strokeLinecap="round"/><circle cx="22" cy="22" r="3.5" fill="#4A90D9"/></svg>
                <div className="why-card-text"><h3>International Student First</h3><p>Our team are international students and alumni. We understand exactly what you need when moving abroad for the first time.</p></div>
              </div>
              <div className={`why-stack-card${whyActive >= 4 ? ' wc-on' : ''}`} style={{zIndex:5,'--depth':Math.max(0,whyActive-4)}}>
                <svg className="why-icon" viewBox="0 0 44 44" fill="none"><circle cx="22" cy="14" r="6" stroke="#B07898" strokeWidth="2"/><path d="M10 36c0-6.6 5.4-12 12-12s12 5.4 12 12" stroke="#B07898" strokeWidth="2" strokeLinecap="round"/><path d="M30 20l4 2-4 2" stroke="#B07898" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/><path d="M34 22h-6" stroke="#B07898" strokeWidth="1.8" strokeLinecap="round"/></svg>
                <div className="why-card-text"><h3>Personal Advisor</h3><p>You get a dedicated advisor who handles your search end-to-end, negotiates on your behalf, and guides you through the process.</p></div>
              </div>
              <div className={`why-stack-card${whyActive >= 5 ? ' wc-on' : ''}`} style={{zIndex:6,'--depth':0}}>
                <svg className="why-icon" viewBox="0 0 44 44" fill="none"><circle cx="22" cy="22" r="15" stroke="#2E7D32" strokeWidth="2"/><path d="M16 22l4 4 8-8" stroke="#2E7D32" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/><path d="M22 12v2M22 30v2M12 22h2M30 22h2" stroke="#2E7D32" strokeWidth="1.5" strokeLinecap="round" opacity=".5"/></svg>
                <div className="why-card-text"><h3>Free to Use</h3><p>Our entire service is free for students. No subscription, no booking fees, no strings attached. We are paid by the property, not you.</p></div>
              </div>
            </div>
            <div className="why-dots">
              {[0,1,2,3,4,5].map(i => (
                <div key={i} className={`why-dot${i <= whyActive ? ' active' : ''}`} />
              ))}
            </div>
          </div>
          <div className="why-scroll-driver" />
        </div>
      </section>

      {/* SERVICES STRIP */}
      <section className="section services-section">
        <p className="section-eyebrow">Beyond Accommodation</p>
        <h2 className="section-title">Everything You Need to Settle In</h2>
        <div className="section-underline" />
        <div className="cards">
          <div className="service-card">
            <svg className="service-icon" viewBox="0 0 48 48" fill="none">
              <rect x="6" y="18" width="36" height="20" rx="5" stroke="#5E3A6B" strokeWidth="2"/>
              <path d="M14 18V14a10 10 0 0 1 20 0v4" stroke="#5E3A6B" strokeWidth="2" strokeLinecap="round"/>
              <path d="M24 10v4" stroke="#5E3A6B" strokeWidth="1.5" strokeLinecap="round"/>
              <circle cx="17" cy="28" r="2.5" fill="#5E3A6B"/>
              <circle cx="24" cy="28" r="2.5" fill="#B07898"/>
              <circle cx="31" cy="28" r="2.5" fill="#C8960C"/>
            </svg>
            <div className="service-title">Airport Pickup</div>
            <div className="service-subtitle">On arrival</div>
            <div className="service-desc">Arrange a trusted transfer from airport to your new home, day or night</div>
          </div>
          <div className="service-card">
            <svg className="service-icon" viewBox="0 0 48 48" fill="none">
              <rect x="6" y="14" width="36" height="24" rx="5" stroke="#2E7D32" strokeWidth="2"/>
              <path d="M6 21h36" stroke="#2E7D32" strokeWidth="2"/>
              <circle cx="13" cy="31" r="3" fill="#2E7D32"/>
              <rect x="20" y="29" width="14" height="5" rx="2.5" fill="#2E7D32" opacity=".3"/>
            </svg>
            <div className="service-title">Bank Account</div>
            <div className="service-subtitle">Setup support</div>
            <div className="service-desc">Get a local bank account open in your destination country before you land</div>
          </div>
          <div className="service-card">
            <svg className="service-icon" viewBox="0 0 48 48" fill="none">
              <rect x="14" y="6" width="20" height="36" rx="5" stroke="#4A90D9" strokeWidth="2"/>
              <rect x="18" y="10" width="12" height="6" rx="2" fill="#4A90D9" opacity=".3"/>
              <circle cx="24" cy="34" r="2.5" fill="#4A90D9"/>
              <path d="M20 20h8M20 25h5" stroke="#4A90D9" strokeWidth="1.8" strokeLinecap="round"/>
            </svg>
            <div className="service-title">SIM Card</div>
            <div className="service-subtitle">Stay connected</div>
            <div className="service-desc">We help you choose and activate the best local SIM plan for students</div>
          </div>
          <div className="service-card">
            <svg className="service-icon" viewBox="0 0 48 48" fill="none">
              <circle cx="24" cy="17" r="7" stroke="#C8960C" strokeWidth="2"/>
              <path d="M12 42c0-6.6 5.4-12 12-12s12 5.4 12 12" stroke="#C8960C" strokeWidth="2" strokeLinecap="round"/>
              <path d="M33 20l5-2v8l-5-2" stroke="#C8960C" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
              <rect x="33" y="18" width="8" height="12" rx="2" stroke="#C8960C" strokeWidth="1.8"/>
            </svg>
            <div className="service-title">Guarantor Service</div>
            <div className="service-subtitle">No local guarantor?</div>
            <div className="service-desc">We act as your guarantor so you can rent without barriers, no matter where you are from</div>
          </div>
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

      {/* CTA */}
      <section className="cta-section">
        <div className="cta-inner">
          <p className="cta-eyebrow">Ready to Find Your Home?</p>
          <h2>Your perfect student stay is one form away</h2>
          <p className="cta-sub">Tell us what you need and our team will do the rest. Free service, personalised results, within 24 hours.</p>
          <div className="cta-actions">
            <Link to="/find-rooms" className="primary-btn" style={{ display: "inline-block" }}>Find My Stay →</Link>
          </div>
        </div>
      </section>

      </main>

      {/* FOOTER */}
      <SiteFooter />

    </div>
  );
}

// Minimal local currency-word -> symbol map (mirrors amberMapper's, kept tiny
// and self-contained here since HomePage only needs it for city-stat badges).
function currencySymbolLocal(word) {
  const map = { pound: "£", gbp: "£", dollar: "$", usd: "$", euro: "€", eur: "€" };
  if (!word) return "";
  return map[String(word).toLowerCase()] || word;
}

export default HomePage;