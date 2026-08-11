import React, { useEffect, useRef } from "react";
import { Building2, Ban, BadgeCheck } from "lucide-react";
import "./StatCard.css";
import { useInventoryStats } from "../../hooks/useInventoryStats";
import { AnimatedStatValue } from "./AnimatedStatValue";

// The same three live Amber-backed cards that used to live in a standalone
// "Our Inventory at a Glance" section below the hero — same
// useInventoryStats data, now a horizontal row above the search bar where
// the accommodation photo used to sit.
const CARD_DEFS = [
  { key: "total", label: "Total Inventory", Icon: Building2, accent: "#5E3A6B", accentSoft: "rgba(94, 58, 107, 0.12)", bg: "#F1EAF4" },
  { key: "soldOut", label: "Sold Out", Icon: Ban, accent: "#C0392B", accentSoft: "rgba(192, 57, 43, 0.12)", bg: "#FCEBEE" },
  { key: "remaining", label: "Remaining", Icon: BadgeCheck, accent: "#2E7D32", accentSoft: "rgba(46, 125, 50, 0.12)", bg: "#E8F5E9" },
];

export default function HeroInventoryCards() {
  const { stats, loading, error } = useInventoryStats();
  const trackRef = useRef(null);

  // Auto-advance the mobile standalone row (see .hero-stats-standalone in
  // global.css) one card at a time — a no-op on the in-hero instance, which
  // is a vertical/hidden layout there and never has anything to scroll.
  // Pauses while the visitor is actually touching/hovering it, and is
  // skipped entirely under prefers-reduced-motion.
  useEffect(() => {
    const track = trackRef.current;
    if (!track || loading) return undefined;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return undefined;

    let paused = false;
    const pause = () => { paused = true; };
    const resume = () => { paused = false; };
    track.addEventListener("touchstart", pause, { passive: true });
    track.addEventListener("touchend", resume, { passive: true });
    track.addEventListener("mouseenter", pause);
    track.addEventListener("mouseleave", resume);

    const timer = setInterval(() => {
      if (paused || track.scrollWidth <= track.clientWidth || !track.children.length) return;
      const style = window.getComputedStyle(track);
      const gap = parseFloat(style.columnGap || style.gap) || 0;
      const step = track.children[0].getBoundingClientRect().width + gap;
      const atEnd = track.scrollLeft + track.clientWidth >= track.scrollWidth - 4;
      track.scrollTo({ left: atEnd ? 0 : track.scrollLeft + step, behavior: "smooth" });
    }, 2800);

    return () => {
      clearInterval(timer);
      track.removeEventListener("touchstart", pause);
      track.removeEventListener("touchend", resume);
      track.removeEventListener("mouseenter", pause);
      track.removeEventListener("mouseleave", resume);
    };
  }, [loading]);

  if (error) {
    return <p className="stats-error">Unable to load live inventory statistics.</p>;
  }

  return (
    <div className="hero-stat-cards" ref={trackRef} aria-label="Live IvyHuts inventory">
      {CARD_DEFS.map(({ key, label, Icon, accent, accentSoft, bg }) => (
        <div
          className="stat-card"
          key={key}
          style={{ "--stat-accent": accent, "--stat-accent-soft": accentSoft, "--stat-bg": bg }}
        >
          <div className="stat-card-icon-badge">
            <Icon className="stat-card-icon" aria-hidden="true" />
          </div>
          <div className="stat-card-body">
            {loading || !stats ? (
              <div className="stat-card-value stat-skel" aria-hidden="true" />
            ) : (
              <AnimatedStatValue value={stats[key]} />
            )}
            <div className="stat-card-label">{label}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
