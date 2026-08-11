// TEMPORARY local-development bypass for the /insight dashboard ONLY.
//
// Scope: imported by api/insights/overview.js and api/insights/market.js
// exclusively. This file does NOT touch api/_lib/businessAuth.js — every
// other internal endpoint (api/leads, api/customers, api/enquiries, ...)
// keeps calling requireRole() from businessAuth.js completely unchanged and
// still requires a real session + an internal Mongo role in every
// environment.
//
// Why this exists: there is no seeded admin account / MongoDB connection
// available in local dev yet, so the normal requireRole() check (which
// resolves a Mongo User to read its role) can never succeed locally. This
// bypass lets /insight be developed without standing up MongoDB first.
//
// Environment gating: process.env.NODE_ENV !== "production" is the same
// convention already used elsewhere in this codebase (see the `DEV` const
// in src/services/amberApi.js) — Vercel sets NODE_ENV=production for both
// Preview and Production deployments, so a real deployment always takes
// the requireRole() path below, never the bypass.
//
// TODO: Re-enable authentication/RBAC before production deployment — i.e.
// once a real admin account exists, delete this file and call
// requireRole(req, res, INTERNAL_ROLES) directly in both insights endpoints
// the same way api/leads/index.js and api/customers/index.js already do.
const { requireRole } = require("./businessAuth");

const INTERNAL_ROLES = ["MARKETING_AGENT", "MARKETING_MANAGER", "ADMIN"];
const IS_PRODUCTION = process.env.NODE_ENV === "production";

async function authorizeInsights(req, res) {
    if (!IS_PRODUCTION) {
        console.warn("[insights] RBAC bypassed (NODE_ENV !== production) — TEMPORARY dev-only access, see api/_lib/insightsDevAuth.js");
        return { bypassed: true };
    }
    return requireRole(req, res, INTERNAL_ROLES);
}

module.exports = { authorizeInsights, INTERNAL_ROLES };
