import React from "react";
import { Link } from "react-router-dom";
import { socialLinks } from "../../config/socialLinks";
import { SOCIAL_ICONS } from "../icons/SocialIcons";

const MailIcon = () => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8">
    <rect x="3" y="5" width="18" height="14" rx="2.5" />
    <path d="M4 7l8 6 8-6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const WhatsAppIcon = () => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor">
    <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/>
    <path d="M12 0C5.373 0 0 5.373 0 12c0 2.123.554 4.118 1.528 5.847L.057 23.428a.75.75 0 0 0 .916.916l5.569-1.47A11.952 11.952 0 0 0 12 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 22a9.956 9.956 0 0 1-5.065-1.378l-.363-.214-3.762.993.993-3.648-.234-.374A9.956 9.956 0 0 1 2 12C2 6.477 6.477 2 12 2s10 4.477 10 10-4.477 10-10 10z"/>
  </svg>
);

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
          <a href="mailto:contact@ivyhuts.com" className="footer-contact-row"><MailIcon /> contact@ivyhuts.com</a>
          <a href="https://wa.me/918847725089" target="_blank" rel="noopener noreferrer" className="footer-contact-row"><WhatsAppIcon /> +91 884 772 5089</a>
          <Link to="/find-rooms">Find Accommodation</Link>
          <div className="footer-social-row">
            {SOCIAL_ICONS.map(({ key, label, Icon }) => {
              const href = socialLinks[key];
              const Tag = href ? "a" : "span";
              return (
                <Tag
                  key={key}
                  href={href || undefined}
                  target={href ? "_blank" : undefined}
                  rel={href ? "noopener noreferrer" : undefined}
                  className={`footer-social-icon${href ? "" : " footer-social-icon--pending"}`}
                  aria-label={label}
                >
                  <Icon size={20} />
                </Tag>
              );
            })}
          </div>
        </div>
      </div>
      <div className="footer-bottom">
        <span>© 2026 IvyHuts. All rights reserved. Built by IIM grads.</span>
      </div>
    </footer>
  );
}
