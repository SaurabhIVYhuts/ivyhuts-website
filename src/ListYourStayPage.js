import React, { useState, useRef } from "react";
import { Link } from "react-router-dom";
import "./ListYourStayPage.css";
import SiteFooter from "./SiteFooter";
import SiteNavbar from "./SiteNavbar";

const SHEETS_URL = process.env.REACT_APP_SHEETS_URL;

const PROPERTY_TYPES = [
  "Entire Flat / Apartment",
  "Private Room in Shared Flat",
  "En-Suite Room",
  "Studio",
  "Student Halls / Residence",
  "PBSA (Purpose-Built Student Accommodation)",
  "Shared House",
  "Other",
];

const COUNTRIES_LIST = [
  "UK", "Canada", "Australia", "USA", "Germany", "France",
  "Ireland", "Netherlands", "New Zealand", "Singapore",
  "UAE", "Sweden", "Italy", "Spain", "Switzerland",
  "South Korea", "Japan", "Other",
];

const AMENITIES_LIST = [
  "WiFi Included", "Bills Included (All)", "Electricity Included",
  "Water Included", "Heating Included", "Parking Available",
  "Gym / Fitness Centre", "Laundry On-site", "CCTV / Security",
  "Garden / Terrace", "Study Room", "Common Room", "Bike Storage",
  "Kitchen (Shared)", "Kitchen (Private)", "24/7 Support",
  "Pet Friendly", "Wheelchair Accessible",
];

const MIN_STAY_OPTIONS = [
  "1 Month", "2 Months", "3 Months", "4 Months (Semester)",
  "6 Months", "9 Months", "Academic Year (44 weeks)", "12 Months", "Flexible",
];

const ID_TYPES = [
  "Passport", "Driving Licence", "National ID Card",
  "Aadhaar Card", "Other Government ID",
];

const STEPS = [
  { label: "Property",     icon: "🏠" },
  { label: "Pricing",      icon: "💷" },
  { label: "Amenities",    icon: "✨" },
  { label: "Universities", icon: "🎓" },
  { label: "Description",  icon: "📝" },
  { label: "Photos",       icon: "📷" },
  { label: "Contact",      icon: "👤" },
  { label: "Verify",       icon: "🔒" },
];

const EMPTY = {
  propertyName: "", propertyType: "",
  address: "", city: "", country: "", postcode: "",
  unitsAvailable: "", rentFrom: "", rentTo: "", currency: "",
  billsIncluded: "", minStay: "", availableFrom: "", furnished: "",
  amenities: [],
  uni1: "", uni1Distance: "", uni2: "", uni2Distance: "",
  description: "", houseRules: "",
  hostName: "", hostEmail: "", hostPhone: "", hostCompany: "", hostRole: "",
  idType: "",
};

let lastSubmitTime = 0;

function validateStep(step, data) {
  const e = {};
  if (step === 0) {
    if (!data.propertyName.trim()) e.propertyName = "What's the name of your property?";
    if (!data.propertyType)        e.propertyType = "Please pick a property type.";
    if (!data.address.trim())      e.address      = "We need a street address.";
    if (!data.city.trim())         e.city         = "Which city is it in?";
    if (!data.country)             e.country      = "Please select a country.";
  }
  if (step === 1) {
    if (!data.unitsAvailable.trim()) e.unitsAvailable = "How many rooms are available?";
    if (!data.rentFrom.trim())       e.rentFrom       = "Enter a starting rent amount.";
    if (!data.currency.trim())       e.currency       = "e.g. GBP, USD, AUD";
    if (!data.minStay)               e.minStay        = "Select the minimum stay.";
    if (!data.availableFrom.trim())  e.availableFrom  = "When is it available?";
    if (!data.furnished)             e.furnished      = "Is it furnished?";
  }
  if (step === 3) {
    if (!data.uni1.trim()) e.uni1 = "At least one university is required.";
  }
  if (step === 4) {
    if (!data.description.trim() || data.description.trim().length < 30)
      e.description = "Please write at least 30 characters.";
  }
  if (step === 6) {
    if (!data.hostName.trim())  e.hostName  = "Your name, please.";
    if (!data.hostEmail.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(data.hostEmail.trim()))
      e.hostEmail = "Please enter a valid email.";
    if (!data.hostPhone.trim()) e.hostPhone = "A phone number is required.";
    if (!data.hostRole)         e.hostRole  = "Please select your role.";
  }
  if (step === 7) {
    if (!data.idType) e.idType = "Please select your ID type.";
  }
  return e;
}

export default function ListYourStayPage() {
  const formRef = useRef(null);
  const [data,       setData]       = useState(EMPTY);
  const [errors,     setErrors]     = useState({});
  const [status,     setStatus]     = useState("idle");
  const [step,       setStep]       = useState(0);
  const [direction,  setDirection]  = useState("forward");
  const [honeypot,   setHoneypot]   = useState("");

  const set = (field, value) => {
    setData((d) => ({ ...d, [field]: value }));
    if (errors[field]) setErrors((e) => ({ ...e, [field]: undefined }));
  };

  const toggleAmenity = (a) => {
    setData((d) => ({
      ...d,
      amenities: d.amenities.includes(a)
        ? d.amenities.filter((x) => x !== a)
        : [...d.amenities, a],
    }));
  };

  const goNext = () => {
    const errs = validateStep(step, data);
    if (Object.keys(errs).length) { setErrors(errs); return; }
    setErrors({});
    setDirection("forward");
    setStep((s) => s + 1);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const goBack = () => {
    setErrors({});
    setDirection("back");
    setStep((s) => s - 1);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const handleSubmit = async () => {
    if (honeypot) return;
    const errs = validateStep(7, data);
    if (Object.keys(errs).length) { setErrors(errs); return; }
    const now = Date.now();
    if (now - lastSubmitTime < 60000) {
      setErrors({ submit: "Please wait a moment before submitting again." });
      return;
    }
    setStatus("sending");
    lastSubmitTime = now;

    try {
      fetch(SHEETS_URL, {
        method: "POST",
        mode: "no-cors",
        body: JSON.stringify({
          _page:             "List Your Stay",
          "Host Name":       data.hostName.trim(),
          "Email":           data.hostEmail.trim(),
          "Phone":           data.hostPhone.trim(),
          "Host Company":    data.hostCompany || "N/A",
          "Host Role":       data.hostRole,
          "Property Name":   data.propertyName.trim(),
          "Property Type":   data.propertyType,
          "Address":         data.address.trim(),
          "City":            data.city.trim(),
          "Country":         data.country,
          "Postcode":        data.postcode || "N/A",
          "Units Available": data.unitsAvailable.trim(),
          "Rent From":       data.rentFrom.trim(),
          "Rent To":         data.rentTo || "Open",
          "Currency":        data.currency.trim(),
          "Bills Included":  data.billsIncluded || "Not specified",
          "Min Stay":        data.minStay,
          "Available From":  data.availableFrom.trim(),
          "Furnished":       data.furnished,
          "Amenities":       data.amenities.join(", ") || "None",
          "Nearby Uni 1":    data.uni1.trim(),
          "Uni 1 Distance":  data.uni1Distance || "N/A",
          "Nearby Uni 2":    data.uni2 || "N/A",
          "Uni 2 Distance":  data.uni2Distance || "N/A",
          "Description":     data.description.trim(),
          "House Rules":     data.houseRules || "None",
          "ID Type":         data.idType,
        }),
      });
    } catch (_) {}
    setStatus("success");
  };

  const E = ({ field }) =>
    errors[field] ? <p className="lst-field-error">{errors[field]}</p> : null;

  /* ── STEP PANELS ── */
  const panels = [

    /* 0 — Property */
    <div className="lst-panel" key="0">
      <div className="lst-panel-heading">
        <span className="lst-panel-emoji">🏠</span>
        <h2>Tell us about your property</h2>
        <p>Start with the basics — what is it and where is it?</p>
      </div>
      <div className="lst-fields">
        <div className="lst-field">
          <label>What's the property called? <span className="lst-req">*</span></label>
          <input className={`lst-input${errors.propertyName ? " err" : ""}`} placeholder="e.g. Parkside Student Studios" value={data.propertyName} onChange={(e) => set("propertyName", e.target.value)} maxLength={100} />
          <E field="propertyName" />
        </div>
        <div className="lst-field">
          <label>What type of property is it? <span className="lst-req">*</span></label>
          <select className={`lst-input${errors.propertyType ? " err" : ""}`} value={data.propertyType} onChange={(e) => set("propertyType", e.target.value)}>
            <option value="">Choose a type…</option>
            {PROPERTY_TYPES.map((t) => <option key={t}>{t}</option>)}
          </select>
          <E field="propertyType" />
        </div>
        <div className="lst-form-row">
          <div className="lst-field">
            <label>Street Address <span className="lst-req">*</span></label>
            <input className={`lst-input${errors.address ? " err" : ""}`} placeholder="e.g. 14 Queen Street" value={data.address} onChange={(e) => set("address", e.target.value)} maxLength={120} />
            <E field="address" />
          </div>
          <div className="lst-field">
            <label>Postcode / ZIP</label>
            <input className="lst-input" placeholder="e.g. EC1A 1BB" value={data.postcode} onChange={(e) => set("postcode", e.target.value)} maxLength={20} />
          </div>
        </div>
        <div className="lst-form-row">
          <div className="lst-field">
            <label>City <span className="lst-req">*</span></label>
            <input className={`lst-input${errors.city ? " err" : ""}`} placeholder="e.g. London" value={data.city} onChange={(e) => set("city", e.target.value)} maxLength={60} />
            <E field="city" />
          </div>
          <div className="lst-field">
            <label>Country <span className="lst-req">*</span></label>
            <select className={`lst-input${errors.country ? " err" : ""}`} value={data.country} onChange={(e) => set("country", e.target.value)}>
              <option value="">Select country…</option>
              {COUNTRIES_LIST.map((c) => <option key={c}>{c}</option>)}
            </select>
            <E field="country" />
          </div>
        </div>
      </div>
    </div>,

    /* 1 — Pricing */
    <div className="lst-panel" key="1">
      <div className="lst-panel-heading">
        <span className="lst-panel-emoji">💷</span>
        <h2>Rooms and pricing</h2>
        <p>What are you offering and at what price?</p>
      </div>
      <div className="lst-fields">
        <div className="lst-form-row">
          <div className="lst-field">
            <label>How many rooms are available? <span className="lst-req">*</span></label>
            <input className={`lst-input${errors.unitsAvailable ? " err" : ""}`} placeholder="e.g. 3 en-suite rooms" value={data.unitsAvailable} onChange={(e) => set("unitsAvailable", e.target.value)} maxLength={60} />
            <E field="unitsAvailable" />
          </div>
          <div className="lst-field">
            <label>Currency <span className="lst-req">*</span></label>
            <input className={`lst-input${errors.currency ? " err" : ""}`} placeholder="GBP / AUD / USD / EUR" value={data.currency} onChange={(e) => set("currency", e.target.value.toUpperCase())} maxLength={10} />
            <E field="currency" />
          </div>
        </div>
        <div className="lst-form-row">
          <div className="lst-field">
            <label>Monthly Rent From <span className="lst-req">*</span></label>
            <input className={`lst-input${errors.rentFrom ? " err" : ""}`} placeholder="e.g. 700" value={data.rentFrom} onChange={(e) => set("rentFrom", e.target.value.replace(/[^0-9]/g, ""))} maxLength={8} />
            <E field="rentFrom" />
          </div>
          <div className="lst-field">
            <label>Monthly Rent To <span className="lst-opt">(optional)</span></label>
            <input className="lst-input" placeholder="e.g. 950" value={data.rentTo} onChange={(e) => set("rentTo", e.target.value.replace(/[^0-9]/g, ""))} maxLength={8} />
          </div>
        </div>
        <div className="lst-field">
          <label>Are bills included?</label>
          <div className="lst-chip-group">
            {["All bills included", "Some bills included", "Bills not included", "Not sure"].map((opt) => (
              <button type="button" key={opt} className={`lst-chip${data.billsIncluded === opt ? " active" : ""}`} onClick={() => set("billsIncluded", opt)}>{opt}</button>
            ))}
          </div>
        </div>
        <div className="lst-field">
          <label>Is it furnished? <span className="lst-req">*</span></label>
          <div className="lst-chip-group">
            {["Fully Furnished", "Part Furnished", "Unfurnished"].map((opt) => (
              <button type="button" key={opt} className={`lst-chip${data.furnished === opt ? " active" : ""}`} onClick={() => set("furnished", opt)}>{opt}</button>
            ))}
          </div>
          <E field="furnished" />
        </div>
        <div className="lst-form-row">
          <div className="lst-field">
            <label>Minimum Stay <span className="lst-req">*</span></label>
            <select className={`lst-input${errors.minStay ? " err" : ""}`} value={data.minStay} onChange={(e) => set("minStay", e.target.value)}>
              <option value="">How long at minimum?</option>
              {MIN_STAY_OPTIONS.map((o) => <option key={o}>{o}</option>)}
            </select>
            <E field="minStay" />
          </div>
          <div className="lst-field">
            <label>Available From <span className="lst-req">*</span></label>
            <input type="date" className={`lst-input${errors.availableFrom ? " err" : ""}`} value={data.availableFrom} onChange={(e) => set("availableFrom", e.target.value)} min="2026-01-01" />
            <E field="availableFrom" />
          </div>
        </div>
      </div>
    </div>,

    /* 2 — Amenities */
    <div className="lst-panel" key="2">
      <div className="lst-panel-heading">
        <span className="lst-panel-emoji">✨</span>
        <h2>What makes it great?</h2>
        <p>Select every amenity your property offers. More = more bookings!</p>
      </div>
      <div className="lst-amenity-grid">
        {AMENITIES_LIST.map((a) => (
          <button type="button" key={a} className={`lst-amenity-chip${data.amenities.includes(a) ? " active" : ""}`} onClick={() => toggleAmenity(a)}>
            {data.amenities.includes(a) ? "✓ " : ""}{a}
          </button>
        ))}
      </div>
      {data.amenities.length > 0 && (
        <p className="lst-amenity-count">{data.amenities.length} selected</p>
      )}
    </div>,

    /* 3 — Universities */
    <div className="lst-panel" key="3">
      <div className="lst-panel-heading">
        <span className="lst-panel-emoji">🎓</span>
        <h2>Nearby universities</h2>
        <p>Students always look for proximity to campus. Tell us which universities are close.</p>
      </div>
      <div className="lst-fields">
        <div className="lst-form-row">
          <div className="lst-field">
            <label>University 1 <span className="lst-req">*</span></label>
            <input className={`lst-input${errors.uni1 ? " err" : ""}`} placeholder="e.g. University of Manchester" value={data.uni1} onChange={(e) => set("uni1", e.target.value)} maxLength={120} />
            <E field="uni1" />
          </div>
          <div className="lst-field">
            <label>Distance / Travel Time</label>
            <input className="lst-input" placeholder="e.g. 10 min walk" value={data.uni1Distance} onChange={(e) => set("uni1Distance", e.target.value)} maxLength={50} />
          </div>
        </div>
        <div className="lst-form-row">
          <div className="lst-field">
            <label>University 2 <span className="lst-opt">(optional)</span></label>
            <input className="lst-input" placeholder="e.g. Manchester Metropolitan University" value={data.uni2} onChange={(e) => set("uni2", e.target.value)} maxLength={120} />
          </div>
          <div className="lst-field">
            <label>Distance / Travel Time</label>
            <input className="lst-input" placeholder="e.g. 15 min tram" value={data.uni2Distance} onChange={(e) => set("uni2Distance", e.target.value)} maxLength={50} />
          </div>
        </div>
      </div>
    </div>,

    /* 4 — Description */
    <div className="lst-panel" key="4">
      <div className="lst-panel-heading">
        <span className="lst-panel-emoji">📝</span>
        <h2>Describe your property</h2>
        <p>This is your pitch — what makes students want to live there?</p>
      </div>
      <div className="lst-fields">
        <div className="lst-field">
          <label>Property Description <span className="lst-req">*</span></label>
          <textarea
            className={`lst-input lst-textarea${errors.description ? " err" : ""}`}
            placeholder="Describe room sizes, layout, location highlights, nearby transport, and what makes it special for students…"
            rows={6}
            value={data.description}
            onChange={(e) => set("description", e.target.value)}
            maxLength={2000}
          />
          <div className="lst-char-count">{data.description.length} / 2000</div>
          <E field="description" />
        </div>
        <div className="lst-field">
          <label>House Rules <span className="lst-opt">(optional)</span></label>
          <textarea
            className="lst-input lst-textarea"
            placeholder="e.g. No smoking, quiet hours after 11pm, no pets."
            rows={3}
            value={data.houseRules}
            onChange={(e) => set("houseRules", e.target.value)}
            maxLength={500}
          />
        </div>
      </div>
    </div>,

    /* 5 — Photos */
    <div className="lst-panel" key="5">
      <div className="lst-panel-heading">
        <span className="lst-panel-emoji">📷</span>
        <h2>Property photos</h2>
        <p>Great photos get more enquiries. Here's how we'll collect them.</p>
      </div>
      <div className="lst-photos-cards">
        <div className="lst-photo-card">
          <div className="lst-photo-num">1</div>
          <div>
            <strong>Submit this form first</strong>
            <p>We'll review your listing details within 48 hours.</p>
          </div>
        </div>
        <div className="lst-photo-card">
          <div className="lst-photo-num">2</div>
          <div>
            <strong>We'll contact you</strong>
            <p>Our team will reach out via WhatsApp or email to collect photos.</p>
          </div>
        </div>
        <div className="lst-photo-card">
          <div className="lst-photo-num">3</div>
          <div>
            <strong>Have these ready</strong>
            <p>Bedroom, bathroom, common area, kitchen, and building exterior — at least 5 photos.</p>
          </div>
        </div>
      </div>
    </div>,

    /* 6 — Contact */
    <div className="lst-panel" key="6">
      <div className="lst-panel-heading">
        <span className="lst-panel-emoji">👤</span>
        <h2>Your contact details</h2>
        <p>We'll use these to get in touch and verify your listing.</p>
      </div>
      <div className="lst-fields">
        <div className="lst-form-row">
          <div className="lst-field">
            <label>Your Full Name <span className="lst-req">*</span></label>
            <input className={`lst-input${errors.hostName ? " err" : ""}`} placeholder="Your legal full name" value={data.hostName} onChange={(e) => set("hostName", e.target.value)} maxLength={60} />
            <E field="hostName" />
          </div>
          <div className="lst-field">
            <label>Email Address <span className="lst-req">*</span></label>
            <input type="email" className={`lst-input${errors.hostEmail ? " err" : ""}`} placeholder="your@email.com" value={data.hostEmail} onChange={(e) => set("hostEmail", e.target.value)} maxLength={100} />
            <E field="hostEmail" />
          </div>
        </div>
        <div className="lst-form-row">
          <div className="lst-field">
            <label>Phone / WhatsApp <span className="lst-req">*</span></label>
            <input className={`lst-input${errors.hostPhone ? " err" : ""}`} placeholder="+91 XXXXX XXXXX or +44 XXXXX XXXXX" value={data.hostPhone} onChange={(e) => set("hostPhone", e.target.value.replace(/[^0-9+\s\-().]/g, ""))} maxLength={20} />
            <E field="hostPhone" />
          </div>
          <div className="lst-field">
            <label>Company / Agency <span className="lst-opt">(optional)</span></label>
            <input className="lst-input" placeholder="e.g. ABC Property Management" value={data.hostCompany} onChange={(e) => set("hostCompany", e.target.value)} maxLength={80} />
          </div>
        </div>
        <div className="lst-field">
          <label>You are a… <span className="lst-req">*</span></label>
          <div className="lst-chip-group">
            {["Individual Landlord", "Property Management Company", "Housing Society", "PBSA Operator", "Letting Agent"].map((r) => (
              <button type="button" key={r} className={`lst-chip${data.hostRole === r ? " active" : ""}`} onClick={() => set("hostRole", r)}>{r}</button>
            ))}
          </div>
          <E field="hostRole" />
        </div>
      </div>
    </div>,

    /* 7 — Verify */
    <div className="lst-panel" key="7">
      <div className="lst-panel-heading">
        <span className="lst-panel-emoji">🔒</span>
        <h2>Almost done — identity check</h2>
        <p>IvyHuts verifies every host before publishing. Tell us which ID you'll provide — our team will request it securely within 48 hours.</p>
      </div>
      <div className="lst-fields">
        <div className="lst-field">
          <label>Government ID Type <span className="lst-req">*</span></label>
          <div className="lst-chip-group">
            {ID_TYPES.map((id) => (
              <button type="button" key={id} className={`lst-chip${data.idType === id ? " active" : ""}`} onClick={() => set("idType", id)}>{id}</button>
            ))}
          </div>
          <E field="idType" />
        </div>
        <div className="lst-verify-note">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
            <path d="M10 2l7 2.5v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V4.5L10 2z" stroke="#5E3A6B" strokeWidth="1.5" strokeLinejoin="round"/>
            <path d="M7 10l2 2 4-4" stroke="#5E3A6B" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          <div>
            <strong>Proof of Ownership also required.</strong> We'll ask for a title deed, tenancy agreement, or management letter — requested via email after submission.
          </div>
        </div>
        {errors.submit && <p className="lst-field-error">{errors.submit}</p>}
      </div>
    </div>,
  ];

  return (
    <div className="lst-page">
      <SiteNavbar />

      <main>{status === "success" ? (
        <div className="lst-success-full">
          <svg className="lst-success-icon" viewBox="0 0 72 72" fill="none">
            <rect x="4" y="4" width="64" height="64" rx="18" stroke="url(#lst-grad)" strokeWidth="2.5"/>
            <path d="M20 36l11 11 21-21" stroke="#5E3A6B" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"/>
            <defs><linearGradient id="lst-grad" x1="0" y1="0" x2="72" y2="72" gradientUnits="userSpaceOnUse"><stop stopColor="#5E3A6B"/><stop offset="1" stopColor="#B07898"/></linearGradient></defs>
          </svg>
          <h2>Submission Received!</h2>
          <p>Thank you, <strong>{data.hostName.split(" ")[0]}</strong>! Our team will review your property and reach out to you at <strong>{data.hostEmail}</strong> within 48 hours to verify your identity and complete the listing.</p>
          <div className="lst-success-steps">
            <div className="lst-success-step"><span className="lst-step-dot" /> Check your email for our verification request</div>
            <div className="lst-success-step"><span className="lst-step-dot" /> Have your government ID ready for our team</div>
            <div className="lst-success-step"><span className="lst-step-dot" /> Prepare property photos to share via WhatsApp</div>
            <div className="lst-success-step"><span className="lst-step-dot" /> Once verified, your listing goes live on IvyHuts</div>
          </div>
          <Link to="/" className="lst-back-btn">Back to Home</Link>
        </div>
      ) : (
        <div className="lst-wizard" ref={formRef}>

          {/* Honeypot — hidden from real users, bots fill it */}
          <input type="text" name="website" value={honeypot} onChange={(e) => setHoneypot(e.target.value)} style={{ display: "none" }} tabIndex={-1} autoComplete="off" aria-hidden="true" />

          {/* PROGRESS BAR */}
          <div className="lst-progress-wrap">
            <div className="lst-progress-bar">
              <div className="lst-progress-fill" style={{ width: `${((step + 1) / STEPS.length) * 100}%` }} />
            </div>
            <div className="lst-stepper">
              {STEPS.map((s, i) => (
                <div key={i} className={`lst-stepper-step${i < step ? " done" : i === step ? " active" : ""}`}>
                  <div className="lst-stepper-dot">
                    {i < step ? (
                      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                        <path d="M2.5 7l3 3 6-6" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    ) : (
                      <span>{i + 1}</span>
                    )}
                  </div>
                  <span className="lst-stepper-label">{s.label}</span>
                </div>
              ))}
            </div>
          </div>

          {/* CURRENT PANEL */}
          <div className={`lst-panel-wrap lst-panel-${direction}`}>
            {panels[step]}
          </div>

          {/* NAVIGATION */}
          <div className="lst-nav">
            {step > 0 && (
              <button type="button" className="lst-btn-back" onClick={goBack}>← Back</button>
            )}
            <div className="lst-nav-right">
              <span className="lst-step-count">Step {step + 1} of {STEPS.length}</span>
              {step < STEPS.length - 1 ? (
                <button type="button" className="lst-btn-next" onClick={goNext}>
                  Continue →
                </button>
              ) : (
                <button
                  type="button"
                  className="lst-btn-submit"
                  disabled={status === "sending"}
                  onClick={handleSubmit}
                >
                  {status === "sending" ? "Submitting…" : "Submit for Review →"}
                </button>
              )}
            </div>
          </div>

        </div>
      )}</main>

      <SiteFooter />
    </div>
  );
}
