import React, { useState } from "react";
import { useParams, Link } from "react-router-dom";
import "./PropertyDetailPage.css";
import { PROPERTIES, PROPERTY_DETAILS } from "./data/accommodations";
import SiteFooter from "./SiteFooter";
import SiteNavbar from "./SiteNavbar";

export default function PropertyDetailPage() {
  const { id } = useParams();
  const property = PROPERTIES.find((p) => p.id === parseInt(id));
  const details = PROPERTY_DETAILS[parseInt(id)];
  const [enquiryForm, setEnquiryForm] = useState({ name: "", email: "", phone: "", moveIn: "", roomType: "", message: "" });
  const [submitted, setSubmitted] = useState(false);

  if (!property) {
    return (
      <div className="detail-page">
        <nav className="navbar">
          <Link to="/" style={{ textDecoration: "none" }}>
            <span className="logo-ivy">IVY</span><span className="logo-huts">huts</span>
          </Link>
        </nav>
        <div className="not-found">
          <h1>Property not found</h1>
          <Link to="/find-rooms" className="back-link">← Back to search</Link>
        </div>
      </div>
    );
  }

  const handleEnquiry = (e) => {
    e.preventDefault();
    setSubmitted(true);
  };

  return (
    <div className="detail-page">
      <SiteNavbar />

      <main>{/* BREADCRUMB */}
      <div className="breadcrumb-bar">
        <div className="breadcrumb-inner">
          <Link to="/find-rooms">Find Rooms</Link>
          <span className="bc-sep">›</span>
          <Link to={`/find-rooms?country=${property.country}`}>{property.country}</Link>
          <span className="bc-sep">›</span>
          <Link to={`/find-rooms?city=${property.city}`}>{property.city}</Link>
          <span className="bc-sep">›</span>
          <span className="bc-current">{property.name}</span>
        </div>
      </div>

      {/* HERO BANNER */}
      <div className="detail-hero">
        <div className="detail-hero-bg">
          <span className="detail-hero-flag">{property.flag}</span>
          <span className="detail-hero-city">{property.city}</span>
        </div>
        <div className="detail-hero-overlay">
          <div className="detail-hero-content">
            <div className="detail-badges-row">
              {property.tag && <span className="detail-tag">{property.tag}</span>}
              {property.billsIncluded && <span className="detail-bills-badge">All Bills Included</span>}
              <span className="detail-type-badge">{property.type}</span>
            </div>
            <h1 className="detail-property-name">{property.name}</h1>
            <div className="detail-location-row">
              <span>{property.city}, {property.country}</span>
              <span>{property.distanceMin} min to {property.nearbyUni}</span>
              <span className="detail-rating">{property.rating} ({property.reviews} reviews)</span>
            </div>
          </div>
        </div>
      </div>

      {/* BODY */}
      <div className="detail-body">
        <div className="detail-main">

          {/* DESCRIPTION */}
          {details && (
            <section className="detail-section">
              <h2 className="detail-section-title">About this Property</h2>
              <p className="detail-description">{details.description}</p>
              {details.nearbyPlaces && (
                <div className="nearby-list">
                  <div className="nearby-title">Getting Around</div>
                  {details.nearbyPlaces.map((place) => (
                    <div key={place} className="nearby-item">
                      <span className="nearby-dot" />
                      {place}
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {/* ROOM TYPES */}
          <section className="detail-section">
            <h2 className="detail-section-title">Available Rooms</h2>
            <div className="rooms-grid">
              {(details?.rooms || [
                { type: "En-Suite", size: "14 m²", pricePerWeek: property.pricePerWeek, pricePerMonth: property.pricePerMonth, available: true, features: ["Double bed", "Private bathroom", "Desk", "Wardrobe"] },
              ]).map((room) => (
                <div key={room.type} className={`room-card ${!room.available ? "room-unavailable" : ""}`}>
                  <div className="room-card-header">
                    <span className="room-type-name">{room.type}</span>
                    {room.available
                      ? <span className="room-avail-badge">Available</span>
                      : <span className="room-unavail-badge">Sold Out</span>
                    }
                  </div>
                  <div className="room-size">{room.size}</div>
                  <ul className="room-features">
                    {room.features.map((f) => <li key={f}>{f}</li>)}
                  </ul>
                  <div className="room-price-row">
                    <div>
                      <span className="room-price-num">£{room.pricePerWeek}</span>
                      <span className="room-price-unit">/week</span>
                    </div>
                    <div className="room-price-month">£{room.pricePerMonth}/month</div>
                  </div>
                  {room.available && (
                    <button
                      className="room-enquire-btn"
                      onClick={() => {
                        const el = document.getElementById("enquiry-form");
                        if (el) el.scrollIntoView({ behavior: "smooth" });
                        setEnquiryForm((f) => ({ ...f, roomType: room.type }));
                      }}
                    >
                      Enquire Now →
                    </button>
                  )}
                </div>
              ))}
            </div>
          </section>

          {/* AMENITIES */}
          {details?.amenities && (
            <section className="detail-section">
              <h2 className="detail-section-title">Amenities</h2>
              <div className="amenities-categories">
                {details.amenities.map((cat) => (
                  <div key={cat.category} className="amenity-category">
                    <div className="amenity-cat-name">{cat.category}</div>
                    <div className="amenity-items">
                      {cat.items.map((item) => (
                        <div key={item} className="amenity-item">
                          <span className="amenity-check">✓</span>
                          {item}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* HOUSE RULES & POLICIES */}
          {details && (
            <section className="detail-section">
              <h2 className="detail-section-title">House Rules &amp; Policies</h2>
              <div className="policies-grid">
                <div className="policy-block">
                  <div className="policy-title">House Rules</div>
                  <ul className="policy-list">
                    {details.houseRules.map((r) => <li key={r}>{r}</li>)}
                  </ul>
                </div>
                <div className="policy-block">
                  <div className="policy-title">Cancellation Policy</div>
                  <p className="policy-text">{details.cancellationPolicy}</p>
                </div>
                <div className="policy-block">
                  <div className="policy-title">Minimum Stay</div>
                  <p className="policy-text">{details.minStay}</p>
                </div>
                <div className="policy-block">
                  <div className="policy-title">Booking Fee</div>
                  <p className="policy-text">£{details.bookingFee} (refundable if visa refused)</p>
                </div>
              </div>
            </section>
          )}

          {/* GENERAL AMENITIES (fallback for properties without full details) */}
          {!details && (
            <section className="detail-section">
              <h2 className="detail-section-title">Amenities</h2>
              <div className="amenity-tags-wrap">
                {property.amenities.map((a) => (
                  <span key={a} className="amenity-tag-large">{a}</span>
                ))}
              </div>
            </section>
          )}

        </div>

        {/* ENQUIRY SIDEBAR */}
        <aside className="detail-sidebar">
          <div className="enquiry-card" id="enquiry-form">
            <div className="enquiry-price-header">
              <span className="enquiry-from">from </span>
              <span className="enquiry-price">£{property.pricePerWeek}</span>
              <span className="enquiry-unit">/week</span>
            </div>
            <div className="enquiry-available">Available from: {property.availableFrom}</div>

            {submitted ? (
              <div className="enquiry-success">
                <svg className="success-icon" viewBox="0 0 48 48" fill="none">
                  <circle cx="24" cy="24" r="22" stroke="url(#pd-grad)" strokeWidth="2"/>
                  <path d="M14 24l7 7 13-13" stroke="#5E3A6B" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
                  <defs><linearGradient id="pd-grad" x1="0" y1="0" x2="48" y2="48" gradientUnits="userSpaceOnUse"><stop stopColor="#5E3A6B"/><stop offset="1" stopColor="#B07898"/></linearGradient></defs>
                </svg>
                <h3>Enquiry Sent!</h3>
                <p>Our team will reach out to you within 24 hours to discuss availability and next steps.</p>
                <button className="reset-enquiry-btn" onClick={() => setSubmitted(false)}>Send Another</button>
              </div>
            ) : (
              <form onSubmit={handleEnquiry} className="enquiry-form">
                <h3 className="enquiry-title">Book a Viewing / Enquire</h3>

                <label className="form-label">Full Name *
                  <input required className="form-input" placeholder="Your name" value={enquiryForm.name} onChange={(e) => setEnquiryForm((f) => ({ ...f, name: e.target.value }))} />
                </label>
                <label className="form-label">Email Address *
                  <input required type="email" className="form-input" placeholder="you@email.com" value={enquiryForm.email} onChange={(e) => setEnquiryForm((f) => ({ ...f, email: e.target.value }))} />
                </label>
                <label className="form-label">Phone / WhatsApp
                  <input className="form-input" placeholder="+1 234 567 890" value={enquiryForm.phone} onChange={(e) => setEnquiryForm((f) => ({ ...f, phone: e.target.value }))} />
                </label>
                <label className="form-label">Preferred Move-In Date *
                  <input required type="date" className="form-input" value={enquiryForm.moveIn} onChange={(e) => setEnquiryForm((f) => ({ ...f, moveIn: e.target.value }))} />
                </label>
                <label className="form-label">Room Type
                  <select className="form-input" value={enquiryForm.roomType} onChange={(e) => setEnquiryForm((f) => ({ ...f, roomType: e.target.value }))}>
                    <option value="">Any available</option>
                    {property.roomTypes.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </label>
                <label className="form-label">Message
                  <textarea className="form-input form-textarea" placeholder="Any questions or special requirements..." value={enquiryForm.message} onChange={(e) => setEnquiryForm((f) => ({ ...f, message: e.target.value }))} />
                </label>

                <button type="submit" className="enquiry-submit-btn">Send Enquiry →</button>
                <p className="enquiry-note">Free to enquire · No commitment · Reply within 24 hours</p>
              </form>
            )}
          </div>

          {/* QUICK INFO */}
          <div className="quick-info-card">
            <div className="qi-title">Quick Info</div>
            <div className="qi-row"><span>Type</span><span>{property.type}</span></div>
            <div className="qi-row"><span>Country</span><span>{property.country}</span></div>
            <div className="qi-row"><span>Nearest Uni</span><span>{property.nearbyUni}</span></div>
            <div className="qi-row"><span>Distance</span><span>{property.distanceMin} min walk</span></div>
            <div className="qi-row"><span>Rating</span><span>{property.rating} ({property.reviews} reviews)</span></div>
            <div className="qi-row"><span>Bills</span><span>{property.billsIncluded ? "Included" : "Extra"}</span></div>
          </div>
        </aside>
      </div>

      {/* SIMILAR PROPERTIES */}
      <section className="similar-section">
        <div className="similar-inner">
          <h2 className="detail-section-title">More in {property.city}</h2>
          <div className="similar-grid">
            {PROPERTIES
              .filter((p) => p.id !== property.id && p.city === property.city)
              .slice(0, 3)
              .map((p) => (
                <Link to={`/property/${p.id}`} key={p.id} className="similar-card">
                  <div className="similar-img">
                    <span className="similar-flag">{p.flag}</span>
                  </div>
                  <div className="similar-info">
                    <div className="similar-name">{p.name}</div>
                    <div className="similar-city">{p.city}</div>
                    <div className="similar-price">from £{p.pricePerWeek}/wk · {p.rating}</div>
                  </div>
                </Link>
              ))}
            {PROPERTIES
              .filter((p) => p.id !== property.id && p.country === property.country && p.city !== property.city)
              .slice(0, Math.max(0, 3 - PROPERTIES.filter((p) => p.id !== property.id && p.city === property.city).length))
              .map((p) => (
                <Link to={`/property/${p.id}`} key={p.id} className="similar-card">
                  <div className="similar-img">
                    <span className="similar-flag">{p.flag}</span>
                  </div>
                  <div className="similar-info">
                    <div className="similar-name">{p.name}</div>
                    <div className="similar-city">{p.city}</div>
                    <div className="similar-price">from £{p.pricePerWeek}/wk · {p.rating}</div>
                  </div>
                </Link>
              ))}
          </div>
        </div>
      </section></main>

      <SiteFooter />
    </div>
  );
}
