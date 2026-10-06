import React, { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom"; // eslint-disable-line no-unused-vars
import "./ContactPage.css";
import SiteFooter from "../components/layout/SiteFooter";
import SiteNavbar from "../components/layout/SiteNavbar";
import { socialLinks } from "../config/socialLinks";
import { SOCIAL_ICONS } from "../components/icons/SocialIcons";
import { submitEnquiryToMongo } from "../lib/enquiryApi";
import { trackFormSubmission } from "../lib/formConversionPixel";
import Seo from "../components/Seo";
import PhoneField from "../components/forms/PhoneField";
import { DEFAULT_COUNTRY_CODE, findCountry, formatFullNumber, validateNationalNumber } from "../data/countryDialCodes";

const SHEETS_URL = process.env.REACT_APP_SHEETS_URL;

let lastSubmit = 0;

export default function ContactPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const inventoryId = searchParams.get("inventory");
  const propertyName = searchParams.get("property");
  const roomName = searchParams.get("roomName");
  const tenancyDuration = searchParams.get("duration");
  const tenancyMoveIn = searchParams.get("moveIn");
  const tenancyMoveOut = searchParams.get("moveOut");
  const tenancyPrice = searchParams.get("price");
  const tenancyCurrency = searchParams.get("currency");
  const tenancyPriceUnit = searchParams.get("priceUnit"); // e.g. "week" or "month" — see RoomTypeCard.js/PropertyDetailPage.js; absent for older/bookmarked links
  const roomId = searchParams.get("room");
  const tenancyId = searchParams.get("tenancy");

  const subjectDefault = roomName
    ? `Enquiry: ${propertyName} — ${roomName}`
    : propertyName
      ? `Enquiry: ${propertyName}`
      : "";

  const [form, setForm] = useState({
    name: "",
    email: "",
    phone: "", // national digits only — the dial code lives in `country` below
    message: "",
  });
  const [country, setCountry] = useState(() => findCountry(DEFAULT_COUNTRY_CODE));
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
    if (!form.email.trim()) {
      e.email = "Please enter your email address.";
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(form.email.trim())) {
      e.email = "Please enter a valid email address.";
    }
    // Same shared rule the homepage popup uses (countryDialCodes.js), so
    // the two forms can't disagree about what a valid number is.
    const phoneError = validateNationalNumber(country, form.phone);
    if (phoneError) e.phone = phoneError;
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
          "Phone":     formatFullNumber(country, form.phone),
          "Subject":   subjectDefault || "General Enquiry",
          "Message":   form.message.trim() || "N/A",
          ...(inventoryId ? { "Property Inventory ID": inventoryId } : {}),
          ...(propertyName ? { "Property Name": propertyName } : {}),
          ...(roomId ? { "Room ID": roomId } : {}),
          ...(roomName ? { "Room Name": roomName } : {}),
          ...(tenancyId ? { "Tenancy ID": tenancyId } : {}),
          ...(tenancyDuration ? { "Duration": tenancyDuration } : {}),
          ...(tenancyMoveIn ? { "Move In": tenancyMoveIn } : {}),
          ...(tenancyMoveOut ? { "Move Out": tenancyMoveOut } : {}),
          ...(tenancyPrice ? { "Price": `${tenancyCurrency || ""}${tenancyPrice}${tenancyPriceUnit ? `/${tenancyPriceUnit}` : ""}` } : {}),
        }),
      });
    } catch (_) {}

    // Email notification — the one destination whose result we actually wait
    // for: it's the existing backend's honest confirmation of success (see
    // api/enquire.js), and it's what gates the new Lead conversion pixel and
    // the /thank-you redirect below. Must never fire either of those on a
    // frontend-only "request initiated" basis.
    let confirmed = false;
    try {
      // Room/tenancy context (audit fix): this used to be dropped entirely
      // before reaching /api/enquire (the email inbox staff actually work
      // from), and `preferredCity` was wrongly set to the room name — every
      // other form on this site (ListYourStayPage.js, PartnerPage.js) uses
      // that field for an actual city, so this was corrupting it. The
      // Sheets/Mongo destinations below already sent this data correctly;
      // this now matches them.
      const formattedPrice = tenancyPrice ? `${tenancyCurrency || ""}${tenancyPrice}${tenancyPriceUnit ? `/${tenancyPriceUnit}` : ""}` : undefined;
      const enquiryPayload = {
        propertyName: propertyName || undefined,
        propertyId: inventoryId || undefined,
        roomName: roomName || undefined,
        roomId: roomId || undefined,
        tenancyId: tenancyId || undefined,
        duration: tenancyDuration || undefined,
        moveIn: tenancyMoveIn || undefined,
        moveOut: tenancyMoveOut || undefined,
        price: formattedPrice,
        studentName: form.name.trim(),
        studentEmail: form.email.trim(),
        phoneNumber: formatFullNumber(country, form.phone),
        message: `Subject: ${subjectDefault || "General Enquiry"}\n\n${form.message.trim() || "N/A"}`,
        websiteSource: "ivyhuts.com/contact",
      };
      const res = await fetch("/api/enquire", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(enquiryPayload),
      });
      const resBody = await res.json().catch(() => ({}));
      confirmed = res.ok && resBody.emailSent === true;
      if (confirmed) {
        console.log("[Contact] Notification email sent successfully");
      } else {
        console.error("[Contact] Notification email failed:", resBody.message || resBody.error || "unknown error");
      }
    } catch (err) {
      console.error("[Contact] /api/enquire request failed:", err);
    }

    if (!confirmed) {
      setStatus("idle");
      setErrors({ submit: "Something went wrong. Please try again, or reach us directly at contact@ivyhuts.com." });
      return;
    }

    // MongoDB capture (Milestone 3) — additional, non-blocking destination
    // alongside Sheets/email above; fired only once the enquiry email above
    // is itself confirmed. The email address is collected again as of this
    // pass (it had been dropped in an earlier homepage/UI pass), so
    // Enquiry.contact.email — optional in the model, see
    // api/_lib/models/Enquiry.js — is now populated for every contact-form
    // enquiry rather than left null.
    const mongoMessage = [
      `Subject: ${subjectDefault || "General Enquiry"}`,
      form.message.trim(),
      roomName ? `Room: ${roomName}` : null,
      tenancyDuration ? `Duration: ${tenancyDuration}` : null,
      tenancyMoveIn ? `Move In: ${tenancyMoveIn}` : null,
      tenancyMoveOut ? `Move Out: ${tenancyMoveOut}` : null,
      tenancyPrice ? `Price: ${tenancyCurrency || ""}${tenancyPrice}${tenancyPriceUnit ? `/${tenancyPriceUnit}` : ""}` : null,
    ].filter(Boolean).join("\n");
    const mongoProperty = (inventoryId || propertyName)
      ? { id: inventoryId || null, name: propertyName || null }
      : undefined;
    submitEnquiryToMongo({
      contact: {
        name: form.name.trim(),
        email: form.email.trim(),
        phone: formatFullNumber(country, form.phone),
      },
      ...(mongoProperty ? { property: mongoProperty } : {}),
      message: mongoMessage,
      source: "contact",
    }, "Contact");

    const submissionId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    trackFormSubmission(submissionId, "Contact Us");
    navigate("/thank-you");
  };

  return (
    <div className="cp-page">
      <Seo
        title="Contact IVYhuts"
        description="Talk to a real IVYhuts advisor about student accommodation abroad. Free help finding verified rooms in 15+ countries — no booking fees."
        canonical="/contact"
      />
      <SiteNavbar />

      <main><div className="cp-body">
        <div className="cp-left-col">
          <div className="cp-intro">
            <p className="cp-eyebrow">Get in Touch</p>
            <h1>Contact Us</h1>
            <p className="cp-intro-sub">Got a question, feedback, or just want to say hello? We'd love to hear from you. Our team usually responds within a few hours.</p>
            {propertyName && (
              <div className="cp-property-context">
                Enquiring about <strong>{propertyName}</strong>
                {roomName && <> — <strong>{roomName}</strong></>}
                {(tenancyDuration || tenancyMoveIn) && (
                  <span className="cp-property-context-sub">
                    {[tenancyDuration, tenancyMoveIn ? `from ${tenancyMoveIn}` : null].filter(Boolean).join(" · ")}
                    {tenancyPrice ? ` · ${tenancyCurrency || ""}${tenancyPrice}${tenancyPriceUnit ? `/${tenancyPriceUnit}` : ""}` : ""}
                  </span>
                )}
              </div>
            )}
          </div>

          <div className="cp-info-list">
            <div className="cp-info-item">
              <div className="cp-info-dot cp-info-dot--purple" />
              <div>
                <div className="cp-info-label">Email</div>
                <a href="mailto:contact@ivyhuts.com" className="cp-info-value">contact@ivyhuts.com</a>
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

          <div className="cp-social-row">
            {SOCIAL_ICONS.map(({ key, label, Icon }) => {
              const href = socialLinks[key];
              const Tag = href ? "a" : "span";
              return (
                <Tag
                  key={key}
                  href={href || undefined}
                  target={href ? "_blank" : undefined}
                  rel={href ? "noopener noreferrer" : undefined}
                  className={`cp-social-icon${href ? "" : " cp-social-icon--pending"}`}
                  aria-label={label}
                >
                  <Icon size={20} />
                </Tag>
              );
            })}
          </div>
        </div>

        <div className="cp-form-col">
            <form className="cp-form" onSubmit={handleSubmit} noValidate>
              <input type="text" name="website" value={honeypot} onChange={(e) => setHoneypot(e.target.value)} style={{ display: "none" }} tabIndex={-1} autoComplete="off" aria-hidden="true" />
              <h2 className="cp-form-title">Send us a message</h2>

              <div className="cp-form-row">
                <div className="cp-field">
                  <label htmlFor="cp-name">Full Name <span className="cp-req">*</span></label>
                  <input id="cp-name" autoComplete="name" placeholder="Your full name" value={form.name} onChange={(e) => set("name", e.target.value)} maxLength={80} />
                  {errors.name && <span className="cp-field-err">{errors.name}</span>}
                </div>
                <div className="cp-field">
                  <label htmlFor="cp-email">Email <span className="cp-req">*</span></label>
                  <input
                    id="cp-email"
                    type="email"
                    autoComplete="email"
                    inputMode="email"
                    placeholder="you@example.com"
                    value={form.email}
                    onChange={(e) => set("email", e.target.value)}
                    maxLength={120}
                  />
                  {errors.email && <span className="cp-field-err">{errors.email}</span>}
                </div>
              </div>

              <div className="cp-field">
                <label htmlFor="cp-phone">Phone / WhatsApp <span className="cp-req">*</span></label>
                <PhoneField
                  inputId="cp-phone"
                  country={country}
                  onCountryChange={(next) => {
                    setCountry(next);
                    if (errors.phone) setErrors((e) => ({ ...e, phone: undefined }));
                  }}
                  value={form.phone}
                  onChange={(digits) => set("phone", digits)}
                  invalid={Boolean(errors.phone)}
                />
                {errors.phone && <span className="cp-field-err">{errors.phone}</span>}
              </div>

              <div className="cp-field">
                <label>Message <span className="cp-opt">(optional)</span></label>
                <textarea rows={5} placeholder="Tell us how we can help. The more detail you share, the better we can assist you." value={form.message} onChange={(e) => set("message", e.target.value)} maxLength={1000} />
              </div>

              {errors.submit && <div className="cp-submit-err">{errors.submit}</div>}

              <button type="submit" className="btn btn-primary btn-block btn-lg" disabled={status === "sending"}>
                {status === "sending" ? "Sending..." : "Send Message"}
              </button>
            </form>
        </div>
      </div></main>

      <SiteFooter />
    </div>
  );
}
