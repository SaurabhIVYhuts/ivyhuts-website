import React, { useEffect, useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { getPropertyBySlug } from "../services/amberApi";
import { mapAmberPropertyDetails } from "../services/amberMapper";
import { addRecentProperty } from "../services/recentActivity";
import SiteNavbar from "../components/layout/SiteNavbar";
import SiteFooter from "../components/layout/SiteFooter";
import PropertyGallery from "../components/listing/PropertyGallery";
import RoomTypeCard from "../components/listing/RoomTypeCard";
import WishlistHeart from "../components/listing/WishlistHeart";
import ShareButton from "../components/listing/ShareButton";
import { trackEvent } from "../lib/eventsApi";
import { getAmenityIcon } from "../lib/amenityIcons";
import Seo from "../components/Seo";
import "./PropertyDetailPage.css";

const PAYMENT_FACT_LABELS = ["Guarantor", "Lease Duration", "Non-Students Allowed"];

// A small REAL subset of the already-fetched, already-mapped property —
// just enough for the homepage's "Continue Exploring" compact card. Reusing
// this avoids ever re-fetching the property from Amber just to show it again.
function buildRecentPropertySummary(property) {
  if (!property || !property.slug) return null;
  return {
    id: property.id,
    slug: property.slug,
    name: property.name,
    address: { locality: property.address?.locality || "", country: property.address?.country || "" },
    images: (property.images || []).slice(0, 2),
    price: { from: property.price?.from ?? null, currency: property.price?.currency || "", duration: property.price?.duration || "" },
    rating: property.rating ? { overall: property.rating.overall } : null,
    badges: (property.badges || []).slice(0, 1),
  };
}

export default function PropertyDetailPage() {
  const { slug } = useParams();
  const navigate = useNavigate();
  const [property, setProperty] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      setProperty(null);
      try {
        const raw = await getPropertyBySlug(slug);
        if (cancelled) return;
        const mapped = raw ? mapAmberPropertyDetails(raw) : null;
        setProperty(mapped);
        const summary = buildRecentPropertySummary(mapped);
        if (summary) addRecentProperty(summary);
        if (mapped && mapped.id != null) {
          trackEvent("PROPERTY_VIEWED", {
            propertyId: String(mapped.id),
            propertySlug: mapped.slug || undefined,
            city: mapped.address?.locality || undefined,
            source: "property-detail",
          });
        }
      } catch (err) {
        if (!cancelled) {
          console.error("PropertyDetailPage error:", err);
          setError(
            err && err.isRateLimit
              ? { isRateLimit: true, retryAfterSeconds: err.retryAfterSeconds }
              : { message: (err && err.message) || String(err) }
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [slug]);

  const handleEnquire = (context = {}) => {
    if (!property) return;
    const params = new URLSearchParams({
      inventory: property.id,
      property: property.name,
      ...(context.roomId != null ? { room: context.roomId } : {}),
      ...(context.roomName ? { roomName: context.roomName } : {}),
      ...(context.tenancyId != null ? { tenancy: context.tenancyId } : {}),
      ...(context.duration ? { duration: context.duration } : {}),
      ...(context.moveIn ? { moveIn: context.moveIn } : {}),
      ...(context.moveOut ? { moveOut: context.moveOut } : {}),
      ...(context.price != null ? { price: String(context.price) } : {}),
      ...(context.currency ? { currency: context.currency } : {}),
      ...(context.priceUnit ? { priceUnit: context.priceUnit } : {}),
    });
    navigate(`/contact?${params.toString()}`);
  };

  const scrollToSection = (id) => (e) => {
    e.preventDefault();
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  if (loading) {
    return (
      <div className="pdp-page">
        <SiteNavbar />
        <div className="pdp-loading">
          <div className="pdp-skel pdp-skel-gallery" />
          <div className="pdp-skel pdp-skel-line" style={{ width: "55%" }} />
          <div className="pdp-skel pdp-skel-line" style={{ width: "35%" }} />
          <div className="pdp-skel pdp-skel-line" style={{ width: "25%" }} />
        </div>
        <SiteFooter />
      </div>
    );
  }

  if (error) {
    return (
      <div className="pdp-page">
        <Seo title="Property unavailable" noindex />
        <SiteNavbar />
        <div className="pdp-status">
          <h1>We couldn't load this property right now.</h1>
          <p>
            {error.isRateLimit
              ? `Our Server fetching your request Please Wait for  ${Math.ceil(error.retryAfterSeconds / 60)} minute${Math.ceil(error.retryAfterSeconds / 60) === 1 ? "" : "s"}.`
              : "Please try again in a moment."}
          </p>
          <Link to="/properties" className="pdp-back-link">← Back to listings</Link>
        </div>
        <SiteFooter />
      </div>
    );
  }

  if (!property) {
    return (
      <div className="pdp-page">
        <Seo title="Property not found" noindex />
        <SiteNavbar />
        <div className="pdp-status">
          <h1>Property not found</h1>
          <p>This listing may have been removed or is no longer available.</p>
          <Link to="/properties" className="pdp-back-link">← Back to listings</Link>
        </div>
        <SiteFooter />
      </div>
    );
  }

  const {
    name, address, images, price, distances, amenityGroups, badges,
    quickFacts, policyLinks, paymentInfo, roomTypes, rating, reviewSummary, social,
    coordinates, available, isSoldOut,
  } = property;

  const paymentFacts = quickFacts.filter((f) => PAYMENT_FACT_LABELS.includes(f.label));
  const overviewFacts = quickFacts.filter((f) => !PAYMENT_FACT_LABELS.includes(f.label));
  const hasReviews = !!reviewSummary || (rating && rating.categories.length > 0);
  const hasPayment = paymentFacts.length > 0 || paymentInfo.length > 0 || policyLinks.length > 0;

  const sections = [
    { id: "overview", label: "Overview", show: true },
    { id: "amenities", label: "Amenities", show: amenityGroups.length > 0 },
    { id: "rooms", label: "Room Types", show: roomTypes.length > 0 },
    { id: "reviews", label: "Reviews", show: hasReviews },
    { id: "payment", label: "Payment & Fees", show: hasPayment },
    { id: "map", label: "Map", show: !!coordinates },
  ].filter((s) => s.show);

  const pdpLocation = address.locality || address.country || "";
  const pdpDescription = `${name}${pdpLocation ? ` in ${pdpLocation}` : ""}. Verified student accommodation${price?.from ? ` from ${price.currency || ""}${price.from}` : ""} — compare rooms, amenities and reviews on IVYhuts.`;

  return (
    <div className="pdp-page">
      <Seo
        title={pdpLocation ? `${name} — Student Accommodation in ${pdpLocation}` : name}
        description={pdpDescription}
        canonical={`/property/${encodeURIComponent(slug)}`}
        image={images?.[0]?.url || undefined}
        type="article"
      />
      <SiteNavbar />

      <div className="pdp-breadcrumb">
        <div className="pdp-breadcrumb-inner">
          <Link to="/">Home</Link>
          {address.country && <><span>/</span><span>{address.country}</span></>}
          {address.locality && (
            <><span>/</span><Link to={`/properties?city=${encodeURIComponent(address.locality)}`}>{address.locality}</Link></>
          )}
          <span>/</span>
          <span className="pdp-breadcrumb-current">{name}</span>
        </div>
      </div>

      <main className="pdp-main">
        <PropertyGallery images={images} alt={name} />

        <div className="pdp-body">
          <div className="pdp-content">
            <header className="pdp-header">
              <h1>{name}</h1>
              {address.full && <p className="pdp-address">{address.full}</p>}
              <div className="pdp-header-meta">
                {rating && <span className="pdp-rating">★ {rating.overall}</span>}
                {distances.cityCentre && <span>{distances.cityCentre} from city centre</span>}
                {distances.nearby[0] && <span>{distances.nearby[0].distance} from {distances.nearby[0].place}</span>}
              </div>
              {badges.length > 0 && (
                <div className="pdp-badges">
                  {badges.map((b) => <span key={b} className="pdp-badge">{b}</span>)}
                </div>
              )}
              {!available && <div className="pdp-unavailable-banner">This property currently has no available rooms.</div>}
            </header>

            {sections.length > 1 && (
              <nav className="pdp-section-nav" aria-label="Property sections">
                {sections.map((s) => (
                  <a key={s.id} href={`#${s.id}`} onClick={scrollToSection(s.id)}>{s.label}</a>
                ))}
              </nav>
            )}

            <section id="overview" className="pdp-section">
              <h2>Overview</h2>
              {overviewFacts.length > 0 && (
                <div className="pdp-facts-grid">
                  {overviewFacts.map((f) => (
                    <div key={f.label} className="pdp-fact">
                      <span className="pdp-fact-label">{f.label}</span>
                      <span className="pdp-fact-value">{f.value}</span>
                    </div>
                  ))}
                </div>
              )}
              {distances.nearby.length > 0 && (
                <div className="pdp-nearby-list">
                  <h3>Nearby</h3>
                  {distances.nearby.map((d) => (
                    <div key={d.place} className="pdp-nearby-item">
                      <span>{d.place}</span>
                      <span>{d.distance}</span>
                    </div>
                  ))}
                </div>
              )}
              {overviewFacts.length === 0 && distances.nearby.length === 0 && (
                <p className="pdp-empty-note">No additional overview details available for this property.</p>
              )}
            </section>

            {amenityGroups.length > 0 && (
              <section id="amenities" className="pdp-section">
                <h2>Amenities</h2>
                <div className="pdp-amenity-groups">
                  {amenityGroups.map((g) => (
                    <div key={g.name} className="pdp-amenity-group">
                      <h3>{g.name}</h3>
                      <div className="pdp-amenity-items">
                        {g.items.map((item) => {
                          const Icon = getAmenityIcon(item);
                          return (
                            <span key={item} className="pdp-amenity-item">
                              <span className="pdp-amenity-icon-chip">
                                <Icon size={17} strokeWidth={1.75} aria-hidden="true" />
                              </span>
                              {item}
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {roomTypes.length > 0 && (
              <section id="rooms" className="pdp-section">
                <h2>Room Types</h2>
                <div className="pdp-room-list">
                  {roomTypes.map((room) => (
                    <RoomTypeCard key={room.id} room={room} onEnquire={handleEnquire} fallbackImage={property.images?.[0]?.url} />
                  ))}
                </div>
              </section>
            )}

            {hasReviews && (
              <section id="reviews" className="pdp-section">
                <h2>What Students Say</h2>
                {rating && rating.categories.length > 0 && (
                  <div className="pdp-rating-breakdown">
                    {rating.categories.map((c) => (
                      <div key={c.name} className="pdp-rating-row">
                        <span className="pdp-rating-name">{c.name}</span>
                        <span className="pdp-rating-bar"><span style={{ width: `${(c.value / 5) * 100}%` }} /></span>
                        <span className="pdp-rating-value">{c.value}</span>
                      </div>
                    ))}
                  </div>
                )}
                {reviewSummary && <p className="pdp-review-summary">{reviewSummary}</p>}
              </section>
            )}

            {hasPayment && (
              <section id="payment" className="pdp-section">
                <h2>Payment &amp; Fees</h2>
                {paymentFacts.length > 0 && (
                  <div className="pdp-facts-grid">
                    {paymentFacts.map((f) => (
                      <div key={f.label} className="pdp-fact">
                        <span className="pdp-fact-label">{f.label}</span>
                        <span className="pdp-fact-value">{f.value}</span>
                      </div>
                    ))}
                  </div>
                )}
                {paymentInfo.map((n) => (
                  <div key={n.label} className="pdp-payment-note">
                    <h4>{n.label}</h4>
                    <p>{n.text}</p>
                  </div>
                ))}
                {policyLinks.length > 0 && (
                  <div className="pdp-policy-links">
                    {policyLinks.map((l) => (
                      <a key={l.url} href={l.url} target="_blank" rel="noopener noreferrer" className="pdp-policy-link">
                        {l.label} ↗
                      </a>
                    ))}
                  </div>
                )}
              </section>
            )}

            {coordinates && (
              <section id="map" className="pdp-section">
                <h2>Location</h2>
                <div className="pdp-map-wrap">
                  <iframe
                    title="Property location map"
                    className="pdp-map-frame"
                    loading="lazy"
                    src={`https://www.openstreetmap.org/export/embed.html?bbox=${coordinates.lng - 0.012}%2C${coordinates.lat - 0.008}%2C${coordinates.lng + 0.012}%2C${coordinates.lat + 0.008}&layer=mapnik&marker=${coordinates.lat}%2C${coordinates.lng}`}
                  />
                </div>
              </section>
            )}
          </div>

          <aside className="pdp-sidebar">
            <div className="pdp-sidebar-card">
              <div className="pdp-sidebar-name-row">
                <div className="pdp-sidebar-name">{name}</div>
                <ShareButton
                  className="share-btn--on-light"
                  title={name}
                  text={`Check out ${name} on IVYhuts`}
                />
                <WishlistHeart
                  className="wishlist-heart-btn--on-light"
                  property={{
                    propertyId: String(property.id),
                    slug: property.slug || null,
                    propertyName: name || null,
                    city: address?.locality || null,
                    image: property.image || null,
                    price: price?.from != null ? { amount: price.from, currency: price.currency || null } : null,
                  }}
                />
              </div>
              {isSoldOut ? (
                <div className="pdp-sidebar-price-label pdp-sidebar-price-label--soldout">Sold Out</div>
              ) : price.from !== null ? (
                <div className="pdp-sidebar-price">
                  <span className="pdp-sidebar-price-label">From</span>
                  <div>
                    <strong>{price.currency}{price.from}</strong>
                    {price.duration && <span className="pdp-sidebar-price-duration"> / {price.duration}</span>}
                  </div>
                </div>
              ) : (
                <div className="pdp-sidebar-price-label">Price on request</div>
              )}
              <button type="button" className="btn btn-primary btn-block btn-lg" onClick={() => handleEnquire()}>Enquire</button>
              {social.shortlisted && <p className="pdp-sidebar-social">{social.shortlisted}</p>}
            </div>
            <div className="pdp-sidebar-card">
              <div className="pdp-trust-item">
                <div className="pdp-trust-title">Lowest Price Guarantee</div>
                <div className="pdp-trust-text">We find you the lowest available weekly price.</div>
              </div>
              <div className="pdp-trust-item">
                <div className="pdp-trust-title">Verified Properties</div>
                <div className="pdp-trust-text">Only verified listings shown.</div>
              </div>
              <div className="pdp-trust-item">
                <div className="pdp-trust-title">24/7 Support</div>
                <div className="pdp-trust-text">Always here for you.</div>
              </div>
            </div>
          </aside>
        </div>
      </main>

      {/* MOBILE-ONLY sticky bottom bar — duplicates just the price + Enquire
          action from the sidebar card above (not the wishlist heart or
          social-proof line), matching Amber's compact bottom bar. Desktop
          keeps only the full sidebar card (.pdp-sidebar is hidden here via
          .mobile-only — see PropertyDetailPage.css). */}
      <div className="pdp-sticky-bar mobile-only">
        <div className="pdp-sticky-bar-price">
          {isSoldOut ? (
            <span className="pdp-sticky-bar-price-label pdp-sticky-bar-price-label--soldout">Sold Out</span>
          ) : price.from !== null ? (
            <>
              <span className="pdp-sticky-bar-price-label">From</span>
              <strong>
                {price.currency}{price.from}
                {price.duration ? <span className="pdp-sticky-bar-duration"> / {price.duration}</span> : null}
              </strong>
            </>
          ) : (
            <span className="pdp-sticky-bar-price-label">Price on request</span>
          )}
        </div>
        <button type="button" className="btn btn-primary" onClick={() => handleEnquire()}>Enquire</button>
      </div>

      <SiteFooter />
    </div>
  );
}