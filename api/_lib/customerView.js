// Shared "MongoDB User document -> safe API response" projection, used by
// every customer endpoint so the shape stays consistent in one place.
// Never includes passwordHash (doesn't exist on this model anyway — see
// api/_lib/models/User.js's header comment) or any Redis-side session data.
function toSafeCustomer(user) {
    return {
        id: user._id,
        email: user.email,
        name: user.name,
        phone: user.phone,
        role: user.role,
        profile: user.profile,
        marketing: user.marketing,
        lead: user.lead,
        accommodationJourney: user.accommodationJourney,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        lastLoginAt: user.auth ? user.auth.lastLoginAt : null,
    };
}

module.exports = { toSafeCustomer };
