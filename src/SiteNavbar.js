import React, { useState } from "react";
import { Link, useLocation } from "react-router-dom";

const WA_HREF = `https://wa.me/918847725089?text=${encodeURIComponent("Hi IvyHuts! I'm looking for student accommodation abroad. Can you help?")}`;

const WA_SVG = (
  <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
    <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/>
    <path d="M12 0C5.373 0 0 5.373 0 12c0 2.123.554 4.118 1.528 5.847L.057 23.428a.75.75 0 0 0 .916.916l5.569-1.47A11.952 11.952 0 0 0 12 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 22a9.956 9.956 0 0 1-5.065-1.378l-.363-.214-3.762.993.993-3.648-.234-.374A9.956 9.956 0 0 1 2 12C2 6.477 6.477 2 12 2s10 4.477 10 10-4.477 10-10 10z"/>
  </svg>
);

export default function SiteNavbar() {
  const { pathname } = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);

  const links = [
    { to: "/",               label: "Home" },
    { to: "/find-rooms",     label: "Find Rooms" },
    { to: "/life-abroad",    label: "Placement Podcast" },
    { to: "/list-your-stay", label: "List Your Stay" },
    { to: "/partner",        label: "Partner with Us" },
    { to: "/contact",        label: "Contact Us" },
  ];

  const close = () => setMenuOpen(false);

  return (
    <>
      <nav className="navbar">
        <div className="logo">
          <Link to="/" style={{ textDecoration: "none" }} onClick={close}>
            <span className="logo-ivy">IVY</span><span className="logo-huts">huts</span>
          </Link>
        </div>

        {/* Desktop nav */}
        <div className="nav-links">
          {links.map(({ to, label }) => (
            <Link key={to} to={to} className={pathname === to ? "nav-link nav-active" : "nav-link"}>
              {label}
            </Link>
          ))}
          <a href={WA_HREF} target="_blank" rel="noopener noreferrer" className="nav-wa-btn" aria-label="Chat on WhatsApp">
            {WA_SVG}
          </a>
        </div>

        {/* Mobile right side — WA icon + hamburger */}
        <div className="nav-mobile-right">
          <a href={WA_HREF} target="_blank" rel="noopener noreferrer" className="nav-wa-btn" aria-label="Chat on WhatsApp">
            {WA_SVG}
          </a>
          <button className="nav-hamburger" onClick={() => setMenuOpen(o => !o)} aria-label="Toggle menu" aria-expanded={menuOpen}>
            <span className={`ham-line${menuOpen ? " ham-top-open" : ""}`} />
            <span className={`ham-line${menuOpen ? " ham-mid-open" : ""}`} />
            <span className={`ham-line${menuOpen ? " ham-bot-open" : ""}`} />
          </button>
        </div>
      </nav>

      {/* Mobile dropdown */}
      {menuOpen && (
        <div className="mobile-nav">
          {links.map(({ to, label }) => (
            <Link key={to} to={to} className={pathname === to ? "mobile-nav-link mobile-nav-active" : "mobile-nav-link"} onClick={close}>
              {label}
            </Link>
          ))}
          <a href={WA_HREF} target="_blank" rel="noopener noreferrer" className="mobile-nav-link mobile-nav-wa" onClick={close}>
            <span style={{ color: "#25D366", fontWeight: 700 }}>WhatsApp Us</span>
          </a>
        </div>
      )}
    </>
  );
}
