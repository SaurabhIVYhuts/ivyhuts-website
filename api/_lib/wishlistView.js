// Shared "MongoDB Wishlist document -> safe API response" projection,
// mirroring the pattern already used by customerView.js/enquiryView.js/
// leadView.js. There's currently nothing sensitive on this model to
// redact, but this keeps the response shape defined in one place rather
// than each handler serializing the Mongoose document ad hoc.
function toSafeWishlistItem(item) {
    return {
        propertyId: item.propertyId,
        slug: item.slug,
        propertyName: item.propertyName,
        city: item.city,
        image: item.image,
        price: item.price ? { amount: item.price.amount, currency: item.price.currency } : null,
        addedAt: item.addedAt,
    };
}

function toSafeWishlist(wishlist) {
    if (!wishlist) return { items: [] };
    return {
        id: wishlist._id,
        items: (wishlist.items || []).map(toSafeWishlistItem),
        updatedAt: wishlist.updatedAt,
    };
}

module.exports = { toSafeWishlist, toSafeWishlistItem };
