// Identity + authorization bridge for the Milestone 2 business API.
//
// GAP THIS FILE EXISTS TO CLOSE: authentication identity (Redis, from the
// previous milestone) and business/customer data (MongoDB, from Milestone
// 1) are two separate stores with two separate id spaces — a Redis
// `user:{userId}` record has no MongoDB counterpart today, because the
// formal Redis->MongoDB migration described in
// docs/marketing-data-architecture.md §10 hasn't happened yet (deliberately
// — it's a later milestone). But this milestone needs a real MongoDB
// User._id to attach leads/enquiries/roles to for a logged-in visitor
// *right now*. `resolveMongoUser` is a minimal, additive bridge: look up a
// MongoDB User by the same normalized email Redis already uses, and
// lazily create one if it doesn't exist yet. This is NOT the migration —
// it never touches Redis, never moves passwordHash/session data anywhere,
// and is fully compatible with that migration happening properly later
// (see the doc's dual-write/backfill plan; this is effectively the
// "dual-write on read" half of it, scoped to what this milestone needs).
//
// role (business authorization) lives on the MongoDB User document, per
// the Milestone 2 spec — Redis remains the sole source of truth for
// password/session data and is not modified by this file.
const { requireAuth, getCurrentUser } = require("./auth");
const { connectToDatabase } = require("./mongodb");
const { RedisUnavailableError } = require("./sharedStore");
const User = require("./models/User");
const { forbidden } = require("./validation");

async function resolveMongoUser(redisUser) {
    await connectToDatabase();
    const email = String(redisUser.email || "").trim().toLowerCase();
    let mongoUser = await User.findOne({ email });
    if (!mongoUser) {
        // `User.phone` is required (see models/User.js) for every NEW
        // signup, enforced by api/auth/signup.js. But a Redis user who
        // signed up before phone became mandatory (or via any path that
        // predates/bypasses that validation) has no phone to give here —
        // and there is no self-service "add your phone" flow for them to
        // fix that. Previously this lazy bridge-create ran full schema
        // validation regardless, so that account got a hard 400 on every
        // single business-data action (wishlist, customer profile, lead
        // creation, ...) forever, with no way to recover — found by
        // reproducing the reported "wishlist heart reverts to white /
        // /wishlist stays empty" bug against a real account in that state.
        // Skipping validation ONLY when phone is genuinely absent lets this
        // one-time bridge-create succeed for that legacy account (matching
        // the User.phone schema comment's own intent: required is enforced
        // going forward, not retroactively) while every other creation path
        // (signup, staff import) still fully validates as before.
        mongoUser = new User({
            email,
            name: redisUser.name,
            phone: redisUser.phone || null,
            marketing: { source: "signup" },
        });
        await mongoUser.save({ validateBeforeSave: Boolean(redisUser.phone) });
    }
    return mongoUser;
}

// 401 if not logged in (via the existing Redis session — never trusts a
// client-supplied userId). Returns { redisUser, mongoUser } otherwise.
async function requireCustomerIdentity(req, res) {
    const redisUser = await requireAuth(req, res);
    if (!redisUser) return null; // requireAuth already sent 401/503
    const mongoUser = await resolveMongoUser(redisUser);
    return { redisUser, mongoUser };
}

// 401 if not logged in, 403 if logged in but role isn't allowed. This is
// the gate every internal business endpoint (GET /api/leads,
// GET /api/customers, assignment, etc.) uses.
async function requireRole(req, res, allowedRoles) {
    const identity = await requireCustomerIdentity(req, res);
    if (!identity) return null;
    if (!allowedRoles.includes(identity.mongoUser.role)) {
        throw forbidden(`This action requires one of the following roles: ${allowedRoles.join(", ")}.`);
    }
    return identity;
}

// For endpoints where anonymous access is explicitly valid (lead/enquiry
// creation) but a logged-in visitor's identity should still be attached
// when present. Never writes an error response — anonymous is a normal,
// successful outcome here, not a failure. If Redis is flaky, this
// deliberately degrades to "treat as anonymous" rather than failing an
// otherwise-fine anonymous submission — losing the userId link is a much
// smaller problem than blocking a lead/enquiry from being recorded at all.
async function getOptionalMongoUserId(req) {
    let redisUser;
    try {
        redisUser = await getCurrentUser(req);
    } catch (err) {
        if (err instanceof RedisUnavailableError) {
            console.error("[business-api] Redis unavailable while resolving optional identity — treating as anonymous:", err.message);
            return null;
        }
        throw err;
    }
    if (!redisUser) return null;
    const mongoUser = await resolveMongoUser(redisUser);
    return mongoUser._id;
}

module.exports = { resolveMongoUser, requireCustomerIdentity, requireRole, getOptionalMongoUserId };
