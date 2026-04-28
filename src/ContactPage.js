import React, { useState } from "react";
import { Link } from "react-router-dom"; // eslint-disable-line no-unused-vars
import "./ContactPage.css";
import SiteFooter from "./SiteFooter";
import SiteNavbar from "./SiteNavbar";

const SHEETS_URL = process.env.REACT_APP_SHEETS_URL;

let lastSubmit = 0;

export default function ContactPage() {
  const [form, setForm] = useState({ name: "", email: "", phone: "", subject: "", message: "" });
  const [errors, setErrors] = useState({});
  const [status, setStatus] = useState("idle");
  const [honeypot, setHoneypot] = useState("");

  const set = (f, v) => {
    setForm((d) => ({ ...d, [f]: v }));
    if (errors[f]) setErrors((e) => ({ ...e, [f]: undefined }));
  };

  const validate = () => {
    const e = {};
    if (!form.name.trim()) e.name = "Please enter your name.";
    if (!form.email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(form.email.trim())) e.email = "Please enter a valid email.";
    if (!form.phone.trim()) e.phone = "Please enter your phone or WhatsApp number.";
    if (!form.subject.trim()) e.subject = "Please enter a subject.";
    if (!form.message.trim() || form.message.trim().length < 10) e.message = "Please write a message (at least 10 characters).";
    return e;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (honeypot) return;
    const errs = validate();
    if (Object.keys(errs).length) { setErrors(errs); return; }
    const now = Date.now();
    if (now - lastSubmit < 60000) { setErrors({ submit: "Please wait before submitting again." }); return; }
    setStatus("sending");
    lastSubmit = now;
    try {
      fetch(SHEETS_URL, {
        method: "POST",
        mode: "no-cors",
        body: JSON.stringify({
          _page:       "Contact Us",
          "Full Name": form.name.trim(),
          "Email":     form.email.trim(),
          "Phone":     form.phone.trim(),
          "Subject":   form.subject.trim(),
          "Message":   form.message.trim(),
        }),
      });
    } catch (_) {}
    setStatus("success");
  };

  return (
    <div className="cp-page">
      <SiteNavbar />

      <main><div className="cp-body">
        <div className="cp-left-col">
          <div className="cp-intro">
            <p className="cp-eyebrow">Get in Touch</p>
            <h1>Contact Us</h1>
            <p className="cp-intro-sub">Got a question, feedback, or just want to say hello? We'd love to hear from you. Our team usually responds within a few hours.</p>
          </div>

          <div className="cp-info-list">
            <div className="cp-info-item">
              <div className="cp-info-dot cp-info-dot--purple" />
              <div>
                <div className="cp-info-label">Email</div>
                <a href="mailto:ivy.huts.11@gmail.com" className="cp-info-value">ivy.huts.11@gmail.com</a>
              </div>
            </div>
            <div className="cp-info-item">
              <div className="cp-info-dot cp-info-dot--green" />
              <div>
                <div className="cp-info-label">WhatsApp</div>
                <span className="cp-info-value">+91 884 772 5089</span>
              </div>
            </div>
            <div className="cp-info-item">
              <div className="cp-info-dot cp-info-dot--gold" />
              <div>
                <div className="cp-info-label">Our Team</div>
                <span className="cp-info-value">Built by IIM grads</span>
              </div>
            </div>
          </div>
        </div>

        <div className="cp-form-col">
          {status === "success" ? (
            <div className="cp-success">
              <svg className="cp-success-icon" viewBox="0 0 56 56" fill="none">
                <circle cx="28" cy="28" r="26" stroke="url(#cp-grad)" strokeWidth="2.5"/>
                <path d="M16 28l8 8 16-16" stroke="#5E3A6B" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/>
                <defs><linearGradient id="cp-grad" x1="0" y1="0" x2="56" y2="56" gradientUnits="userSpaceOnUse"><stop stopColor="#5E3A6B"/><stop offset="1" stopColor="#B07898"/></linearGradient></defs>
              </svg>
              <h2>Message Sent!</h2>
              <p>Thanks for reaching out. We will get back to you at <strong>{form.email}</strong> within 24 hours.</p>
              <button className="cp-reset-btn" onClick={() => { setStatus("idle"); setForm({ name: "", email: "", phone: "", subject: "", message: "" }); }}>
                Send Another Message
              </button>
            </div>
          ) : (
            <form className="cp-form" onSubmit={handleSubmit} noValidate>
              <input type="text" name="website" value={honeypot} onChange={(e) => setHoneypot(e.target.value)} style={{ display: "none" }} tabIndex={-1} autoComplete="off" aria-hidden="true" />
              <h2 className="cp-form-title">Send us a message</h2>

              <div className="cp-form-row">
                <div className="cp-field">
                  <label>Full Name <span className="cp-req">*</span></label>
                  <input placeholder="Your full name" value={form.name} onChange={(e) => set("name", e.target.value)} maxLength={80} />
                  {errors.name && <span className="cp-field-err">{errors.name}</span>}
                </div>
                <div className="cp-field">
                  <label>Email Address <span className="cp-req">*</span></label>
                  <input type="email" placeholder="your@email.com" value={form.email} onChange={(e) => set("email", e.target.value)} maxLength={100} />
                  {errors.email && <span className="cp-field-err">{errors.email}</span>}
                </div>
              </div>

              <div className="cp-form-row">
                <div className="cp-field">
                  <label>Phone / WhatsApp <span className="cp-req">*</span></label>
                  <input placeholder="+91 XXXXX XXXXX" value={form.phone} onChange={(e) => set("phone", e.target.value)} maxLength={30} />
                  {errors.phone && <span className="cp-field-err">{errors.phone}</span>}
                </div>
                <div className="cp-field">
                  <label>Subject <span className="cp-req">*</span></label>
                  <input placeholder="What is your query about?" value={form.subject} onChange={(e) => set("subject", e.target.value)} maxLength={120} />
                  {errors.subject && <span className="cp-field-err">{errors.subject}</span>}
                </div>
              </div>

              <div className="cp-field">
                <label>Message <span className="cp-req">*</span></label>
                <textarea rows={5} placeholder="Tell us how we can help. The more detail you share, the better we can assist you." value={form.message} onChange={(e) => set("message", e.target.value)} maxLength={1000} />
                {errors.message && <span className="cp-field-err">{errors.message}</span>}
              </div>

              {errors.submit && <div className="cp-submit-err">{errors.submit}</div>}

              <button type="submit" className="cp-submit-btn" disabled={status === "sending"}>
                {status === "sending" ? "Sending..." : "Send Message"}
              </button>
            </form>
          )}
        </div>
      </div></main>

      <SiteFooter />
    </div>
  );
}
