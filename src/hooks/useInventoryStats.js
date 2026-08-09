import { useEffect, useState } from "react";
import { getInventoryStats } from "../services/amberApi";

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

// Shared by every homepage surface that shows live Total/Sold Out/Remaining
// counts (the full "Our Inventory at a Glance" section and the compact hero
// snapshot) so there is exactly one fetch/retry state machine, not one per
// consumer.
export function useInventoryStats() {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer;
    let attempt = 0;

    function scheduleRetry() {
      if (attempt < FAST_ATTEMPTS) {
        timer = setTimeout(load, FAST_RETRY_MS);
        return;
      }
      setError(true);
      setLoading(false);
      if (attempt < FAST_ATTEMPTS + SLOW_ATTEMPTS) {
        timer = setTimeout(load, SLOW_RETRY_MS);
      }
    }

    async function load() {
      attempt += 1;

      let response;
      try {
        response = await getInventoryStats();
      } catch {
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

  return { stats, loading, error };
}
