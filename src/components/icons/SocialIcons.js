import React from "react";

// Hand-drawn to match the stroke-icon style already used across the site
// (see SiteFooter's MailIcon/WhatsAppIcon) — lucide-react does not ship
// brand/logo icons, so these are custom. Shared by ContactPage and
// SiteFooter so both stay in sync.
export const InstagramIcon = ({ size = 17 }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8">
    <rect x="3" y="3" width="18" height="18" rx="5" />
    <circle cx="12" cy="12" r="4.2" />
    <circle cx="17.4" cy="6.6" r="1.1" fill="currentColor" stroke="none" />
  </svg>
);
export const LinkedinIcon = ({ size = 17 }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8">
    <rect x="3" y="3" width="18" height="18" rx="3" />
    <line x1="7.5" y1="10" x2="7.5" y2="17" strokeLinecap="round" />
    <circle cx="7.5" cy="6.7" r="0.9" fill="currentColor" stroke="none" />
    <path d="M11.5 17v-4.2c0-1.6 1-2.6 2.5-2.6s2.3 1 2.3 2.6V17" strokeLinecap="round" strokeLinejoin="round" />
    <line x1="11.5" y1="10" x2="11.5" y2="17" strokeLinecap="round" />
  </svg>
);
export const FacebookIcon = ({ size = 17 }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8">
    <path d="M15 8.5h-2c-.8 0-1.5.7-1.5 1.5v2h3.3l-.5 3H11.5v7" strokeLinecap="round" strokeLinejoin="round" />
    <circle cx="12" cy="12" r="9" />
  </svg>
);
export const YoutubeIcon = ({ size = 17 }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8">
    <rect x="3" y="6" width="18" height="12" rx="4" />
    <path d="M10.5 9.7l4.5 2.3-4.5 2.3V9.7z" fill="currentColor" stroke="none" />
  </svg>
);

export const SOCIAL_ICONS = [
  { key: "instagram", label: "Instagram", Icon: InstagramIcon },
  { key: "linkedin", label: "LinkedIn", Icon: LinkedinIcon },
  { key: "facebook", label: "Facebook", Icon: FacebookIcon },
  { key: "youtube", label: "YouTube", Icon: YoutubeIcon },
];
