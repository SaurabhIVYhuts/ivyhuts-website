// Property intent. One Wishlist document per user (enforced by the unique
// index on userId below) holding an array of saved properties — NOT one
// document per saved property, since a user's wishlist is naturally
// bounded (nobody saves thousands of properties), unlike UserEvent which
// is intentionally NOT modeled this way.
//
// propertyId is the stable identifier already used throughout the
// frontend as Amber's own `id` field (see src/services/amberMapper.js —
// `listing.id`, already used as the React list key for property cards).
// city/propertyName/slug/image/price are point-in-time snapshots for
// marketing/historical display only — this collection must stay fully
// usable for reading a user's saved-property list even if Amber is down,
// so it never fetches from or depends on Amber, and it is NOT the
// authoritative property record (Amber remains that).
//
// Milestone 4 added slug/image/price alongside the existing
// city/propertyName snapshot fields — all five are already present on
// every mapped listing object the frontend has in hand at the moment of
// an "add to wishlist" click (see src/services/amberMapper.js's
// `mapAmberPropertyToListing`/`mapAmberPropertyDetails`: `.slug`, `.image`
// or `.images[0]`, `.price.from`/`.price.currency`) — no new Amber call or
// invented field was needed to populate them.
const mongoose = require("mongoose");
const { Schema } = mongoose;

const WishlistItemSchema = new Schema(
    {
        propertyId: { type: String, required: true },
        slug: { type: String, default: null },
        city: { type: String, default: null },
        propertyName: { type: String, default: null },
        image: { type: String, default: null },
        price: {
            amount: { type: Number, default: null },
            currency: { type: String, default: null },
        },
        addedAt: { type: Date, default: Date.now },
    },
    { _id: false }
);

const WishlistSchema = new Schema(
    {
        userId: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true },
        items: { type: [WishlistItemSchema], default: [] },
    },
    { timestamps: true }
);

// userId: unique — one wishlist document per user (also the query pattern:
// "load this user's wishlist" is always a lookup by userId). Enforcing
// one-document-per-user here, rather than at the future API layer, is what
// makes "add to wishlist" a single atomic $addToSet on one document instead
// of a check-then-insert race between two Wishlist documents for the same
// user. Deduplication of propertyId *within* items[] is an API-layer
// concern (the wishlist API), not a schema-level constraint.

// items.propertyId: a multikey index over the embedded array — added in
// Milestone 4 for a query pattern the unique-per-user userId index cannot
// serve at all: "which users have wishlisted property X" / "which
// properties are wishlisted most" (see docs/marketing-data-architecture.md
// Milestone 4 "future dashboard queries" list), which needs to search
// *across* every user's Wishlist document by an item field, not look up
// one user's own document. Without this index that query would be a full
// collection scan of every Wishlist document. Deliberately the only new
// index added this milestone — see the doc for why no new UserEvent index
// was needed (the existing userId+timestamp / event+timestamp indexes
// already cover this milestone's new query patterns).
WishlistSchema.index({ "items.propertyId": 1 });

module.exports = mongoose.models.Wishlist || mongoose.model("Wishlist", WishlistSchema);
