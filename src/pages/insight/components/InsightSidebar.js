import React from "react";
import { Globe2, Tag, Building2, CalendarClock } from "lucide-react";

const NAV_ITEMS = [
  { key: "market", label: "Market Intelligence", icon: Globe2 },
  { key: "pricing", label: "Pricing", icon: Tag },
  { key: "property", label: "Property Performance", icon: Building2 },
  { key: "booking", label: "Booking", icon: CalendarClock },
];

export default function InsightSidebar({ active, onSelect, mobileOpen, onCloseMobile }) {
  return (
    <>
      {mobileOpen && <div className="insight-sidebar-scrim" onClick={onCloseMobile} />}
      <aside className={`insight-sidebar${mobileOpen ? " insight-sidebar-open" : ""}`}>
        <div className="insight-sidebar-brand">
          <span className="insight-sidebar-brand-ivy">IVY</span>
          <span className="insight-sidebar-brand-huts">huts</span>
          <span className="insight-sidebar-brand-sub">INSIGHTS</span>
        </div>
        <nav className="insight-sidebar-nav">
          {NAV_ITEMS.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              type="button"
              className={`insight-sidebar-link${active === key ? " insight-sidebar-link-active" : ""}`}
              onClick={() => {
                onSelect(key);
                onCloseMobile();
              }}
            >
              <Icon size={17} />
              {label}
            </button>
          ))}
        </nav>
        <div className="insight-sidebar-footer">Internal Dashboard</div>
      </aside>
    </>
  );
}
