import React, { useEffect, useState, useRef, lazy, Suspense } from "react";
import { BrowserRouter as Router, Routes, Route, Link, useLocation } from "react-router-dom";
import "./App.css";
import SiteFooter from "./SiteFooter";
import SiteNavbar from "./SiteNavbar";
import { ROOM_TYPES } from "./data/accommodations";

const AccommodationFinderPage = lazy(() => import("./AccommodationFinderPage"));
const PropertyDetailPage       = lazy(() => import("./PropertyDetailPage"));
const LifeAbroadPage           = lazy(() => import("./LifeAbroadPage"));
const ListYourStayPage         = lazy(() => import("./ListYourStayPage"));
const ContactPage              = lazy(() => import("./ContactPage"));
const PartnerPage              = lazy(() => import("./PartnerPage"));
const TermsPage                = lazy(() => import("./TermsPage"));
const PrivacyPage              = lazy(() => import("./PrivacyPage"));

/* ── SCROLL TO TOP ON ROUTE CHANGE ── */
function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => { window.scrollTo(0, 0); }, [pathname]);
  return null;
}

/* ── HOME PAGE ── */
function Home() {
  const [whyActive, setWhyActive] = useState(0);
  const [hutsVisible, setHutsVisible] = useState(true);
  const [hutsBottom, setHutsBottom] = useState(0);
  const whyRef = useRef(null);
  const heroRef = useRef(null);
  const purpleBoxRef = useRef(null);
  const hutsStopRef = useRef(null);

  const whyBoxRef = useRef(null);

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
            <h1>We show you 14 rooms in person</h1>
            <ul className="hero-pointers">
              <li>Data driven: best rooms for your budget</li>
              <li>IIM community events</li>
              <li>IVYhuts placement cell keeps floating internships and full time roles</li>
            </ul>
            <div className="hero-actions">
              <Link to="/find-rooms" className="primary-btn">Find My Stay →</Link>
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
              fetchpriority="high"
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

      {/* HOW IT WORKS */}
      <section className="section hiw-section">
        <p className="section-eyebrow">Simple and Hassle-Free</p>
        <h2 className="section-title">How IvyHuts Works</h2>
        <div className="section-underline" />
        <div className="hiw-steps">
          <div className="hiw-step">
            <div className="hiw-num">1</div>
            <h3>Tell Us Your Needs</h3>
            <p>Fill our quick form with your university, preferred country, budget, and move-in date. Takes under 3 minutes.</p>
          </div>
          <div className="hiw-arrow">→</div>
          <div className="hiw-step">
            <div className="hiw-num">2</div>
            <h3>We Search For You</h3>
            <p>Our team searches verified properties near your campus that match your budget, room type, and timeline.</p>
          </div>
          <div className="hiw-arrow">→</div>
          <div className="hiw-step">
            <div className="hiw-num">3</div>
            <h3>Receive Your Options</h3>
            <p>We reach out within 24 hours via WhatsApp or email with a personalised set of rooms handpicked for you.</p>
          </div>
          <div className="hiw-arrow">→</div>
          <div className="hiw-step">
            <div className="hiw-num">4</div>
            <h3>Move In Happy</h3>
            <p>Confirm your choice, complete the booking with our full support, and arrive to a ready-to-live-in home.</p>
          </div>
        </div>
      </section>

      {/* POPULAR CITIES */}
      <section className="section cities-section">
        <p className="section-eyebrow">Where We Operate</p>
        <h2 className="section-title">Popular Student Cities</h2>
        <div className="section-underline" />
        <div className="cities-scroll-wrap">
          <div className="cities-grid">
            {[
              { name: "London",    country: "UK",        flag: "🇬🇧", currency: "£",   avgPricePerWeek: 285 },
              { name: "Manchester",country: "UK",        flag: "🇬🇧", currency: "£",   avgPricePerWeek: 190 },
              { name: "Toronto",   country: "Canada",    flag: "🇨🇦", currency: "CA$", avgPricePerWeek: 550 },
              { name: "Sydney",    country: "Australia", flag: "🇦🇺", currency: "A$",  avgPricePerWeek: 450 },
              { name: "Melbourne", country: "Australia", flag: "🇦🇺", currency: "A$",  avgPricePerWeek: 420 },
              { name: "New York",  country: "USA",       flag: "🇺🇸", currency: "$",   avgPricePerWeek: 510 },
              { name: "Berlin",    country: "Germany",   flag: "🇩🇪", currency: "€",   avgPricePerWeek: 160 },
              { name: "Paris",     country: "France",    flag: "🇫🇷", currency: "€",   avgPricePerWeek: 230 },
            ].map((city) => (
              <div
                key={`${city.name}-${city.country}`}
                className="city-card"
              >
                <div className="city-flag">{city.flag}</div>
                <div className="city-info">
                  <div className="city-name">{city.name}</div>
                  <div className="city-country">{city.country}</div>
                </div>
                <div className="city-meta">
                  <div className="city-price">from {city.currency}{city.avgPricePerWeek}/wk</div>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="cities-cta">
          <Link to="/find-rooms" className="view-all-btn">Browse All Rooms →</Link>
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

/* ── MAIN APP ── */
function App() {
  return (
    <Router>
      <ScrollToTop />
      <Suspense fallback={<div style={{ minHeight: "100vh", background: "#FBF4F8" }} />}>
        <Routes>
          <Route path="/"               element={<Home />} />
          <Route path="/find-rooms"     element={<AccommodationFinderPage />} />
          <Route path="/property/:id"   element={<PropertyDetailPage />} />
          <Route path="/life-abroad"    element={<LifeAbroadPage />} />
          <Route path="/list-your-stay" element={<ListYourStayPage />} />
          <Route path="/contact"        element={<ContactPage />} />
          <Route path="/partner"        element={<PartnerPage />} />
          <Route path="/terms"          element={<TermsPage />} />
          <Route path="/privacy"        element={<PrivacyPage />} />
        </Routes>
      </Suspense>
    </Router>
  );
}

export default App;
