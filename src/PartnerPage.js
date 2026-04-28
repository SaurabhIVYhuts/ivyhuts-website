import React, { useState } from "react";
import { Link } from "react-router-dom"; // eslint-disable-line no-unused-vars
import "./PartnerPage.css";
import SiteFooter from "./SiteFooter";
import SiteNavbar from "./SiteNavbar";

const SHEETS_URL = process.env.REACT_APP_SHEETS_URL;

let lastSubmit = 0;

const PARTNER_TYPES = [
  "PBSA Operator / Property Manager",
  "Individual Landlord",
  "Student Housing Agency",
  "University / College",
  "Relocation Service",
  "Other",
];

export default function PartnerPage() {
  const [form, setForm] = useState({
    name: "", company: "", email: "", phone: "",
    partnerType: "", properties: "", countries: "", message: "",
  });
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
    if (!form.partnerType) e.partnerType = "Please select your type.";
    if (!form.message.trim()) e.message = "Please tell us a bit about yourself.";
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
          _page:                   "Partner with Us",
          "Full Name":             form.name.trim(),
          "Company":               form.company || "N/A",
          "Email":                 form.email.trim(),
          "Phone":                 form.phone.trim(),
          "Partner Type":          form.partnerType,
          "Properties/Rooms":      form.properties || "Not specified",
          "Countries Operated In": form.countries || "Not specified",
          "Message":               form.message.trim(),
        }),
      });
    } catch (_) {}
    setStatus("success");
  };

  return (
    <div className="pp-page">
      <SiteNavbar />

      <main><div className="pp-hero">
        <div className="pp-hero-inner">
          <p className="pp-eyebrow">Grow with IvyHuts</p>
          <h1>Partner With Us</h1>
          <p className="pp-hero-sub">
            Join our network of trusted property providers and connect with thousands of pre-verified international students actively searching for accommodation.
          </p>
        </div>
      </div>

      <div className="pp-why">
        <div className="pp-why-inner">
          <h2 className="pp-why-title">Why Partner with IvyHuts?</h2>
          <div className="pp-benefits-grid">
            <div className="pp-benefit">
              <svg className="pp-benefit-icon" viewBox="0 0 44 44" fill="none">
                <circle cx="22" cy="15" r="6" stroke="#5E3A6B" strokeWidth="2"/>
                <path d="M10 38c0-6.6 5.4-12 12-12s12 5.4 12 12" stroke="#5E3A6B" strokeWidth="2" strokeLinecap="round"/>
                <path d="M30 10l3 1.5-3 1.5" stroke="#5E3A6B" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M33 11.5h-5" stroke="#5E3A6B" strokeWidth="1.8" strokeLinecap="round"/>
              </svg>
              <h3>Verified Student Leads</h3>
              <p>Every student on our platform is genuinely looking for accommodation. No time-wasters, no bots.</p>
            </div>
            <div className="pp-benefit">
              <svg className="pp-benefit-icon" viewBox="0 0 44 44" fill="none">
                <circle cx="22" cy="22" r="14" stroke="#4A90D9" strokeWidth="2"/>
                <ellipse cx="22" cy="22" rx="6" ry="14" stroke="#4A90D9" strokeWidth="1.5"/>
                <path d="M8 22h28" stroke="#4A90D9" strokeWidth="1.5" strokeDasharray="3 2"/>
                <path d="M10 15h24M10 29h24" stroke="#4A90D9" strokeWidth="1.2" strokeDasharray="2 3" opacity=".6"/>
              </svg>
              <h3>Global Reach</h3>
              <p>We serve students from India, Southeast Asia, Africa and beyond, all looking for international stays.</p>
            </div>
            <div className="pp-benefit">
              <svg className="pp-benefit-icon" viewBox="0 0 44 44" fill="none">
                <rect x="8" y="12" width="28" height="20" rx="4" stroke="#C8960C" strokeWidth="2"/>
                <path d="M8 19h28" stroke="#C8960C" strokeWidth="2"/>
                <circle cx="15" cy="28" r="2.5" fill="#C8960C"/>
                <rect x="21" y="26" width="10" height="4" rx="2" fill="#C8960C" opacity=".3"/>
                <path d="M28 8l3 4h-6l3-4z" fill="#C8960C" opacity=".5"/>
              </svg>
              <h3>No Upfront Costs</h3>
              <p>Listing and lead generation are free to start. We only succeed when you fill your rooms.</p>
            </div>
            <div className="pp-benefit">
              <svg className="pp-benefit-icon" viewBox="0 0 44 44" fill="none">
                <path d="M12 14h20v18H12z" rx="3" stroke="#25D366" strokeWidth="2" strokeLinejoin="round"/>
                <path d="M17 22l3.5 3.5 6-6" stroke="#25D366" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M12 32l-4 4" stroke="#25D366" strokeWidth="2" strokeLinecap="round"/>
                <circle cx="8" cy="36" r="2" fill="#25D366"/>
              </svg>
              <h3>Dedicated Support</h3>
              <p>A dedicated member of our team handles your onboarding and stays in touch throughout the process.</p>
            </div>
          </div>
        </div>
      </div>

      <div className="pp-body">
        {status === "success" ? (
          <div className="pp-success">
            <svg className="pp-success-icon" viewBox="0 0 56 56" fill="none">
              <circle cx="28" cy="28" r="26" stroke="url(#pp-grad)" strokeWidth="2.5"/>
              <path d="M16 28l8 8 16-16" stroke="#5E3A6B" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/>
              <defs><linearGradient id="pp-grad" x1="0" y1="0" x2="56" y2="56" gradientUnits="userSpaceOnUse"><stop stopColor="#5E3A6B"/><stop offset="1" stopColor="#B07898"/></linearGradient></defs>
            </svg>
            <h2>Thanks for reaching out!</h2>
            <p>We will review your enquiry and get back to you at <strong>{form.email}</strong> within 48 hours to discuss next steps.</p>
            <button className="pp-reset-btn" onClick={() => { setStatus("idle"); setForm({ name: "", company: "", email: "", phone: "", partnerType: "", properties: "", countries: "", message: "" }); }}>
              Submit Another Enquiry
            </button>
          </div>
        ) : (
          <div className="pp-form-wrap">
            <h2 className="pp-form-title">Get in Touch</h2>
            <p className="pp-form-sub">Fill in the form and our partnerships team will get back to you within 48 hours.</p>

            <form className="pp-form" onSubmit={handleSubmit} noValidate>
              <input type="text" name="website" value={honeypot} onChange={(e) => setHoneypot(e.target.value)} style={{ display: "none" }} tabIndex={-1} autoComplete="off" aria-hidden="true" />
              <div className="pp-form-row">
                <div className="pp-field">
                  <label>Full Name <span className="pp-req">*</span></label>
                  <input placeholder="Your name" value={form.name} onChange={(e) => set("name", e.target.value)} maxLength={80} />
                  {errors.name && <span className="pp-field-err">{errors.name}</span>}
                </div>
                <div className="pp-field">
                  <label>Company / Organisation <span className="pp-opt">(optional)</span></label>
                  <input placeholder="e.g. Prestige Student Homes Ltd." value={form.company} onChange={(e) => set("company", e.target.value)} maxLength={100} />
                </div>
              </div>

              <div className="pp-form-row">
                <div className="pp-field">
                  <label>Email Address <span className="pp-req">*</span></label>
                  <input type="email" placeholder="you@company.com" value={form.email} onChange={(e) => set("email", e.target.value)} maxLength={100} />
                  {errors.email && <span className="pp-field-err">{errors.email}</span>}
                </div>
                <div className="pp-field">
                  <label>Phone / WhatsApp <span className="pp-req">*</span></label>
                  <input placeholder="+91 XXXXX XXXXX or +44 XXXXX XXXXX" value={form.phone} onChange={(e) => set("phone", e.target.value)} maxLength={30} />
                  {errors.phone && <span className="pp-field-err">{errors.phone}</span>}
                </div>
              </div>

              <div className="pp-form-row">
                <div className="pp-field">
                  <label>Partner Type <span className="pp-req">*</span></label>
                  <select value={form.partnerType} onChange={(e) => set("partnerType", e.target.value)}>
                    <option value="">Select your type</option>
                    {PARTNER_TYPES.map((t) => <option key={t}>{t}</option>)}
                  </select>
                  {errors.partnerType && <span className="pp-field-err">{errors.partnerType}</span>}
                </div>
                <div className="pp-field">
                  <label>Number of Properties / Rooms <span className="pp-opt">(optional)</span></label>
                  <input placeholder="e.g. 3 properties, 45 beds" value={form.properties} onChange={(e) => set("properties", e.target.value)} maxLength={80} />
                </div>
              </div>

              <div className="pp-field">
                <label>Countries / Cities You Operate In <span className="pp-opt">(optional)</span></label>
                <input placeholder="e.g. UK (London, Manchester), Canada (Toronto)" value={form.countries} onChange={(e) => set("countries", e.target.value)} maxLength={200} />
              </div>

              <div className="pp-field">
                <label>Tell us about yourself <span className="pp-req">*</span></label>
                <textarea rows={4} placeholder="Briefly describe your property or service and how you'd like to work with IvyHuts." value={form.message} onChange={(e) => set("message", e.target.value)} maxLength={1000} />
                {errors.message && <span className="pp-field-err">{errors.message}</span>}
              </div>

              {errors.submit && <div className="pp-submit-err">{errors.submit}</div>}

              <button type="submit" className="pp-submit-btn" disabled={status === "sending"}>
                {status === "sending" ? "Sending..." : "Send Partnership Enquiry"}
              </button>
            </form>
          </div>
        )}
      </div></main>

      <SiteFooter />
    </div>
  );
}
