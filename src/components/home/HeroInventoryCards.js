import React from "react";
import { Building2, Ban, BadgeCheck } from "lucide-react";
import "./StatCard.css";
import { useInventoryStats } from "../../hooks/useInventoryStats";
import { AnimatedStatValue } from "./AnimatedStatValue";

// The same three live Amber-backed cards that used to live in a standalone
// "Our Inventory at a Glance" section below the hero — same .stat-card
// markup/CSS, same useInventoryStats data, just stacked in the hero's right
// lane instead of shown twice on the page.
const CARD_DEFS = [
  { key: "total", label: "Total Inventories", Icon: Building2, accent: "#5E3A6B", accentSoft: "rgba(94, 58, 107, 0.12)" },
  { key: "soldOut", label: "Sold Out", Icon: Ban, accent: "#C0392B", accentSoft: "rgba(192, 57, 43, 0.12)" },
  { key: "remaining", label: "Remaining", Icon: BadgeCheck, accent: "#2E7D32", accentSoft: "rgba(46, 125, 50, 0.12)" },
];

export default function HeroInventoryCards() {
  const { stats, loading, error } = useInventoryStats();

  if (error) {
    return <p className="stats-error">Unable to load live inventory statistics.</p>;
  }

  return (
    <div className="hero-stat-cards" aria-label="Live IvyHuts inventory">
      {CARD_DEFS.map(({ key, label, Icon, accent, accentSoft }) => (
        <div
          className="stat-card"
          key={key}
          style={{ "--stat-accent": accent, "--stat-accent-soft": accentSoft }}
        >
          <div className="stat-card-icon-badge">
            <Icon className="stat-card-icon" aria-hidden="true" />
          </div>
          {loading || !stats ? (
            <div className="stat-card-value stat-skel" aria-hidden="true" />
          ) : (
            <AnimatedStatValue value={stats[key]} />
          )}
          <div className="stat-card-label">{label}</div>
        </div>
      ))}
    </div>
  );
}
