import React from "react";
import { Heart } from "lucide-react";
import { useNavigate, useLocation } from "react-router-dom";
import { useWishlist } from "../../context/WishlistContext";
import { setPendingWishlist } from "../../lib/pendingWishlist";

// `property` is the small real snapshot (propertyId/slug/propertyName/city/
// image/price) each card already has from its already-mapped listing data —
// see api/_lib/models/Wishlist.js for why these exact fields.
export default function WishlistHeart({ property, className = "" }) {
  const { authChecked, isAuthenticated, idsSet, add, remove } = useWishlist();
  const navigate = useNavigate();
  const location = useLocation();

  if (!property || !property.propertyId) return null;
  const wishlisted = idsSet.has(property.propertyId);

  const handleClick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!authChecked) return; // avoid guessing auth state before we actually know it

    if (!isAuthenticated) {
      setPendingWishlist(property);
      navigate(`/login?returnTo=${encodeURIComponent(location.pathname + location.search)}`);
      return;
    }

    if (wishlisted) remove(property.propertyId);
    else add(property);
  };

  return (
    <button
      type="button"
      className={`wishlist-heart-btn${wishlisted ? " active" : ""} ${className}`.trim()}
      onClick={handleClick}
      aria-label={wishlisted ? "Remove from wishlist" : "Add to wishlist"}
      aria-pressed={wishlisted}
    >
      <Heart size={18} fill={wishlisted ? "currentColor" : "none"} />
    </button>
  );
}
