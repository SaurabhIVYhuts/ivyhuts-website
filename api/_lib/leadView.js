// Shared "Lead document -> API response" projection — Lead has no secrets
// to strip (unlike User), this just normalizes _id -> id and drops the
// internal __v version key for a consistent response shape.
function toSafeLead(lead) {
    const obj = lead.toObject ? lead.toObject() : lead;
    const { _id, __v, ...rest } = obj;
    return { id: _id, ...rest };
}

// The internal-staff role set every lead-scoped route in this repo gates on
// (api/leads/index.js, api/leads/[id].js, work-queue.js, and the lead
// sub-resource routes all declare this same array by convention — kept in
// sync deliberately). Re-exported here so a caller that only needs the
// visibility check doesn't have to hard-code the list a second time.
const INTERNAL_ROLES = ["MARKETING_AGENT", "MARKETING_MANAGER", "ADMIN"];

// Single shared "can this actor see this lead" check, extracted (Ivy
// Assistant, Phase 1) so every lead-scoped READ path enforces identical
// visibility — the GET /api/leads/:id detail route AND the read-only
// assistant tools that inherit its rules.
//
// This mirrors exactly what api/leads/[id].js's handleGet gates on today:
// an internal role is required, and the CRM's own list/detail routes apply
// NO further per-assignment narrowing beyond that (a MARKETING_AGENT can
// open any lead's detail page, not only their assigned ones — verified
// against handleList/handleGet before extracting this). Kept as its own
// function purely so that if a per-assignment rule is ever added, it
// changes in one place and every caller inherits it.
function canActorSeeLead(actor, lead) {
    if (!actor || !lead) return false;
    return INTERNAL_ROLES.includes(actor.role);
}

module.exports = { toSafeLead, INTERNAL_ROLES, canActorSeeLead };
