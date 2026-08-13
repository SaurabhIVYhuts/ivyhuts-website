import React from "react";
import { Link } from "react-router-dom";
import "./ThankYouPage.css";

// Reached only after an enquiry form's submission has actually been
// confirmed successful (see e.g. src/pages/ContactPage.js's handleSubmit).
// Deliberately not linked from the navbar/footer/sitemap — a visitor
// landing here directly (bookmark, refresh, back/forward) sees the exact
// same static confirmation and nothing tracking-related fires from this
// page itself.
export default function ThankYouPage() {
  return (
    <div className="ty-page">
      <div className="ty-card">
        <Link to="/" className="ty-logo" aria-label="IVYhuts home">
          <img src="/logo.png" alt="" width="30" height="30" />
          <span>IVYhuts</span>
        </Link>

        <div className="ty-check" aria-hidden="true">
          <svg viewBox="0 0 56 56" fill="none" width="60" height="60">
            <circle className="ty-check-ring" cx="28" cy="28" r="26" stroke="url(#ty-grad)" strokeWidth="2.5" />
            <path className="ty-check-mark" d="M16 28l8 8 16-16" stroke="#5E3A6B" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
            <defs>
              <linearGradient id="ty-grad" x1="0" y1="0" x2="56" y2="56" gradientUnits="userSpaceOnUse">
                <stop stopColor="#5E3A6B" />
                <stop offset="1" stopColor="#B07898" />
              </linearGradient>
            </defs>
          </svg>
        </div>

        <h1 className="ty-title">Thank You!</h1>
        <p className="ty-sub">We've received your enquiry.</p>
        <p className="ty-sub ty-sub-muted">Our team will get in touch with you shortly.</p>

        <div className="ty-actions">
          <Link to="/" className="btn btn-primary btn-block ty-cta">Back to Homepage</Link>
          <Link to="/find-rooms" className="btn btn-secondary btn-block ty-cta">Explore Rooms</Link>
        </div>
      </div>
    </div>
  );
}
