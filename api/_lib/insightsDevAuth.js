// RBAC gate for the /insight dashboard's data endpoints (api/insights/market.js,
// overview.js, snapshot.js, snapshot-dates.js).
//
// Milestone 22: this used to unconditionally bypass authorization (see git
// history) despite every calling file's own comments already claiming
// "internal roles only in production" — that claim was false; the bypass
// had no environment gate at all. The real internal-account/role model
// (api/_lib/businessAuth.js's requireRole, already used by every other
// business endpoint under api/leads/*, api/customers/*, api/enquiries/*)
// has been in place since Milestone 2, which was exactly the precondition
// this file's own previous comment named for removing the bypass. This
// wrapper exists only so the 4 call sites don't need their own import of
// businessAuth — it is not a second authorization system.
const { requireRole } = require("./businessAuth");

const INTERNAL_ROLES = ["MARKETING_AGENT", "MARKETING_MANAGER", "ADMIN"];

// 401 if not logged in, 403 if logged in but not an internal role — same
// semantics as every other requireRole call site. Returns null in both
// cases (response already sent); callers must check and stop on null.
async function authorizeInsights(req, res) {
    return requireRole(req, res, INTERNAL_ROLES);
}

module.exports = { authorizeInsights, INTERNAL_ROLES };
