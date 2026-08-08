import React, { useState, useEffect } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";

export default function SiteNavbar() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchValue, setSearchValue] = useState("");
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // The homepage already has its own prominent hero search — the navbar search
  // is for every other page, matching Amber's pattern of a persistent search
  // that only steps aside for a dedicated hero.
  const showSearch = pathname !== "/";

  const links = [
    { to: "/",               label: "Home" },
    { to: "/find-rooms",     label: "Find Rooms" },
    { to: "/life-abroad",    label: "Placement Podcast" },
    { to: "/list-your-stay", label: "List Your Stay" },
    { to: "/partner",        label: "Partner with Us" },
    { to: "/contact",        label: "Contact Us" },
  ];

  const close = () => setMenuOpen(false);

  const submitSearch = (e) => {
    e.preventDefault();
    const clean = searchValue.trim();
    if (!clean) return;
    navigate(`/properties?city=${encodeURIComponent(clean)}`);
  };

  const searchForm = (className) => (
    <form className={className} role="search" onSubmit={submitSearch}>
      <input
        type="text"
        value={searchValue}
        onChange={(e) => setSearchValue(e.target.value)}
        placeholder="Search by city, university or property"
        aria-label="Search by city, university or property"
      />
      <button type="submit" aria-label="Search">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="7" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
      </button>
    </form>
  );

  return (
    <>
      <nav className={`navbar${scrolled ? " navbar-scrolled" : ""}`}>
        <div className="logo">
          <Link to="/" style={{ textDecoration: "none" }} onClick={close}>
            <span className="logo-ivy">IVY</span><span className="logo-huts">huts</span>
          </Link>
        </div>

        {showSearch && searchForm("navbar-search-form navbar-search-desktop")}

        {/* Desktop nav */}
        <div className="nav-links">
          {links.map(({ to, label }) => (
            <Link key={to} to={to} className={pathname === to ? "nav-link nav-active" : "nav-link"}>
              {label}
            </Link>
          ))}
        </div>

        {/* Mobile right side — hamburger */}
        <div className="nav-mobile-right">
          <button className="nav-hamburger" onClick={() => setMenuOpen(o => !o)} aria-label="Toggle menu" aria-expanded={menuOpen}>
            <span className={`ham-line${menuOpen ? " ham-top-open" : ""}`} />
            <span className={`ham-line${menuOpen ? " ham-mid-open" : ""}`} />
            <span className={`ham-line${menuOpen ? " ham-bot-open" : ""}`} />
          </button>
        </div>
      </nav>

      {showSearch && (
        <div className="navbar-search-mobile-wrap">
          {searchForm("navbar-search-form navbar-search-mobile")}
        </div>
      )}

      {/* Mobile dropdown */}
      {menuOpen && (
        <div className="mobile-nav">
          {links.map(({ to, label }) => (
            <Link key={to} to={to} className={pathname === to ? "mobile-nav-link mobile-nav-active" : "mobile-nav-link"} onClick={close}>
              {label}
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
