import React from "react";
import { RefreshCw, Menu } from "lucide-react";

export default function InsightHeader({ onRefresh, refreshing, onOpenMobileMenu }) {
  return (
    <header className="insight-header">
      <button type="button" className="insight-hamburger" onClick={onOpenMobileMenu} aria-label="Open menu">
        <Menu size={20} />
      </button>
      <div className="insight-header-titles">
        <h1>IVYHUTS Insights</h1>
        <p>Sold-Out Inventory &amp; Market Intelligence</p>
      </div>
      <div className="insight-header-actions">
        <button type="button" className="insight-refresh-btn" onClick={onRefresh} disabled={refreshing}>
          <RefreshCw size={15} className={refreshing ? "insight-spin" : ""} />
          Refresh
        </button>
      </div>
    </header>
  );
}
