import React from "react";
import { Link, useLocation } from "react-router-dom";
import { Compass, Heart, Headset, User } from "lucide-react";
import "./MobileBottomNav.css";

const WA_HREF = `https://wa.me/918847725089?text=${encodeURIComponent("Hi IvyHuts! I'm looking for student accommodation abroad. Can you help?")}`;

// Matches amberstudent.com's real mobile tab set (Explore / Wishlist /
// Support / Profile) rather than the earlier "Find Rooms" placeholder tab —
// Find Rooms stays reachable via the hero's own sticky search and the menu
// sheet instead, same as on Amber. IvyHuts has no dedicated account/profile
// page yet (see LoginPage.js), so Profile routes to the one real auth
// entry point, /login, mirroring Amber's own "log in first" gate.
const TABS = [
  { key: "explore", label: "Explore", to: "/", Icon: Compass, isActive: (p) => p === "/" },
  { key: "wishlist", label: "Wishlist", to: "/wishlist", Icon: Heart, isActive: (p) => p === "/wishlist" },
];

export default function MobileBottomNav() {
  const { pathname } = useLocation();

  // Two stacked fixed bars (this + the detail page's sticky Enquire bar)
  // would eat ~140px of a 667px screen, so the tab bar steps aside here.
  if (pathname.startsWith("/property/")) return null;

  return (
    <nav className="mobile-bottom-nav" aria-label="Primary">
      {TABS.map(({ key, label, to, Icon, isActive }) => {
        const active = isActive(pathname);
        return (
          <Link
            key={key}
            to={to}
            className={`mobile-bottom-nav-item${active ? " active" : ""}`}
            aria-current={active ? "page" : undefined}
          >
            <Icon className="mobile-bottom-nav-icon" strokeWidth={1.6} aria-hidden="true" />
            <span className="mobile-bottom-nav-label">{label}</span>
          </Link>
        );
      })}
      <a
        href={WA_HREF}
        target="_blank"
        rel="noopener noreferrer"
        className="mobile-bottom-nav-item"
      >
        <Headset className="mobile-bottom-nav-icon" strokeWidth={1.6} aria-hidden="true" />
        <span className="mobile-bottom-nav-label">Support</span>
      </a>
      <Link
        to="/login"
        className={`mobile-bottom-nav-item${pathname === "/login" ? " active" : ""}`}
        aria-current={pathname === "/login" ? "page" : undefined}
      >
        <User className="mobile-bottom-nav-icon" strokeWidth={1.6} aria-hidden="true" />
        <span className="mobile-bottom-nav-label">Profile</span>
      </Link>
    </nav>
  );
}
