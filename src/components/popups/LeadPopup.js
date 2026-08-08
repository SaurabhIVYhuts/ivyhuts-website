import React, { useEffect, useRef, useState } from "react";

// Shows at most once per browser tab session — set the instant the popup is
// triggered (not just on close/submit) so a fast scroll-past-and-back never
// re-triggers it.
const SESSION_KEY = "ivyhuts_lead_popup_shown";
const SCROLL_TRIGGER_PX = 400;

function validate(data) {
  const errors = {};
  if (!data.name.trim()) {
    errors.name = "Please enter your name.";
  } else if (data.name.trim().length < 2) {
    errors.name = "Please enter your full name.";
  }
  if (!data.email.trim()) {
    errors.email = "Please enter your email address.";
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(data.email.trim())) {
    errors.email = "Please enter a valid email address.";
  }
  if (!data.phone.trim()) {
    errors.phone = "Please enter your phone number.";
  } else if (!/^\+?[\d\s\-().]{7,20}$/.test(data.phone.trim())) {
    errors.phone = "Please enter a valid phone number.";
  }
  return errors;
}

export default function LeadPopup() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState({ name: "", email: "", phone: "" });
  const [errors, setErrors] = useState({});
  const [status, setStatus] = useState("idle"); // idle | sending | success | error
  const [honeypot, setHoneypot] = useState("");
  const dialogRef = useRef(null);

  useEffect(() => {
    if (sessionStorage.getItem(SESSION_KEY)) return;

    const onScroll = () => {
      if (window.scrollY < SCROLL_TRIGGER_PX) return;
      sessionStorage.setItem(SESSION_KEY, "1");
      setOpen(true);
      window.removeEventListener("scroll", onScroll);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (!open) return;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = ""; };
  }, [open]);

  if (!open) return null;

  const set = (field, value) => {
    setData((d) => ({ ...d, [field]: value }));
    if (errors[field]) setErrors((e) => ({ ...e, [field]: undefined }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (honeypot) return;

    const validationErrors = validate(data);
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      return;
    }

    setStatus("sending");
    try {
      const res = await fetch("/api/enquire", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          studentName: data.name.trim(),
          studentEmail: data.email.trim(),
          phoneNumber: data.phone.trim(),
          message: "Submitted via homepage lead popup",
          websiteSource: "ivyhuts.com/homepage-popup",
        }),
      });
      const resBody = await res.json().catch(() => ({}));
      if (res.ok && resBody.emailSent) {
        setStatus("success");
      } else {
        setStatus("error");
      }
    } catch (err) {
      setStatus("error");
    }
  };

  return (
    <div className="lead-popup-overlay">
      <div className="lead-popup" role="dialog" aria-modal="true" aria-labelledby="lead-popup-title" ref={dialogRef}>
        {status === "success" ? (
          <div className="lead-popup-success">
            <svg viewBox="0 0 56 56" fill="none" width="48" height="48">
              <circle cx="28" cy="28" r="26" stroke="url(#lp-grad)" strokeWidth="2.5"/>
              <path d="M16 28l8 8 16-16" stroke="#5E3A6B" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/>
              <defs><linearGradient id="lp-grad" x1="0" y1="0" x2="56" y2="56" gradientUnits="userSpaceOnUse"><stop stopColor="#5E3A6B"/><stop offset="1" stopColor="#B07898"/></linearGradient></defs>
            </svg>
            <p>Thanks! We'll get in touch with you shortly.</p>
            <button type="button" className="btn btn-primary" onClick={() => setOpen(false)}>Close</button>
          </div>
        ) : (
          <>
            <h2 id="lead-popup-title" className="lead-popup-title">Get free help finding your room</h2>
            <p className="lead-popup-sub">Leave your details and our team will reach out within 24 hours.</p>

            <form className="lead-popup-form" onSubmit={handleSubmit} noValidate>
              <input
                type="text"
                name="website"
                value={honeypot}
                onChange={(e) => setHoneypot(e.target.value)}
                style={{ display: "none" }}
                tabIndex={-1}
                autoComplete="off"
                aria-hidden="true"
              />

              <div className="lead-popup-field">
                <label>Name</label>
                <input
                  className={errors.name ? "input-error" : ""}
                  placeholder="Your full name"
                  value={data.name}
                  onChange={(e) => set("name", e.target.value)}
                  maxLength={60}
                />
                {errors.name && <span className="lead-popup-error">{errors.name}</span>}
              </div>

              <div className="lead-popup-field">
                <label>Email</label>
                <input
                  type="email"
                  className={errors.email ? "input-error" : ""}
                  placeholder="you@email.com"
                  value={data.email}
                  onChange={(e) => set("email", e.target.value)}
                  maxLength={100}
                />
                {errors.email && <span className="lead-popup-error">{errors.email}</span>}
              </div>

              <div className="lead-popup-field">
                <label>Phone Number</label>
                <input
                  className={errors.phone ? "input-error" : ""}
                  placeholder="+91 XXXXX XXXXX"
                  value={data.phone}
                  onChange={(e) => set("phone", e.target.value.replace(/[^0-9+\s\-().]/g, ""))}
                  maxLength={20}
                />
                {errors.phone && <span className="lead-popup-error">{errors.phone}</span>}
              </div>

              {status === "error" && (
                <div className="lead-popup-submit-error">
                  Something went wrong. Please try again, or reach us directly at{" "}
                  <a href="mailto:contact@ivyhuts.com">contact@ivyhuts.com</a>.
                </div>
              )}

              <button type="submit" className="btn btn-primary btn-block" disabled={status === "sending"}>
                {status === "sending" ? "Sending..." : "Get in Touch"}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
