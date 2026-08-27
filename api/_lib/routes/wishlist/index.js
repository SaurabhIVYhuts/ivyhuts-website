// GET  /api/wishlist — the logged-in visitor's own wishlist (one request,
// used to hydrate every heart on a listings/detail page at once — see
// docs/marketing-data-architecture.md Milestone 4 for why no per-card
// endpoint is ever called).
// POST /api/wishlist — add a property snapshot to it. Idempotent: adding
// the same propertyId twice never creates a duplicate item.
//
// Wishlist is an authenticated-only feature (requireCustomerIdentity — 401
// if no session). Identity always comes from the session cookie, exactly
// like the Milestone 2/3 business API; no client-supplied userId is ever
// read or trusted here. Writes to MongoDB only — never calls Amber (see
// api/_lib/models/Wishlist.js's header comment).
const { connectToDatabase } = require("../../mongodb");
const { requireCustomerIdentity } = require("../../businessAuth");
const { checkBusinessWriteRateLimit } = require("../../businessRateLimit");
const Wishlist = require("../../models/Wishlist");
const { toSafeWishlist } = require("../../wishlistView");
const { recordEvent } = require("../../events");
const { withErrorHandling, badRequest, parseJsonBody } = require("../../validation");
const { sendSuccess } = require("../../apiResponse");

const MAX_STRING_LEN = 300;

function cleanString(value, max = MAX_STRING_LEN) {
    if (value === undefined || value === null) return null;
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed ? trimmed.slice(0, max) : null;
}

function parseWishlistItemInput(body) {
    const propertyId = cleanString(body.propertyId, 100);
    if (!propertyId) {
        throw badRequest("VALIDATION_ERROR", "propertyId is required.");
    }
    const priceAmount = body.price && typeof body.price === "object" ? Number(body.price.amount) : NaN;
    return {
        propertyId,
        slug: cleanString(body.slug),
        propertyName: cleanString(body.propertyName || body.title, 200),
        city: cleanString(body.city, 120),
        image: cleanString(body.image, 1000),
        price: Number.isFinite(priceAmount)
            ? { amount: priceAmount, currency: cleanString(body.price.currency, 10) }
            : null,
    };
}

async function handleGet(req, res) {
    const identity = await requireCustomerIdentity(req, res);
    if (!identity) return; // 401 already sent
    await connectToDatabase();
    const wishlist = await Wishlist.findOne({ userId: identity.mongoUser._id });
    sendSuccess(res, toSafeWishlist(wishlist));
}

async function handlePost(req, res) {
    const identity = await requireCustomerIdentity(req, res);
    if (!identity) return;
    await connectToDatabase();
    const body = parseJsonBody(req);
    const item = parseWishlistItemInput(body);
    const userId = identity.mongoUser._id;

    // Ensure the (unique-per-user) document exists first, then a single
    // atomic conditional $push — the filter's "items.propertyId": {$ne}
    // means the push only applies if the item isn't already present, so a
    // duplicate click can never create a second item even if it races with
    // itself; no read-then-write duplicate-detection window.
    await Wishlist.findOneAndUpdate(
        { userId },
        { $setOnInsert: { userId, items: [] } },
        { upsert: true }
    );
    const updated = await Wishlist.findOneAndUpdate(
        { userId, "items.propertyId": { $ne: item.propertyId } },
        { $push: { items: item } },
        { returnDocument: "after" }
    );

    if (updated) {
        await recordEvent({
            userId,
            event: "WISHLIST_ADDED",
            properties: { propertyId: item.propertyId, city: item.city },
        });
        sendSuccess(res, toSafeWishlist(updated), 201);
        return;
    }

    // No document matched the conditional filter — the item was already
    // present. Idempotent success, not an error (see Milestone 4 spec:
    // "second click -> already exists / idempotent -> no duplicate").
    const existing = await Wishlist.findOne({ userId });
    sendSuccess(res, toSafeWishlist(existing), 200);
}

module.exports = withErrorHandling(async (req, res) => {
    if (req.method === "GET") return handleGet(req, res);
    if (req.method === "POST") {
        await checkBusinessWriteRateLimit(req);
        return handlePost(req, res);
    }
    res.status(405).json({ error: "Method not allowed" });
});
