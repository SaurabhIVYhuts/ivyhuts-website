import React from "react";
import { Link } from "react-router-dom";

export default function SiteFooter() {
  return (
    <footer className="footer">
      <div className="footer-inner">
        <div className="footer-brand">
          <span className="footer-logo-ivy">IVY</span><span className="footer-logo-huts">huts</span>
          <p className="footer-tagline">A Venture By IIM Alums</p>
          <p>Verified student accommodation across multiple countries. Find your home, stress-free.</p>
        </div>
        <div className="footer-links">
          <h4>Destinations</h4>
          <Link to="/find-rooms">UK</Link>
          <Link to="/find-rooms">Canada</Link>
          <Link to="/find-rooms">Australia</Link>
          <Link to="/find-rooms">USA</Link>
          <Link to="/find-rooms">Germany</Link>
          <Link to="/find-rooms">Ireland</Link>
          <Link to="/find-rooms">Netherlands</Link>
          <Link to="/find-rooms">More Countries</Link>
        </div>
        <div className="footer-links">
          <h4>Services</h4>
          <span>Airport Pickup</span>
          <span>Bank Account Setup</span>
          <span>SIM Card Help</span>
          <span>Guarantor Service</span>
          <Link to="/life-abroad">Placement Podcast</Link>
        </div>
        <div className="footer-links">
          <h4>Company</h4>
          <Link to="/contact">Contact Us</Link>
          <Link to="/partner">Partner with Us</Link>
          <Link to="/list-your-stay">List Your Stay</Link>
          <Link to="/terms">Terms of Service</Link>
          <Link to="/privacy">Privacy Policy</Link>
        </div>
        <div className="footer-links">
          <h4>Get in Touch</h4>
          <span>saurabh@ivyhuts.com</span>
          <span>WhatsApp: +91 884 772 5089</span>
          <Link to="/find-rooms">Find Accommodation</Link>
        </div>
      </div>
      <div className="footer-bottom">
        <span>© 2026 IvyHuts. All rights reserved. Built by IIM grads.</span>
      </div>
    </footer>
  );
}
