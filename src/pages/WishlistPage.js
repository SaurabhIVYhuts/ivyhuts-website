import React, { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import SiteNavbar from "../components/layout/SiteNavbar";
import SiteFooter from "../components/layout/SiteFooter";
import ListingCard from "../components/listing/ListingCard";
import { useWishlist } from "../context/WishlistContext";
import "./WishlistPage.css";
import Seo from "../components/Seo";

// Adapts a Wishlist item (the stored snapshot shape — propertyId/slug/city/
// propertyName/image/price/addedAt, see api/_lib/models/Wishlist.js and
// api/_lib/wishlistView.js) into the full `listing` shape ListingCard
// expects — the same card design used on /find-rooms's default List view,
// so a saved property looks identical there and here. Everything here
// comes straight from the snapshot already sitting in WishlistContext —
// never re-fetched from Amber. The snapshot has no equivalent for
// distances/amenities/rooms/rating/badges/full address, so those are left
// empty rather than invented; ListingCard already renders fine with any of
// them absent (each section is conditionally rendered).
function mapWishlistItemToListing(item) {
  return {
    id: item.propertyId,
    slug: item.slug || null,
    name: item.propertyName || "Saved property",
    address: { full: item.city || null, locality: item.city || null },
    images: item.image ? [{ url: item.image }] : [],
    price: item.price && item.price.amount != null
      ? { from: item.price.amount, currency: item.price.currency || "", original: null, duration: null }
      : { from: null },
    distances: { cityCentre: null, nearby: [] },
    amenities: { shown: [], moreCount: 0 },
    rooms: { count: 0, types: [] },
    rating: null,
    badges: [],
    social: { shortlisted: null },
  };
}

export default function WishlistPage() {
  // Same shared Context every other wishlist consumer reads — this page
  // never calls GET /api/wishlist itself; WishlistProvider already fetched
  // it once (on app mount, or via syncAfterLogin right after signing in).
  const { authChecked, isAuthenticated, items } = useWishlist();
  const navigate = useNavigate();

  // Same pattern as PropertyListingPage.js's handleEnquire — the Enquire
  // button on ListingCard needs this prop regardless of which page renders
  // the card.
  const handleEnquire = (listing) => {
    const params = new URLSearchParams({ inventory: listing.id, property: listing.name });
    navigate(`/contact?${params.toString()}`);
  };

  useEffect(() => {
    if (authChecked && !isAuthenticated) {
      navigate(`/login?returnTo=${encodeURIComponent("/wishlist")}`, { replace: true });
    }
  }, [authChecked, isAuthenticated, navigate]);

  if (!authChecked || !isAuthenticated) {
    return (
      <div className="wishlist-page">
        <SiteNavbar />
        <main className="wishlist-main">
          <div className="wishlist-loading">Loading your wishlist…</div>
        </main>
        <SiteFooter />
      </div>
    );
  }

  return (
    <div className="wishlist-page">
      <Seo title="Your wishlist" noindex />
      <SiteNavbar />
      <main className="wishlist-main">
        <h1 className="wishlist-title">My Wishlist</h1>

        {items.length === 0 ? (
          <div className="wishlist-empty">
            <p className="wishlist-empty-title">Your wishlist is empty</p>
            <p className="wishlist-empty-sub">Save properties you like and they'll appear here.</p>
            <button type="button" className="btn btn-primary" onClick={() => navigate("/find-rooms")}>
              Explore Properties
            </button>
          </div>
        ) : (
          <div className="wishlist-list">
            {items.map((item) => (
              <ListingCard key={item.propertyId} listing={mapWishlistItemToListing(item)} onEnquire={handleEnquire} />
            ))}
          </div>
        )}
      </main>
      <SiteFooter />
    </div>
  );
}
