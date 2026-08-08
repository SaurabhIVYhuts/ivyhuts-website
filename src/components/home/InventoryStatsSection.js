import React, { useEffect, useRef, useState } from "react";
import { Building2, Ban, BadgeCheck } from "lucide-react";
import "./InventoryStatsSection.css";
import { getInventoryStats } from "../../services/amberApi";

const COUNT_UP_MS = 1200;

// Animates a stat's displayed number counting up from its previous value
// (0 on first load) to the latest one — purely cosmetic, no change to what
// data is fetched or how often.
function useCountUp(target, duration = COUNT_UP_MS) {
  const [display, setDisplay] = useState(0);
  const fromRef = useRef(0);
  const rafRef = useRef(null);

  useEffect(() => {
    if (!Number.isFinite(target)) return undefined;
    const from = fromRef.current;
    const startedAt = performance.now();

    function tick(now) {
      const progress = Math.min((now - startedAt) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3); // ease-out cubic
      setDisplay(Math.round(from + (target - from) * eased));
      if (progress < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        fromRef.current = target;
      }
    }

    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [target, duration]);

  return display;
}

function AnimatedStatValue({ value }) {
  const display = useCountUp(value);
  return <div className="stat-card-value">{display.toLocaleString()}</div>;
}

// Accent colors are reused from elsewhere in the codebase (brand purple,
// the existing form-error red, the existing success green) — no new palette.
const CARD_DEFS = [
  { key: "total", label: "Total Inventories", Icon: Building2, accent: "#5E3A6B", accentSoft: "rgba(94, 58, 107, 0.12)" },
  { key: "soldOut", label: "Sold Out", Icon: Ban, accent: "#C0392B", accentSoft: "rgba(192, 57, 43, 0.12)" },
  { key: "remaining", label: "Remaining", Icon: BadgeCheck, accent: "#2E7D32", accentSoft: "rgba(46, 125, 50, 0.12)" },
];

// getInventoryStats() now resolves in under a second on a normal run (see
// api/_lib/inventoryStats.js) — it no longer crawls the full catalog, so a
// handful of quick retries covers a momentary shared-budget clash. But Amber
// itself can also impose a real cooldown (its hard limit is 10 req/min with
// a 5-minute ban on violation — see amberGateway.js's activateCooldown), and
// that can outlast the quick phase. Rather than showing the error message
// permanently for the rest of the page view, keep retrying slowly in the
// background so the section recovers on its own once the cooldown clears.
const FAST_RETRY_MS = 1500;
const FAST_ATTEMPTS = 3;
const SLOW_RETRY_MS = 30000;
const SLOW_ATTEMPTS = 10; // ~5 minutes total, matching Amber's documented cooldown

export default function InventoryStatsSection() {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer;
    let attempt = 0;

    function scheduleRetry() {
      // Fast phase covers a momentary budget clash; once that's exhausted,
      // fall back to slow background retries (rather than giving up for
      // good) so a real Amber cooldown clears itself without a page reload.
      if (attempt < FAST_ATTEMPTS) {
        timer = setTimeout(load, FAST_RETRY_MS);
        return;
      }
      setError(true);
      setLoading(false);
      console.log("Loading:", false);
      if (attempt < FAST_ATTEMPTS + SLOW_ATTEMPTS) {
        timer = setTimeout(load, SLOW_RETRY_MS);
      }
    }

    async function load() {
      attempt += 1;

      let response;
      try {
        response = await getInventoryStats();
      } catch (err) {
        if (cancelled) return;
        scheduleRetry();
        return;
      }
      if (cancelled) return;

      const total = response?.total;
      const soldOut = response?.soldOut;
      const remaining = response?.remaining;
      const hasNumbers = Number.isFinite(total) && Number.isFinite(soldOut) && Number.isFinite(remaining);

      if (response?.ready && hasNumbers) {
        setStats({ total, soldOut, remaining });
        setError(false);
        setLoading(false);
        console.log("Loading:", false);
        return;
      }

      scheduleRetry();
    }

    load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  return (
    <section className="section stats-section">
      <div className="section-heading">
        <p className="section-eyebrow">Live Availability</p>
        <h2 className="section-title">Our Inventory at a Glance</h2>
      </div>
      <div className="section-underline" />

      {error ? (
        <p className="stats-error">Unable to load live inventory statistics.</p>
      ) : (
        <div className="stats-cards">
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
      )}
    </section>
  );
}
