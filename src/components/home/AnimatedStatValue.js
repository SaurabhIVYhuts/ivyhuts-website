import { useEffect, useRef, useState } from "react";

const COUNT_UP_MS = 1200;

// Animates a stat's displayed number counting up from its previous value
// (0 on first load) to the latest one — purely cosmetic, no change to what
// data is fetched or how often. Shared by every homepage surface that shows
// a live inventory count (full stats section + compact hero snapshot).
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

export function AnimatedStatValue({ value, className = "stat-card-value" }) {
  const display = useCountUp(value);
  return <div className={className}>{display.toLocaleString()}</div>;
}
