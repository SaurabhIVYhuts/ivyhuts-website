// Small shared wishlist state — Milestone 4 Part 9/10: one GET /api/wishlist
// call hydrates every heart on the page, and the same in-memory Set is
// reused across Listings and Property Detail so navigating between them
// never re-fetches. React Context is the smallest tool that fits here (a
// handful of consumers, one shallow piece of shared state) — no external
// state-management dependency was added for this.
//
// Also owns the one-time "am I logged in" check (GET /api/auth/me), since
// the heart needs that same answer before deciding whether a click should
// hit the wishlist API or redirect to /login.
import React, { createContext, useContext, useEffect, useMemo, useState, useCallback } from "react";

const WishlistContext = createContext(null);

export function WishlistProvider({ children }) {
  const [authChecked, setAuthChecked] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [items, setItems] = useState([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const meRes = await fetch("/api/auth/me");
        if (cancelled) return;
        if (!meRes.ok) { setAuthChecked(true); return; }
        setIsAuthenticated(true);
        const wRes = await fetch("/api/wishlist");
        if (cancelled) return;
        if (wRes.ok) {
          const body = await wRes.json();
          setItems((body && body.data && body.data.items) || []);
        }
      } catch (err) {
        console.error("[Wishlist] initial load failed:", err.message);
      } finally {
        if (!cancelled) setAuthChecked(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const idsSet = useMemo(() => new Set(items.map((i) => i.propertyId)), [items]);

  const add = useCallback(async (snapshot) => {
    setItems((prev) => (prev.some((i) => i.propertyId === snapshot.propertyId) ? prev : [...prev, snapshot]));
    try {
      const res = await fetch("/api/wishlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(snapshot),
      });
      if (!res.ok) throw new Error(`add failed (${res.status})`);
      const body = await res.json();
      const savedItem = body && body.data && Array.isArray(body.data.items)
        ? body.data.items.find((i) => i.propertyId === snapshot.propertyId)
        : null;
      // Merge in only THIS item's server-confirmed snapshot — never replace
      // the whole array with body.data.items. That array is a full-wishlist
      // snapshot as of this one request; if another add()/remove() for a
      // DIFFERENT property is still in flight, its optimistic entry may not
      // be in this particular response yet, and overwriting the whole list
      // would wipe it out until its own response lands (visible as a
      // saved heart flickering back to unsaved). Patching just this item
      // keeps every other in-flight mutation's optimistic state intact.
      if (savedItem) {
        setItems((prev) => prev.map((i) => (i.propertyId === savedItem.propertyId ? savedItem : i)));
      }
    } catch (err) {
      console.error("[Wishlist] add failed:", err.message);
      setItems((prev) => prev.filter((i) => i.propertyId !== snapshot.propertyId));
    }
  }, []);

  // The initial auth/wishlist hydration above only ever runs once, on
  // mount — but a login/signup can happen LATER in the same SPA session
  // (LoginPage never remounts WishlistProvider, since it lives above the
  // Router). Without this, isAuthenticated/items would stay stuck at their
  // pre-login values (false/[]) for the rest of the session: every
  // subsequent heart click would wrongly think the visitor is still
  // logged out and bounce them back to /login, and any properties already
  // in their wishlist from a previous session would never show as saved.
  // LoginPage calls this right after a successful login/signup response.
  const syncAfterLogin = useCallback(async () => {
    setIsAuthenticated(true);
    try {
      const wRes = await fetch("/api/wishlist");
      if (wRes.ok) {
        const body = await wRes.json();
        setItems((body && body.data && body.data.items) || []);
      }
    } catch (err) {
      console.error("[Wishlist] post-login sync failed:", err.message);
    } finally {
      setAuthChecked(true);
    }
  }, []);

  const remove = useCallback((propertyId) => {
    let removedItem;
    setItems((prev) => {
      removedItem = prev.find((i) => i.propertyId === propertyId);
      return prev.filter((i) => i.propertyId !== propertyId);
    });
    fetch(`/api/wishlist/${encodeURIComponent(propertyId)}`, { method: "DELETE" })
      .then((res) => { if (!res.ok) throw new Error(`remove failed (${res.status})`); })
      .catch((err) => {
        console.error("[Wishlist] remove failed:", err.message);
        if (removedItem) setItems((prev) => (prev.some((i) => i.propertyId === propertyId) ? prev : [...prev, removedItem]));
      });
  }, []);

  const value = useMemo(
    () => ({ authChecked, isAuthenticated, items, idsSet, add, remove, syncAfterLogin }),
    [authChecked, isAuthenticated, items, idsSet, add, remove, syncAfterLogin]
  );

  return <WishlistContext.Provider value={value}>{children}</WishlistContext.Provider>;
}

export function useWishlist() {
  const ctx = useContext(WishlistContext);
  if (!ctx) throw new Error("useWishlist must be used within a WishlistProvider");
  return ctx;
}
