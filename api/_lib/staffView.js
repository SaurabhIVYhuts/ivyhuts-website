// Projects a User document down to the assignable-identity fields the
// Lead assignment dropdown needs — deliberately narrower than
// customerView.js's toSafeCustomer (no phone, no marketing/profile data,
// no accommodationJourney). See src/types/staff.ts in ivyhuts-crm.
function toSafeStaff(user) {
    return {
        id: String(user._id),
        name: user.name,
        email: user.email,
        role: user.role,
    };
}

module.exports = { toSafeStaff };
