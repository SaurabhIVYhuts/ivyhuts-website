import React, { useState, useRef, useEffect } from "react";
import { Link, useSearchParams } from "react-router-dom";
import "./AccommodationFinderPage.css";
import SiteFooter from "./SiteFooter";
import SiteNavbar from "./SiteNavbar";

const SHEETS_URL = process.env.REACT_APP_SHEETS_URL;

const COUNTRIES = [
  { name: "UK",          flag: "🇬🇧" },
  { name: "Canada",      flag: "🇨🇦" },
  { name: "Australia",   flag: "🇦🇺" },
  { name: "USA",         flag: "🇺🇸" },
  { name: "Germany",     flag: "🇩🇪" },
  { name: "France",      flag: "🇫🇷" },
  { name: "Ireland",     flag: "🇮🇪" },
  { name: "Netherlands", flag: "🇳🇱" },
  { name: "New Zealand", flag: "🇳🇿" },
  { name: "Singapore",   flag: "🇸🇬" },
  { name: "UAE",         flag: "🇦🇪" },
  { name: "Sweden",      flag: "🇸🇪" },
  { name: "Italy",       flag: "🇮🇹" },
  { name: "Spain",       flag: "🇪🇸" },
  { name: "Switzerland", flag: "🇨🇭" },
  { name: "South Korea", flag: "🇰🇷" },
  { name: "Japan",       flag: "🇯🇵" },
];
const ROOM_TYPES = ["En-Suite", "Studio", "Shared Room", "Private Apartment", "No Preference"];
const BUDGETS = [
  "Under £400 / CA$650 / AUD$700 per month",
  "£400–£700 / CA$650–$1,100 / AUD$700–$1,200 per month",
  "£700–£1,100 / CA$1,100–$1,700 / AUD$1,200–$1,900 per month",
  "£1,100–£1,600 / CA$1,700–$2,500 / AUD$1,900–$2,800 per month",
  "Above £1,600 / CA$2,500 / AUD$2,800 per month",
  "Not sure yet",
];
const INTAKES = ["September 2026", "January 2027", "Other / Flexible"];

const EMPTY = {
  fullName: "",
  email: "",
  phone: "",
  university: "",
  countries: [],
  roomType: "",
  budget: "",
  intake: "",
  duration: "",
  billsIncluded: "",
  otherQuery: "",
};

// Simple spam guard: track last submission time in memory
let lastSubmitTime = 0;

function validate(data) {
  const errors = {};

  // Full name: letters, spaces, hyphens only, 2-60 chars
  if (!data.fullName.trim()) {
    errors.fullName = "Please enter your name.";
  } else if (!/^[a-zA-Z\s'-]{2,60}$/.test(data.fullName.trim())) {
    errors.fullName = "Please enter a valid name (letters only, 2-60 characters).";
  }

  // Email
  if (!data.email.trim()) {
    errors.email = "Please enter your email address.";
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(data.email.trim())) {
    errors.email = "Please enter a valid email address.";
  }

  // Phone: required, must be valid
  if (!data.phone.trim()) {
    errors.phone = "Please enter your WhatsApp or phone number.";
  } else if (!/^\+?[\d\s\-().]{7,20}$/.test(data.phone.trim())) {
    errors.phone = "Please enter a valid phone number (digits, +, spaces, dashes only).";
  }

  // University: at least 3 chars, no special chars
  if (!data.university.trim()) {
    errors.university = "Please enter your university or college name.";
  } else if (data.university.trim().length < 3) {
    errors.university = "Please enter the full university name.";
  }

  // At least one country
  if (data.countries.length === 0) {
    errors.countries = "Please select at least one country.";
  }

  // Room type required
  if (!data.roomType) {
    errors.roomType = "Please select a room type.";
  }

  // Budget required
  if (!data.budget) {
    errors.budget = "Please select a budget range.";
  }

  // Intake required
  if (!data.intake) {
    errors.intake = "Please select a preferred intake.";
  }

  // Duration required
  if (!data.duration.trim()) {
    errors.duration = "Please specify your intended stay duration (e.g. 1 year, 2 semesters).";
  } else if (data.duration.trim().length < 3) {
    errors.duration = "Please be more specific about your stay duration.";
  }

  // Other query: max 1000 chars to prevent spam
  if (data.otherQuery.length > 1000) {
    errors.otherQuery = "Please keep your message under 1000 characters.";
  }

  return errors;
}

export default function AccommodationFinderPage() {
  const formRef = useRef(null);
  const [searchParams] = useSearchParams();
  const [data, setData] = useState(EMPTY);
  const [otherCountry, setOtherCountry] = useState("");
  const [errors, setErrors] = useState({});
  const [status, setStatus] = useState("idle"); // idle | sending | success | error
  const [honeypot, setHoneypot] = useState("");

  // Pre-fill from URL params (?country=UK&roomType=Studio)
  useEffect(() => {
    const country  = searchParams.get("country");
    const roomType = searchParams.get("roomType");
    if (country || roomType) {
      setData((d) => ({
        ...d,
        countries: country ? [country] : d.countries,
        roomType:  roomType || d.roomType,
      }));
    }
  }, [searchParams]);

  const set = (field, value) => {
    setData((d) => ({ ...d, [field]: value }));
    // Clear error as user fixes field
    if (errors[field]) setErrors((e) => ({ ...e, [field]: undefined }));
  };

  const touch = () => {};

  const toggleCountry = (c) => {
    setData((d) => ({
      ...d,
      countries: d.countries.includes(c)
        ? d.countries.filter((x) => x !== c)
        : [...d.countries, c],
    }));
    if (errors.countries) setErrors((e) => ({ ...e, countries: undefined }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    // Honeypot: bots fill hidden fields, humans don't
    if (honeypot) return;

    // Spam guard: 60 second cooldown between submissions
    const now = Date.now();
    if (now - lastSubmitTime < 60000) {
      setErrors({ submit: "Please wait a moment before submitting again." });
      return;
    }

    const validationErrors = validate(data);
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      // Scroll to first error
      const firstField = formRef.current?.querySelector(".field-error");
      if (firstField) firstField.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }

    setStatus("sending");
    lastSubmitTime = now;

    try {
      fetch(SHEETS_URL, {
        method: "POST",
        mode: "no-cors",
        body: JSON.stringify({
          _page:            "Find Rooms",
          "Full Name":      data.fullName.trim(),
          "Email":          data.email.trim(),
          "Phone":          data.phone.trim() || "Not provided",
          "University":     data.university.trim(),
          "Countries":      data.countries.includes("Other") ? [...data.countries.filter(c => c !== "Other"), `Other: ${otherCountry.trim()}`].join(", ") : data.countries.join(", "),
          "Room Type":      data.roomType,
          "Budget":         data.budget,
          "Intake":         data.intake,
          "Duration":       data.duration.trim() || "Not specified",
          "Bills Included": data.billsIncluded || "Not specified",
          "Other Notes":    data.otherQuery.trim() || "None",
        }),
      });
    } catch (_) {}
    setStatus("success");
  };

  const E = ({ field }) =>
    errors[field] ? <span className="field-error">{errors[field]}</span> : null;

  return (
    <div className="finder-page">
      <SiteNavbar />

      <main>{/* HEADER */}
      <div className="finder-header">
        <div className="finder-header-inner">
          <h1>Find Your Perfect Stay</h1>
          <p>Our Counsellor will connect you with the best rooms available in your desired location.</p>
        </div>
      </div>

      <div className="lead-form-wrap">
        {status === "success" ? (
          <SuccessScreen name={data.fullName} />
        ) : (
          <form ref={formRef} className="lead-form" onSubmit={handleSubmit} noValidate>

            {/* Honeypot — hidden from real users, bots fill it */}
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

            {/* SECTION 1 */}
            <div className="form-section">
              <div className="form-section-title">
                <span className="form-section-num">1</span> Your Details
              </div>
              <div className="form-row">
                <div className="form-field">
                  <label className="field-label">Full Name <span className="req">*</span></label>
                  <input
                    className={`field-input ${errors.fullName ? "input-error" : ""}`}
                    placeholder="Your full name"
                    value={data.fullName}
                    onChange={(e) => set("fullName", e.target.value)}
                    onBlur={() => touch("fullName")}
                    maxLength={60}
                  />
                  <E field="fullName" />
                </div>
                <div className="form-field">
                  <label className="field-label">Email Address <span className="req">*</span></label>
                  <input
                    type="email"
                    className={`field-input ${errors.email ? "input-error" : ""}`}
                    placeholder="you@email.com"
                    value={data.email}
                    onChange={(e) => set("email", e.target.value)}
                    onBlur={() => touch("email")}
                    maxLength={100}
                  />
                  <E field="email" />
                </div>
              </div>
              <div className="form-row">
                <div className="form-field">
                  <label className="field-label">Phone / WhatsApp <span className="req">*</span></label>
                  <input
                    className={`field-input ${errors.phone ? "input-error" : ""}`}
                    placeholder="+91 XXXXX XXXXX or +44 XXXXX XXXXX"
                    value={data.phone}
                    onChange={(e) => {
                      // Only allow digits, +, spaces, dashes, brackets
                      const val = e.target.value.replace(/[^0-9+\s\-().]/g, "");
                      set("phone", val);
                    }}
                    onBlur={() => touch("phone")}
                    maxLength={20}
                  />
                  <E field="phone" />
                </div>
                <div className="form-field">
                  <label className="field-label">University You're Planning to Attend <span className="req">*</span></label>
                  <input
                    className={`field-input ${errors.university ? "input-error" : ""}`}
                    placeholder="e.g. University of Manchester, UBC, NYU..."
                    value={data.university}
                    onChange={(e) => set("university", e.target.value)}
                    onBlur={() => touch("university")}
                    maxLength={120}
                  />
                  <E field="university" />
                </div>
              </div>
            </div>

            {/* SECTION 2 */}
            <div className="form-section">
              <div className="form-section-title">
                <span className="form-section-num">2</span> Preferred Country
              </div>
              <p className="form-section-hint">Select all that apply. We will match rooms near your campus.</p>
              <div className="country-chips">
                {COUNTRIES.map(({ name, flag }) => (
                  <button
                    type="button"
                    key={name}
                    className={`country-chip ${data.countries.includes(name) ? "active" : ""}`}
                    onClick={() => toggleCountry(name)}
                  >
                    {flag} {name}
                  </button>
                ))}
                <button
                  type="button"
                  className={`country-chip ${data.countries.includes("Other") ? "active" : ""}`}
                  onClick={() => toggleCountry("Other")}
                >
                  + Other
                </button>
              </div>
              {data.countries.includes("Other") && (
                <input
                  className="other-country-input"
                  placeholder="Which country? e.g. Portugal, Malaysia"
                  value={otherCountry}
                  onChange={(e) => setOtherCountry(e.target.value)}
                  maxLength={80}
                  style={{ marginTop: 10, width: "100%", padding: "10px 14px", borderRadius: 8, border: "1.5px solid #C8A0C0", fontSize: "0.95rem", outline: "none" }}
                />
              )}
              <E field="countries" />
            </div>

            {/* SECTION 3 */}
            <div className="form-section">
              <div className="form-section-title">
                <span className="form-section-num">3</span> Room Preferences
              </div>
              <div className="form-field" style={{ marginBottom: 16 }}>
                <label className="field-label">Room Type <span className="req">*</span></label>
                <div className="radio-group">
                  {ROOM_TYPES.map((t) => (
                    <label key={t} className={`radio-chip ${data.roomType === t ? "active" : ""}`}>
                      <input type="radio" name="roomType" value={t} checked={data.roomType === t} onChange={() => set("roomType", t)} />
                      {t}
                    </label>
                  ))}
                </div>
                <E field="roomType" />
              </div>
              <div className="form-row">
                <div className="form-field">
                  <label className="field-label">Monthly Budget <span className="req">*</span></label>
                  <select
                    className={`field-input ${errors.budget ? "input-error" : ""}`}
                    value={data.budget}
                    onChange={(e) => set("budget", e.target.value)}
                  >
                    <option value="">Select your budget range</option>
                    {BUDGETS.map((b) => <option key={b}>{b}</option>)}
                  </select>
                  <E field="budget" />
                </div>
                <div className="form-field">
                  <label className="field-label">Bills Included?</label>
                  <div className="radio-group">
                    {["Yes, preferred", "No preference", "No, I'll manage separately"].map((opt) => (
                      <label key={opt} className={`radio-chip ${data.billsIncluded === opt ? "active" : ""}`}>
                        <input type="radio" name="billsIncluded" value={opt} checked={data.billsIncluded === opt} onChange={() => set("billsIncluded", opt)} />
                        {opt}
                      </label>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* SECTION 4 */}
            <div className="form-section">
              <div className="form-section-title">
                <span className="form-section-num">4</span> Move-in Details
              </div>
              <div className="form-row">
                <div className="form-field">
                  <label className="field-label">Preferred Intake <span className="req">*</span></label>
                  <div className="radio-group">
                    {INTAKES.map((i) => (
                      <label key={i} className={`radio-chip ${data.intake === i ? "active" : ""}`}>
                        <input type="radio" name="intake" value={i} checked={data.intake === i} onChange={() => set("intake", i)} />
                        {i}
                      </label>
                    ))}
                  </div>
                  <E field="intake" />
                </div>
                <div className="form-field">
                  <label className="field-label">Duration of Stay <span className="req">*</span></label>
                  <input
                    className={`field-input ${errors.duration ? "input-error" : ""}`}
                    placeholder="e.g. 1 year, 2 semesters, 10 months"
                    value={data.duration}
                    onChange={(e) => set("duration", e.target.value)}
                    onBlur={() => touch("duration")}
                    maxLength={80}
                  />
                  <E field="duration" />
                </div>
              </div>
            </div>

            {/* SECTION 5 */}
            <div className="form-section">
              <div className="form-section-title">
                <span className="form-section-num">5</span> Anything Else?
              </div>
              <p className="form-section-hint">Any specific requirements or questions you want us to know before we get in touch.</p>
              <textarea
                className={`field-input field-textarea ${errors.otherQuery ? "input-error" : ""}`}
                placeholder="e.g. I need a quiet place to study, I am arriving with a friend, I have questions about the visa process..."
                rows={4}
                value={data.otherQuery}
                onChange={(e) => set("otherQuery", e.target.value)}
                maxLength={1000}
              />
              <div className="char-count">{data.otherQuery.length} / 1000</div>
              <E field="otherQuery" />
            </div>

            {errors.submit && <div className="submit-error">{errors.submit}</div>}

            {/* SUBMIT */}
            <div className="form-submit-wrap">
              <button type="submit" className="form-submit-btn" disabled={status === "sending"}>
                {status === "sending" ? "Sending..." : "Get in Touch"}
              </button>
              <p className="form-submit-note">
                Free service. No spam. We will reach out within 24 hours.
              </p>
            </div>

          </form>
        )}
      </div></main>

      <SiteFooter />
    </div>
  );
}

function SuccessScreen({ name }) {
  return (
    <div className="success-screen">
      <div className="success-icon-wrap">
        <svg className="success-big-icon" viewBox="0 0 80 80" fill="none">
          <circle cx="40" cy="40" r="37" stroke="url(#af-grad)" strokeWidth="2.5"/>
          <path d="M22 40l12 12 24-24" stroke="#5E3A6B" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"/>
          <defs><linearGradient id="af-grad" x1="0" y1="0" x2="80" y2="80" gradientUnits="userSpaceOnUse"><stop stopColor="#5E3A6B"/><stop offset="1" stopColor="#B07898"/></linearGradient></defs>
        </svg>
      </div>
      <h2>Got it, {name.split(" ")[0]}!</h2>
      <p>
        We have received your details. Our team will go through your preferences and reach out to you personally within 24 hours to help you find the right place to stay.
      </p>
      <div className="success-steps">
        <div className="success-step">
          <svg className="ss-icon" viewBox="0 0 24 24" fill="none"><path d="M20 2H4a2 2 0 0 0-2 2v14l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2z" stroke="#5E3A6B" strokeWidth="1.8" strokeLinejoin="round"/><path d="M7 9h10M7 13h6" stroke="#5E3A6B" strokeWidth="1.6" strokeLinecap="round"/></svg>
          <span>We will connect with you over WhatsApp or email</span>
        </div>
        <div className="success-step">
          <svg className="ss-icon" viewBox="0 0 24 24" fill="none"><path d="M3 9.5L12 3l9 6.5V20a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9.5z" stroke="#2E7D32" strokeWidth="1.8" strokeLinejoin="round"/><path d="M9 21v-8h6v8" stroke="#2E7D32" strokeWidth="1.8" strokeLinejoin="round"/></svg>
          <span>We will share options that match your exact needs</span>
        </div>
        <div className="success-step">
          <svg className="ss-icon" viewBox="0 0 24 24" fill="none"><rect x="5" y="11" width="14" height="10" rx="2" stroke="#C8960C" strokeWidth="1.8"/><path d="M8 11V7a4 4 0 0 1 8 0v4" stroke="#C8960C" strokeWidth="1.8" strokeLinecap="round"/><circle cx="12" cy="16" r="1.5" fill="#C8960C"/></svg>
          <span>Your details are safe. We never share your data.</span>
        </div>
      </div>
      <Link to="/" className="success-home-btn">Back to Home</Link>
    </div>
  );
}
