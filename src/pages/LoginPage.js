import React, { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import SiteNavbar from "../components/layout/SiteNavbar";
import SiteFooter from "../components/layout/SiteFooter";
import { useWishlist } from "../context/WishlistContext";
import { takePendingWishlist } from "../lib/pendingWishlist";
import "./LoginPage.css";
import Seo from "../components/Seo";

// Milestone 4 — the site's first login/signup UI. No such page existed
// before this milestone even though the backend auth API (api/auth/*) was
// already fully built in an earlier milestone; this is the minimal form
// needed so the wishlist heart has somewhere real to send an unauthenticated
// visitor (see Part 7/8 of the Milestone 4 spec). Nothing else in the app
// links here yet — adding a persistent navbar auth link was out of scope
// (would touch the shared, must-not-redesign SiteNavbar for a milestone
// scoped to wishlist/behavioral data).
// Mirrors the server-side rule in api/auth/signup.js — 10-digit Indian
// mobile number, with an optional +91 country code. The backend remains
// the source of truth; this is just an early, friendlier error.
const PHONE_RE = /^(?:\+91)?[6-9]\d{9}$/;

export default function LoginPage() {
  const [searchParams] = useSearchParams();
  const returnTo = searchParams.get("returnTo") || "/";
  const navigate = useNavigate();
  const { add, syncAfterLogin } = useWishlist();

  const [mode, setMode] = useState("login"); // login | signup
  const [form, setForm] = useState({ name: "", email: "", phone: "", password: "" });
  const [error, setError] = useState("");
  const [status, setStatus] = useState("idle"); // idle | sending

  const set = (field, value) => {
    setForm((f) => ({ ...f, [field]: value }));
    if (error) setError("");
  };

  const completeReturn = async () => {
    // WishlistProvider's own hydration only runs once, on the app's first
    // mount — since this login can happen well after that, Context needs
    // to be told explicitly that we're now authenticated, or every wishlist
    // heart (and the /wishlist page's own auth check) would keep treating
    // this visitor as logged out for the rest of the session.
    await syncAfterLogin();
    const pending = takePendingWishlist();
    if (pending) add(pending);
    navigate(returnTo, { replace: true });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");

    let normalizedPhone;
    if (mode === "signup") {
      normalizedPhone = form.phone.replace(/[\s-]/g, "").trim();
      if (!normalizedPhone || !PHONE_RE.test(normalizedPhone)) {
        setError("Enter a valid 10-digit mobile number, e.g. 9876543210 or +919876543210.");
        return;
      }
    }

    setStatus("sending");
    try {
      const endpoint = mode === "login" ? "/api/auth/login" : "/api/auth/signup";
      const body = mode === "login"
        ? { email: form.email.trim(), password: form.password }
        : { name: form.name.trim(), email: form.email.trim(), phone: normalizedPhone, password: form.password };
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        setError(data.message || "Something went wrong. Please try again.");
        setStatus("idle");
        return;
      }
      await completeReturn();
    } catch (err) {
      setError("Something went wrong. Please try again.");
      setStatus("idle");
    }
  };

  return (
    <div className="lp-page">
      <Seo title="Sign in" noindex />
      <SiteNavbar />
      <main className="lp-main">
        <div className="lp-card">
          <div className="lp-tabs">
            <button type="button" className={`lp-tab${mode === "login" ? " active" : ""}`} onClick={() => { setMode("login"); setError(""); }}>
              Log In
            </button>
            <button type="button" className={`lp-tab${mode === "signup" ? " active" : ""}`} onClick={() => { setMode("signup"); setError(""); }}>
              Sign Up
            </button>
          </div>

          <p className="lp-sub">
            {mode === "login"
              ? "Log in to save properties to your wishlist and pick up where you left off."
              : "Create a free account to save properties and enquire faster next time."}
          </p>

          <form className="lp-form" onSubmit={handleSubmit} noValidate>
            {mode === "signup" && (
              <div className="lp-field">
                <label>Full Name</label>
                <input value={form.name} onChange={(e) => set("name", e.target.value)} maxLength={80} required />
              </div>
            )}
            {mode === "signup" && (
              <div className="lp-field">
                <label>Mobile Number *</label>
                <input
                  type="tel"
                  inputMode="tel"
                  placeholder="9876543210 or +919876543210"
                  value={form.phone}
                  onChange={(e) => set("phone", e.target.value)}
                  maxLength={15}
                  required
                />
              </div>
            )}
            <div className="lp-field">
              <label>Email Address</label>
              <input type="email" value={form.email} onChange={(e) => set("email", e.target.value)} maxLength={100} required />
            </div>
            <div className="lp-field">
              <label>Password</label>
              <input type="password" value={form.password} onChange={(e) => set("password", e.target.value)} minLength={mode === "signup" ? 8 : undefined} required />
            </div>

            {error && <div className="lp-error">{error}</div>}

            <button type="submit" className="btn btn-primary btn-block btn-lg" disabled={status === "sending"}>
              {status === "sending" ? "Please wait…" : mode === "login" ? "Log In" : "Create Account"}
            </button>
          </form>

          <Link to="/" className="lp-back-link">← Back to Home</Link>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
