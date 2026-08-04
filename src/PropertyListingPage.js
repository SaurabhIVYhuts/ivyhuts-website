import React, { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { getProperties } from "./services/amberApi";
import SiteNavbar from "./SiteNavbar";
import SiteFooter from "./SiteFooter";

export default function PropertyListingPage() {
  const [searchParams] = useSearchParams();
  const city = searchParams.get("city");

  const [properties, setProperties] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const navigate = useNavigate();

  useEffect(() => {
  async function load() {
    setLoading(true);
    setError(null);
    try {
      const data = await getProperties(city);

      // data is already logged inside amberApi; avoid double logging here
      setProperties(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error("PropertyListingPage error:", err);
      setError(err && err.message ? err.message : String(err));
      setProperties([]);
    } finally {
      setLoading(false);
    }
  }

  load();
}, [city]);


  const [query, setQuery] = useState("");
  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");

  const getImage = (p) => {
    // Prefer explicit featured link, then common media arrays, then first image-like entry
    try {
      if (!p) return "";
      if (typeof p.image_featured_link === "string" && p.image_featured_link.trim()) return p.image_featured_link;
      if (p.featured_image && typeof p.featured_image === 'string' && p.featured_image.trim()) return p.featured_image;
      if (p.media && Array.isArray(p.media.images) && p.media.images.length) {
        const img = p.media.images.find(i => i && (i.url || i.src || i.path));
        if (img) return img.url || img.src || img.path || "";
      }
      if (Array.isArray(p.images) && p.images.length) {
        const first = p.images[0];
        if (typeof first === 'string') return first;
        if (first && (first.url || first.src)) return first.url || first.src;
      }
      if (Array.isArray(p.photos) && p.photos.length) {
        const ph = p.photos[0];
        if (typeof ph === 'string') return ph;
        if (ph && (ph.url || ph.src)) return ph.url || ph.src;
      }
      return "";
    } catch (e) {
      return "";
    }
  };

  const getName = (p) => {
    if (!p) return "";
    return p.name || p.title || p.property_name || p.propertyName || "";
  };

  const getCity = (p) => {
    if (!p) return "";
    return (
      p.location?.locality?.long_name || p.location?.city?.long_name || p.city || p.locality || (p.address && (p.address.locality || p.address.city)) || ""
    );
  };

  const getCountry = (p) => {
    if (!p) return "";
    return p.location?.country?.long_name || (p.location?.country && (p.location.country.long_name || p.location.country.name)) || p.country || p.country_name || "";
  };

  const parseNumber = (v) => {
    if (v == null) return null;
    if (typeof v === 'number') return v;
    if (typeof v === 'string') {
      const n = Number(v.replace(/[^0-9.\-]/g, ''));
      return Number.isFinite(n) ? n : null;
    }
    if (typeof v === 'object') {
      // sometimes price is { amount: 123 }
      if (v.amount) return parseNumber(v.amount);
      if (v.value) return parseNumber(v.value);
    }
    return null;
  };

  const getLowestPrice = (p) => {
    if (!p) return null;
    // Check top-level pricing
    const top = parseNumber(p.pricing?.price ?? p.price ?? p.starting_price ?? p.price_per_week ?? p.weekly_price);
    if (top !== null) return top;

    // If children exist, compute min available price among children
    if (Array.isArray(p.children) && p.children.length) {
      let min = null;
      p.children.forEach((c) => {
        const cand = parseNumber(c.pricing?.price ?? c.price ?? c.starting_price ?? c.price_per_week ?? c.weekly_price ?? (c.rates && c.rates[0] && c.rates[0].price));
        if (cand !== null && (min === null || cand < min)) min = cand;
      });
      if (min !== null) return min;
    }

    // last-resort: scan object for number-like values in common keys
    const candidates = ['price', 'starting_price', 'amount', 'cost', 'weekly_price', 'price_per_week'];
    for (const k of candidates) {
      const val = parseNumber(p[k]);
      if (val !== null) return val;
    }
    return null;
  };

  const getCurrency = (p) => {
    if (!p) return "";
    return p.pricing?.currency || p.currency || p.currency_code || p.currencyCode || "";
  };

  const getBillingDuration = (p) => {
    if (!p) return "";
    return p.pricing?.duration || p.price_unit || p.pricing?.unit || p.duration || "";
  };

  const getRoomCount = (p) => {
    if (!p) return null;
    if (Array.isArray(p.children)) return p.children.length;
    if (p.meta && typeof p.meta.bedroom_count === 'number') return p.meta.bedroom_count;
    if (p.bedrooms) return parseNumber(p.bedrooms) || null;
    return null;
  };

  const getPropertyType = (p) => {
    if (!p) return "";
    return p.meta?.inventory_type || p.inventory_type || p.type || p.property_type || "";
  };

  const normalizeFeature = (f) => {
    if (!f) return null;
    if (typeof f === 'string') return f;
    if (typeof f === 'object') return f.name || f.title || f.label || f.value || null;
    return null;
  };

  const getAmenities = (p, limit = 5) => {
    if (!p) return [];
    let list = [];
    if (Array.isArray(p.features)) list = p.features.map(normalizeFeature).filter(Boolean);
    if (list.length === 0 && Array.isArray(p.tags)) list = p.tags.map(normalizeFeature).filter(Boolean);
    if (list.length === 0 && Array.isArray(p.amenities)) list = p.amenities.map(normalizeFeature).filter(Boolean);
    // dedupe and return up to limit
    const seen = new Set();
    const out = [];
    for (const it of list) {
      if (!seen.has(it)) { seen.add(it); out.push(it); }
      if (out.length >= limit) break;
    }
    return out;
  };

  const getFullAddress = (p) => {
    if (!p) return "";
    // Prefer formatted address if present
    if (p.address && typeof p.address === 'string') return p.address;
    if (p.address && typeof p.address === 'object') {
      const parts = [p.address.line1, p.address.line2, p.address.locality, p.address.city, p.address.postcode, p.address.country].filter(Boolean);
      if (parts.length) return parts.join(', ');
    }
    // check location formatted forms
    if (p.location && (p.location.formatted_address || p.location.address)) return p.location.formatted_address || p.location.address;
    // fallback to combining name/city/country
    const city = getCity(p);
    const country = getCountry(p);
    if (city || country) return [city, country].filter(Boolean).join(', ');
    return "";
  };

  // local search & filter (non-destructive)
  const filteredProperties = React.useMemo(() => {
    const q = (query || city || "").toLowerCase().trim();
    return properties.filter((p) => {
      // text match
      const name = (getName(p) || "").toLowerCase();
      const cityField = (getCity(p) || "").toLowerCase();
      const countryField = (getCountry(p) || "").toLowerCase();
      const textMatch = !q || name.includes(q) || cityField.includes(q) || countryField.includes(q);

      // price filter
      const priceVal = Number(getLowestPrice(p)) || 0;
      const minOk = !minPrice || priceVal >= Number(minPrice);
      const maxOk = !maxPrice || priceVal <= Number(maxPrice);

      return textMatch && minOk && maxOk;
    });
  }, [properties, query, city, minPrice, maxPrice]);

  return (
    <>
      <SiteNavbar />

      <div style={{ padding: "24px 40px" }} className="listings-page">
        <div style={{ marginBottom: 18 }}>
          <h1 style={{ margin: 0 }}>{city || "All"} Accommodation</h1>
        </div>

        <div className="listings-layout" style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: 20 }}>
          <div>
            {/* Search & Filters */}
            <div style={{ marginBottom: 12, display: "flex", gap: 8, alignItems: "center" }}>
              <input
                aria-label="Search"
                placeholder="Search city, property or university"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                style={{ flex: 1, padding: 10, borderRadius: 8, border: "1px solid #ddd" }}
              />
              <input
                aria-label="Min price"
                placeholder="Min"
                value={minPrice}
                onChange={(e) => setMinPrice(e.target.value.replace(/[^0-9]/g, ""))}
                style={{ width: 80, padding: 10, borderRadius: 8, border: "1px solid #ddd" }}
              />
              <input
                aria-label="Max price"
                placeholder="Max"
                value={maxPrice}
                onChange={(e) => setMaxPrice(e.target.value.replace(/[^0-9]/g, ""))}
                style={{ width: 80, padding: 10, borderRadius: 8, border: "1px solid #ddd" }}
              />
            </div>

            {loading && <h2>Loading...</h2>}
            {error && (
              <div style={{ color: "#b00020", marginBottom: 16 }}>
                <strong>Error:</strong> {error}
              </div>
            )}

            {!loading && filteredProperties.length === 0 && (
              <div style={{ padding: 20, background: "#fff", borderRadius: 12 }}>
                No properties found.
              </div>
            )}

            {filteredProperties.map((property) => {
              const id = property?.inventory_id || property?.inventoryId || property?.id || property?._id || (property?.inventory && property.inventory.id) || getName(property).slice(0,10);
              return (
                <div
                  key={id}
                  /* Navigation to PropertyDetailPage is disabled until API integration is complete */
                  role="group"
                  style={{
                    display: "block",
                    border: "1px solid #e9e6ea",
                    marginBottom: "18px",
                    padding: "14px",
                    textDecoration: "none",
                    color: "#000",
                    borderRadius: 12,
                    background: "#fff",
                    cursor: "default"
                  }}
                >
                  <div style={{ display: "flex", gap: 14 }}>
                    <div style={{ width: 200, height: 140, flexShrink: 0, overflow: "hidden", borderRadius: 10 }}>
                      <img src={getImage(property)} alt={getName(property)} style={{ width: "100%", height: "100%", objectFit: "cover" }} loading="lazy" />
                    </div>
                    <div style={{ flex: 1 }}>
                      <h3 style={{ margin: "0 0 6px" }}>{getName(property)}</h3>
                      {getFullAddress(property) ? (
                        <div style={{ color: "#6B4E5E", marginBottom: 8 }}>{getFullAddress(property)}</div>
                      ) : (
                        getCity(property) || getCountry(property) ? (
                          <div style={{ color: "#6B4E5E", marginBottom: 8 }}>{getCity(property)}{getCity(property) && getCountry(property) ? ", " : ""}{getCountry(property)}</div>
                        ) : null
                      )}
                      <div style={{ display: "flex", gap: 12, alignItems: "center", fontWeight: 700 }}>
                        {getLowestPrice(property) !== null ? (
                          <div>{`${getLowestPrice(property)} ${getCurrency(property) || ''}${getBillingDuration(property) ? ` / ${getBillingDuration(property)}` : ''}`}</div>
                        ) : null}
                        <div style={{ color: "#5E3A6B", fontWeight: 600 }}>{getPropertyType(property) || ""}</div>
                        {getRoomCount(property) ? <div style={{ color: "#5E3A6B" }}>{`${getRoomCount(property)} bd`}</div> : null}
                      </div>
                      <div style={{ marginTop: 10, color: "#6B4E5E" }}>{getAmenities(property, 5).length ? getAmenities(property, 5).join(', ') : null}</div>

                      {/* Room variants (children) */}
                      {property?.children && Array.isArray(property.children) && (
                        <div style={{ marginTop: 8, color: "#5E3A6B" }}>
                          {property.children.length} room variant{property.children.length > 1 ? 's' : ''}
                        </div>
                      )}

                      {/* Enquire button - opens the lead capture form directly */}
                      <div style={{ marginTop: 12 }}>
                        <button
                          onClick={(e) => { e.stopPropagation(); navigate(`/contact?inventory=${encodeURIComponent(id)}`); }}
                          style={{ padding: '8px 12px', borderRadius: 8, border: 'none', background: '#5E3A6B', color: '#fff', cursor: 'pointer' }}
                        >
                          Enquire
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Right Sidebar */}
          <aside style={{ position: "sticky", top: 88, alignSelf: "start" }}>
            <div style={{ background: "#fff", padding: 16, borderRadius: 12, border: "1px solid #e9e6ea", marginBottom: 12 }}>
              <button style={{ width: "100%", padding: 10, borderRadius: 8, background: "#5E3A6B", color: "#fff", border: "none" }}>Map Coming soon...</button>
              <div style={{ marginTop: 12 }}>
                <div style={{ fontWeight: 700 }}>Lowest Price Guarantee</div>
                <div style={{ color: "#6B4E5E", fontSize: 13 }}>We find you the lowest available weekly price.</div>
              </div>
            </div>
            <div style={{ background: "#fff", padding: 14, borderRadius: 12, border: "1px solid #e9e6ea" }}>
              <div style={{ fontWeight: 700 }}>Verified Properties</div>
              <div style={{ color: "#6B4E5E", fontSize: 13, marginTop: 6 }}>Only verified listings shown</div>
              <div style={{ marginTop: 12, fontWeight: 700 }}>24/7 Support</div>
              <div style={{ color: "#6B4E5E", fontSize: 13, marginTop: 6 }}>Always here for you</div>
            </div>
          </aside>
        </div>
      </div>

      <SiteFooter />
    </>
  );
}