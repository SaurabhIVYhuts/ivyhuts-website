// GET   /api/customers/:id — Customer 360 foundation, internal roles only.
// PATCH /api/customers/:id — controlled profile update, internal roles only.
//
// Self-access for an ordinary USER goes through GET /api/customers/me
// instead (see that file) — this endpoint is deliberately internal-role
// only, even for a user requesting their own id, to keep the authorization
// story simple and match the spec's explicit framing.
const { connectToDatabase } = require("../../mongodb");
const { requireRole } = require("../../businessAuth");
const { checkBusinessWriteRateLimit } = require("../../businessRateLimit");
const User = require("../../models/User");
const Lead = require("../../models/Lead");
const Enquiry = require("../../models/Enquiry");
const Wishlist = require("../../models/Wishlist");
const { toSafeCustomer } = require("../../customerView");
const { withErrorHandling, requireObjectId, notFound, forbidden, badRequest, parseJsonBody } = require("../../validation");
const { sendSuccess } = require("../../apiResponse");

const INTERNAL_ROLES = ["MARKETING_AGENT", "MARKETING_MANAGER", "ADMIN"];

// Bounded, targeted queries only — no populate() of unbounded collections.
// A handful of small, indexed queries beats one big aggregation for a
// foundation-level Customer 360; can be revisited once real dashboard
// usage patterns are known.
async function buildCustomer360(user) {
    const [wishlist, recentLeads, recentEnquiries] = await Promise.all([
        Wishlist.findOne({ userId: user._id }).select("items"),
        Lead.find({ userId: user._id }).sort({ createdAt: -1 }).limit(10).select("status temperature score source createdAt assignedTo archivedAt"),
        Enquiry.find({ userId: user._id }).sort({ createdAt: -1 }).limit(10).select("status source property createdAt"),
    ]);

    return {
        ...toSafeCustomer(user),
        wishlist: { itemCount: wishlist ? wishlist.items.length : 0 },
        recentLeads,
        recentEnquiries,
    };
}

async function handleGet(req, res, id) {
    const identity = await requireRole(req, res, INTERNAL_ROLES);
    if (!identity) return;

    await connectToDatabase();
    const user = await User.findById(id);
    if (!user) throw notFound("Customer not found.");

    sendSuccess(res, await buildCustomer360(user));
}

async function handlePatch(req, res, id) {
    const identity = await requireRole(req, res, INTERNAL_ROLES);
    if (!identity) return;

    await connectToDatabase();
    const user = await User.findById(id);
    if (!user) throw notFound("Customer not found.");

    const body = parseJsonBody(req);

    // Explicit whitelist — never an update-operator passthrough. `role`
    // requires ADMIN specifically (privilege escalation risk); everything
    // else here is safe for any internal role to edit. `lead.*` (the
    // denormalized pipeline snapshot) and `accommodationJourney.*` are
    // intentionally NOT editable here — Lead fields are owned by the Lead
    // API, and accommodationJourney has its own dedicated lifecycle
    // endpoint (PATCH /api/customers/:id/lifecycle) with its own rules.
    if (typeof body.name === "string" && body.name.trim()) user.name = body.name.trim();
    if (body.phone !== undefined) user.phone = body.phone ? String(body.phone).trim() : null;

    if (body.profile && typeof body.profile === "object") {
        const p = body.profile;
        if (p.country !== undefined) user.profile.country = p.country;
        if (p.city !== undefined) user.profile.city = p.city;
        if (Array.isArray(p.preferredCountries)) user.profile.preferredCountries = p.preferredCountries;
        if (Array.isArray(p.preferredCities)) user.profile.preferredCities = p.preferredCities;
        if (p.otherPreferences && typeof p.otherPreferences === "object") user.profile.otherPreferences = p.otherPreferences;
    }

    if (body.marketing && typeof body.marketing === "object") {
        const m = body.marketing;
        if (m.source !== undefined) user.marketing.source = m.source;
        if (m.medium !== undefined) user.marketing.medium = m.medium;
        if (m.campaign !== undefined) user.marketing.campaign = m.campaign;
        if (typeof m.subscribed === "boolean") user.marketing.subscribed = m.subscribed;
        if (typeof m.consent === "boolean") {
            user.marketing.consent = m.consent;
            if (m.consent) user.marketing.consentAt = new Date();
        }
    }

    if (body.role !== undefined) {
        if (identity.mongoUser.role !== "ADMIN") {
            throw forbidden("Changing a customer's role requires the ADMIN role.");
        }
        const VALID_ROLES = ["USER", "MARKETING_AGENT", "MARKETING_MANAGER", "ADMIN"];
        if (!VALID_ROLES.includes(body.role)) {
            throw badRequest("INVALID_ENUM", `role must be one of: ${VALID_ROLES.join(", ")}.`);
        }
        user.role = body.role;
    }

    await user.save();
    sendSuccess(res, toSafeCustomer(user));
}

module.exports = withErrorHandling(async (req, res) => {
    const id = requireObjectId(req.query.id, "id");
    if (req.method === "GET") return handleGet(req, res, id);
    if (req.method === "PATCH") {
        await checkBusinessWriteRateLimit(req);
        return handlePatch(req, res, id);
    }
    res.status(405).json({ error: "Method not allowed" });
});
