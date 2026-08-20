import React, { useEffect, useRef } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  X, Headset, Heart, Search, Mic, Handshake, Building2, Mail, FileText, Lock, ArrowRight, GraduationCap,
} from "lucide-react";
import "./MobileMenuSheet.css";

const WA_HREF = `https://wa.me/918847725089?text=${encodeURIComponent("Hi IvyHuts! I'm looking for student accommodation abroad. Can you help?")}`;

// Mirrors amberstudent.com's real mobile hamburger — a short flat list of
// action rows (not the grouped Destinations/Services/Company accordion,
// which lives in the footer instead, same as on Amber) — plus a sticky
// Login button at the bottom instead of Amber's own. Find Rooms and
// Placement Podcast are folded in here since neither has a bottom-tab slot
// anymore (see MobileBottomNav.js).
// Milestone 10: University Housing listed ahead of Find Rooms — now the
// primary accommodation-discovery experience. Find Rooms is kept (not
// removed): real, unmigrated capability still lives there (see
// IVYHUTS_FIND_ROOM_FEATURE_PARITY.md).
const PRIMARY_ROWS = [
  { label: "Support", href: WA_HREF, external: true, Icon: Headset },
  { label: "Shortlist", to: "/wishlist", Icon: Heart },
  { label: "University Housing", to: "/university-housing", Icon: GraduationCap },
  { label: "Find Rooms", to: "/find-rooms", Icon: Search },
  { label: "Placement Podcast", to: "/life-abroad", Icon: Mic },
];
const PARTNER_ROWS = [
  { label: "Partner with Us", to: "/partner", Icon: Handshake },
  { label: "List with Us", to: "/list-your-stay", Icon: Building2 },
];
// Not present in Amber's own hamburger, but these routes exist on IvyHuts
// and every header/footer link needs to stay reachable from the menu.
const LEGAL_ROWS = [
  { label: "Contact Us", to: "/contact", Icon: Mail },
  { label: "Terms of Service", to: "/terms", Icon: FileText },
  { label: "Privacy Policy", to: "/privacy", Icon: Lock },
];

function Row({ label, to, href, external, Icon }) {
  const content = (
    <>
      <Icon className="mobile-menu-sheet-row-icon" strokeWidth={1.6} aria-hidden="true" />
      <span>{label}</span>
    </>
  );
  if (href) {
    return (
      <a href={href} target={external ? "_blank" : undefined} rel={external ? "noopener noreferrer" : undefined} className="mobile-menu-sheet-row">
        {content}
      </a>
    );
  }
  return (
    <Link to={to} className="mobile-menu-sheet-row">
      {content}
    </Link>
  );
}

export default function MobileMenuSheet({ isOpen, onClose }) {
  const { pathname } = useLocation();
  const sheetRef = useRef(null);
  const closeBtnRef = useRef(null);

  // Close on route change.
  useEffect(() => {
    if (isOpen) onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  // Lock body scroll while open, restore on close/unmount.
  useEffect(() => {
    if (!isOpen) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previousOverflow; };
  }, [isOpen]);

  // Focus the close button on open; trap Tab within the sheet; close on Escape.
  useEffect(() => {
    if (!isOpen) return undefined;
    closeBtnRef.current?.focus();

    const handleKeyDown = (e) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab" || !sheetRef.current) return;
      const focusable = sheetRef.current.querySelectorAll(
        'a[href], button:not([disabled])'
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="mobile-menu-sheet" role="dialog" aria-modal="true" aria-label="Menu" ref={sheetRef}>
      <div className="mobile-menu-sheet-header">
        <span className="mobile-menu-sheet-title">Menu</span>
        <button type="button" className="mobile-menu-sheet-close" onClick={onClose} aria-label="Close menu" ref={closeBtnRef}>
          <X size={22} />
        </button>
      </div>

      <div className="mobile-menu-sheet-body">
        <div className="mobile-menu-sheet-group">
          {PRIMARY_ROWS.map((row) => <Row key={row.label} {...row} />)}
        </div>
        <div className="mobile-menu-sheet-group">
          {PARTNER_ROWS.map((row) => <Row key={row.label} {...row} />)}
        </div>
        <div className="mobile-menu-sheet-group">
          {LEGAL_ROWS.map((row) => <Row key={row.label} {...row} />)}
        </div>
      </div>

      <Link to="/login" className="mobile-menu-sheet-cta">
        <ArrowRight size={18} aria-hidden="true" />
        Login
      </Link>
    </div>
  );
}
