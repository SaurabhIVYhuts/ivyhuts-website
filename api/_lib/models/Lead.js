// The business relationship/opportunity — deliberately separate from User.
// A Lead is NOT a copy of the User document; it tracks sales-pipeline state
// over time, and unlike a User it doesn't require an account: an anonymous
// enquiry becomes a Lead with userId = null. If that same person later
// creates an account, userId can be attached to the existing Lead (a later
// milestone's job — no identity stitching happens here).
const mongoose = require("mongoose");
const { Schema } = mongoose;

// "nurturing" added in Milestone 22 to match the CRM's existing
// LEAD_STATUSES (src/types/lead.ts in ivyhuts-crm) — a lead not ready to
// convert now but still a real prospect, distinct from "lost". This is the
// single canonical definition; api/leads/index.js, api/leads/[id].js, and
// User.js's denormalized lead.status all duplicate this exact array and
// must be kept in sync if it ever changes again.
const LEAD_STATUSES = ["new", "contacted", "qualified", "nurturing", "converted", "lost"];
const LEAD_TEMPERATURES = ["cold", "warm", "hot"];

const LeadSchema = new Schema(
    {
        userId: { type: Schema.Types.ObjectId, ref: "User", default: null },
        status: { type: String, enum: LEAD_STATUSES, default: "new" },
        temperature: { type: String, enum: LEAD_TEMPERATURES, default: "cold" },
        score: { type: Number, default: 0 },
        source: { type: String, default: null }, // e.g. "find-rooms-form", "contact-form", "signup", "facebook_lead_ads"
        // Milestone 23.10 — the id Meta (or any future external lead
        // source) assigns to a single lead submission, e.g. Meta's
        // `leadgen_id`. This is the ONLY dedup key for external intake; do
        // not add a second one (see api/leads/meta/webhook.js). The unique
        // index is declared below with the rest of this schema's indexes.
        externalLeadId: { type: String, default: null },
        // Free-form details about the source, including campaign attribution
        // (e.g. { campaign: "spring-2026" }) — no dedicated `campaign` field
        // was added since this Mixed bag already covers it without schema churn.
        sourceDetails: { type: Schema.Types.Mixed, default: {} },
        assignedTo: { type: String, default: null }, // stringified User._id of the assigned internal staff member
        firstContactAt: { type: Date, default: null },
        lastContactAt: { type: Date, default: null },
        convertedAt: { type: Date, default: null },
        lostAt: { type: Date, default: null },
        lostReason: { type: String, default: null },
        tags: { type: [String], default: [] },
        notes: { type: String, default: null },

        // Added in Milestone 2 — gap found while building lead creation: a
        // Lead can exist with no userId at all (anonymous), and without its
        // own contact details a Lead with no account would be unreachable.
        // Not `required` at the schema level (a staff-created Lead tied to
        // an existing userId doesn't need it duplicated here) — the API
        // layer enforces "userId OR contact.email must be present" instead.
        contact: {
            name: { type: String, default: null },
            email: { type: String, default: null, lowercase: true, trim: true },
            phone: { type: String, default: null },
        },

        // Added in Milestone 2 — same reasoning as Enquiry.property: an
        // opaque snapshot of whatever property/destination this lead is
        // about, never authoritative and never fetched from Amber.
        property: {
            id: { type: String, default: null },
            name: { type: String, default: null },
            city: { type: String, default: null },
        },

        // Added in Milestone 2 for the lead deletion endpoint — soft-delete
        // only (see api/leads/[id].js): marketing data should not disappear
        // accidentally, so DELETE sets this instead of removing the
        // document. null = active; a Date = archived at that time.
        archivedAt: { type: Date, default: null },
    },
    { timestamps: true }
);

// userId: query pattern = "all leads for this user" (once accounts exist).
LeadSchema.index({ userId: 1 });
// status: query pattern = pipeline board filtering ("show me all 'qualified' leads").
LeadSchema.index({ status: 1 });
// assignedTo: query pattern = "my assigned leads" for a given sales agent.
LeadSchema.index({ assignedTo: 1 });
// score: query pattern = sorting by priority.
LeadSchema.index({ score: -1 });
// createdAt: query pattern = new-leads-over-time reporting.
LeadSchema.index({ createdAt: -1 });
// source: query pattern = "which channel generates the most leads".
LeadSchema.index({ source: 1 });
// contact.email: query pattern = dedupe/lookup an anonymous lead by email
// (find-or-create on repeat enquiries — see api/_lib/leadLinking.js).
LeadSchema.index({ "contact.email": 1 });
// property.city: query pattern = "leads interested in city X" (dashboard filter).
LeadSchema.index({ "property.city": 1 });
// archivedAt: query pattern = every list query excludes archived leads by
// default (see api/leads/index.js) — this is that filter's index.
LeadSchema.index({ archivedAt: 1 });
// externalLeadId: query pattern = dedup lookup on every webhook delivery
// (api/leads/meta/webhook.js). `sparse` so the uniqueness constraint only
// applies to documents where this is actually set — every existing/
// non-external Lead keeps `null` here with no conflict between them.
LeadSchema.index({ externalLeadId: 1 }, { unique: true, sparse: true });

module.exports = mongoose.models.Lead || mongoose.model("Lead", LeadSchema);
