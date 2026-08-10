// Milestone 4 Part 8 — "preserve intended navigation": when an
// unauthenticated visitor clicks a wishlist heart, WishlistHeart.js stashes
// the property snapshot here before redirecting to /login, and LoginPage.js
// completes the add automatically after a successful login/signup. Plain
// sessionStorage (not a routing/auth state machine) is enough: it survives
// the full-page-navigation round trip to /login and clears itself once
// consumed, and tab-scoping means it can never leak into a different login
// flow in another tab.
const KEY = "ivyhuts_pending_wishlist";

export function setPendingWishlist(snapshot) {
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(snapshot));
  } catch (_) {
    // sessionStorage unavailable (private browsing, quota) — the redirect to
    // /login still happens, the property just won't auto-add after login.
  }
}

export function takePendingWishlist() {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (!raw) return null;
    window.sessionStorage.removeItem(KEY);
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}
