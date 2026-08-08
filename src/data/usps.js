import React from "react";

// IVYHUTS' four core USPs — single source of truth shared by the homepage
// TrustStrip and the property listings page sidebar so the two can never
// show different messaging again.
export const USPS = [
  {
    key: "verified",
    label: "100% Verified",
    sub: "Every listing checked",
    icon: (
      <svg viewBox="0 0 32 32" fill="none">
        <circle cx="16" cy="16" r="15" stroke="#5E3A6B" strokeWidth="2" />
        <path d="M9 16.5l4.5 4.5 9-9" stroke="#5E3A6B" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    key: "no-visa-no-pay",
    label: "No Visa No Pay",
    sub: "Full refund if visa refused",
    icon: (
      <svg viewBox="0 0 32 32" fill="none">
        <path d="M16 3l11 4v8c0 6-4.5 10.5-11 13C9.5 25.5 5 21 5 15V7l11-4z" stroke="#2E7D32" strokeWidth="2" strokeLinejoin="round" />
        <path d="M11 16l3.5 3.5 6-6" stroke="#2E7D32" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    key: "no-hidden-fees",
    label: "No Hidden Fees",
    sub: "Price shown is price paid",
    icon: (
      <svg viewBox="0 0 32 32" fill="none">
        <rect x="4" y="9" width="24" height="16" rx="3" stroke="#C8960C" strokeWidth="2" />
        <path d="M4 14h24" stroke="#C8960C" strokeWidth="2" />
        <circle cx="10" cy="20" r="2" fill="#C8960C" />
      </svg>
    ),
  },
  {
    key: "support",
    label: "24/7 Support",
    sub: "Always here for you",
    icon: (
      <svg viewBox="0 0 32 32" fill="none">
        <circle cx="16" cy="16" r="13" stroke="#4A90D9" strokeWidth="2" />
        <path d="M13 13c0-1.7 1.3-3 3-3s3 1.3 3 3c0 2-3 2.5-3 5" stroke="#4A90D9" strokeWidth="2" strokeLinecap="round" />
        <circle cx="16" cy="22" r="1.2" fill="#4A90D9" />
      </svg>
    ),
  },
];
