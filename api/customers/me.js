// GET /api/customers/me — the logged-in visitor's own business profile.
//
// Deliberately separate from GET /api/auth/me: that endpoint answers "who
// is logged in" from Redis (id/name/email/phone only — no MongoDB fields
// exist there at all). This endpoint answers "what's their business
// profile" from MongoDB — lifecycle, marketing source, role, etc. Reusing
// auth/me wouldn't work here since it has no access to any of those
// fields; this isn't duplication, it's a different data source for a
// different question. No normal USER can reach anyone else's profile this
// way — identity comes only from the session (api/_lib/businessAuth.js),
// never from a client-supplied id.
const { requireCustomerIdentity } = require("../_lib/businessAuth");
const { toSafeCustomer } = require("../_lib/customerView");
const { withErrorHandling } = require("../_lib/validation");
const { sendSuccess } = require("../_lib/apiResponse");

module.exports = withErrorHandling(async (req, res) => {
    if (req.method !== "GET") {
        res.status(405).json({ error: "Method not allowed" });
        return;
    }
    const identity = await requireCustomerIdentity(req, res);
    if (!identity) return;
    sendSuccess(res, toSafeCustomer(identity.mongoUser));
});
