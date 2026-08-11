// TEMPORARY bypass for the /insight dashboard. For now, /api/insights/*
// is accessible without internal role checks in all environments.
//
// This is intentionally temporary: remove the bypass once a real internal
// account and access control model are in place.
const INTERNAL_ROLES = ["MARKETING_AGENT", "MARKETING_MANAGER", "ADMIN"];

async function authorizeInsights(req, res) {
    console.warn("[insights] RBAC bypassed for /api/insights/* — temporary unrestricted access.");
    return { bypassed: true };
}

module.exports = { authorizeInsights, INTERNAL_ROLES };
