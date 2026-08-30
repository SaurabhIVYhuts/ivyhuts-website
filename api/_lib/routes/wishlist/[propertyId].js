// GET    /api/wishlist/:propertyId — whether the logged-in visitor has this
// specific property saved (status check, e.g. for a page that only has a
// propertyId in hand and isn't already holding the bulk GET /api/wishlist
// result — the frontend's normal path is the bulk endpoint, see index.js).
// DELETE /api/wishlist/:propertyId — remove it. Safe/idempotent: removing a
// property that isn't present succeeds without error and never corrupts
// the wishlist.
//
// Same authentication rule as index.js: requireCustomerIdentity (401 if no
// session), identity always from the session, never a client-supplied id —
// there is no :userId in this API's surface at all, so one user can never
// address another user's wishlist through any parameter here.
const { connectToDatabase } = require("../../mongodb");
const { requireCustomerIdentity } = require("../../businessAuth");
const { checkBusinessWriteRateLimit } = require("../../businessRateLimit");
const Wishlist = require("../../models/Wishlist");
const { toSafeWishlistItem } = require("../../wishlistView");
const { recordEvent } = require("../../events");
const { withErrorHandling, badRequest } = require("../../validation");
const { sendSuccess } = require("../../apiResponse");

function requirePropertyId(raw) {
    const propertyId = typeof raw === "string" ? raw.trim() : "";
    if (!propertyId || propertyId.length > 100) {
        throw badRequest("VALIDATION_ERROR", "propertyId is not valid.");
    }
    return propertyId;
}

async function handleGet(req, res, propertyId) {
    const identity = await requireCustomerIdentity(req, res);
    if (!identity) return;
    await connectToDatabase();
    const wishlist = await Wishlist.findOne({ userId: identity.mongoUser._id, "items.propertyId": propertyId });
    const item = wishlist ? wishlist.items.find((i) => i.propertyId === propertyId) : null;
    sendSuccess(res, { wishlisted: !!item, item: item ? toSafeWishlistItem(item) : null });
}

async function handleDelete(req, res, propertyId) {
    const identity = await requireCustomerIdentity(req, res);
    if (!identity) return;
    await connectToDatabase();
    const userId = identity.mongoUser._id;

    // Checked explicitly rather than trusting updateOne's modifiedCount:
    // MongoDB's $pull reports a document as "modified" once it matches the
    // filter, even when zero array elements actually matched and were
    // removed — so modifiedCount alone can't tell a real removal apart from
    // a no-op on an already-absent item. Confirming presence first (and
    // then pulling) is what actually answers "was something removed?".
    const before = await Wishlist.findOne({ userId, "items.propertyId": propertyId }).select("_id");
    const removed = !!before;
    if (removed) {
        await Wishlist.updateOne({ userId }, { $pull: { items: { propertyId } } });
        await recordEvent({
            userId,
            event: "WISHLIST_REMOVED",
            properties: { propertyId },
        });
    }
    sendSuccess(res, { removed });
}

module.exports = withErrorHandling(async (req, res) => {
    const propertyId = requirePropertyId(req.query.propertyId);
    if (req.method === "GET") return handleGet(req, res, propertyId);
    if (req.method === "DELETE") {
        await checkBusinessWriteRateLimit(req);
        return handleDelete(req, res, propertyId);
    }
    res.status(405).json({ error: "Method not allowed" });
});
