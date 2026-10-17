import React from "react";
import { Building2, Ban, BadgeCheck } from "lucide-react";
import "./StatCard.css";
import { useInventoryStats } from "../../hooks/useInventoryStats";
import { AnimatedStatValue } from "./AnimatedStatValue";

// The three live inventory counters from the previous homepage, now a
// compact row inside the search-first hero. All three numbers come from ONE
// shared useInventoryStats() fetch (-> /api/amber?type=inventorystats ->
// api/_lib/inventoryStats.js, Redis-cached site-wide aggregate) — never one
// request per card, and never derived from whatever results are on screen.
const CARD_DEFS = [
  { key: "total", label: "Total Inventory", Icon: Building2, accent: "#5E3A6B", accentSoft: "rgba(94, 58, 107, 0.12)", bg: "#F6F0F8" },
  { key: "soldOut", label: "Sold Out", Icon: Ban, accent: "#B23A48", accentSoft: "rgba(178, 58, 72, 0.12)", bg: "#FCF1F3" },
  { key: "remaining", label: "Remaining", Icon: BadgeCheck, accent: "#2E7D32", accentSoft: "rgba(46, 125, 50, 0.12)", bg: "#EFF7F0" },
];

export default function HeroInventoryCards() {
  const { stats, loading, error } = useInventoryStats();

  return (
    <ul className="hero-stat-cards" aria-label="Live IVYHUTS inventory" aria-busy={loading && !stats ? "true" : undefined}>
      {CARD_DEFS.map(({ key, label, Icon, accent, accentSoft, bg }) => (
        <li
          className="stat-card"
          key={key}
          style={{ "--stat-accent": accent, "--stat-accent-soft": accentSoft, "--stat-bg": bg }}
        >
          <div className="stat-card-icon-badge">
            <Icon className="stat-card-icon" aria-hidden="true" />
          </div>
          <div className="stat-card-body">
            {stats ? (
              <AnimatedStatValue value={stats[key]} />
            ) : error ? (
              // Neutral fallback — never a fabricated 0. useInventoryStats
              // keeps retrying slowly in the background and swaps real
              // numbers in if the backend recovers.
              <div className="stat-card-value stat-card-value--na">
                <span aria-hidden="true">—</span>
                <span className="stat-card-sr">Unavailable</span>
              </div>
            ) : (
              <div className="stat-card-value stat-skel" aria-hidden="true" />
            )}
            <div className="stat-card-label">{label}</div>
          </div>
        </li>
      ))}
    </ul>
  );
}
