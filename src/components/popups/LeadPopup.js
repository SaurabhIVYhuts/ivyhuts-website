import React, { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { getPageViewCount } from "../../lib/pageViewCounter";

// Re-arms after the visitor has explored a few more pages, rather than
// suppressing the popup forever after one dismissal or gating it on a
// fixed time delay. LAST_SHOWN_AT_VIEWS_KEY records the global page-view
// count (see lib/pageViewCounter.js, bumped on every route change site-
// wide) at the moment the popup was last shown; once the visitor has
// navigated PAGES_BEFORE_RESHOW pages further, it's allowed to trigger
// again on this component's next mount (LeadPopup only renders on the
// homepage, so that's the next time they're back here). localStorage (not
// sessionStorage) so this survives across tabs too. A successful submit
// is the one case that suppresses it permanently — no point re-asking
// someone who already gave their details.
const LAST_SHOWN_AT_VIEWS_KEY = "ivyhuts_lead_popup_last_shown_at_views";
const CONVERTED_KEY = "ivyhuts_lead_popup_converted";
const SCROLL_TRIGGER_PX = 400;
const PAGES_BEFORE_RESHOW = 3;

function validate(data) {
  const errors = {};
  if (!data.name.trim()) {
    errors.name = "Please enter your name.";
  } else if (data.name.trim().length < 2) {
    errors.name = "Please enter your full name.";
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
  const [data, setData] = useState({ name: "", phone: "" });
  const [errors, setErrors] = useState({});
  const [status, setStatus] = useState("idle"); // idle | sending | success | error
  const [honeypot, setHoneypot] = useState("");
  const dialogRef = useRef(null);

  useEffect(() => {
    if (localStorage.getItem(CONVERTED_KEY)) return;
    const lastShownAtViews = Number(localStorage.getItem(LAST_SHOWN_AT_VIEWS_KEY) || 0);
    const viewsSinceShown = getPageViewCount() - lastShownAtViews;
    if (lastShownAtViews > 0 && viewsSinceShown < PAGES_BEFORE_RESHOW) return;

    const onScroll = () => {
      if (window.scrollY < SCROLL_TRIGGER_PX) return;
      localStorage.setItem(LAST_SHOWN_AT_VIEWS_KEY, String(getPageViewCount()));
      setOpen(true);
      window.removeEventListener("scroll", onScroll);
    };
    
    // Delay attaching the scroll listener to avoid triggering it instantly
    // when the browser restores scroll position on reload.
    const timer = setTimeout(() => {
      window.addEventListener("scroll", onScroll, { passive: true });
    }, 2500);

    return () => {
      clearTimeout(timer);
      window.removeEventListener("scroll", onScroll);
    };
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
          phoneNumber: data.phone.trim(),
          message: "Submitted via homepage lead popup",
          websiteSource: "ivyhuts.com/homepage-popup",
        }),
      });
      const resBody = await res.json().catch(() => ({}));
      if (res.ok && resBody.emailSent) {
        setStatus("success");
        localStorage.setItem(CONVERTED_KEY, "1");
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
        <button type="button" className="lead-popup-close" onClick={() => setOpen(false)} aria-label="Close">
          <X size={18} strokeWidth={2.25} />
        </button>
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
