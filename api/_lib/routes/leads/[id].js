// GET    /api/leads/:id — detail + bounded related records, internal roles only.
// PATCH  /api/leads/:id — controlled business-field update, internal roles only.
// DELETE /api/leads/:id — soft delete (archive), ADMIN/MARKETING_MANAGER only.
const { connectToDatabase } = require("../../mongodb");
const { requireRole } = require("../../businessAuth");
const { checkBusinessWriteRateLimit } = require("../../businessRateLimit");
const Lead = require("../../models/Lead");
const Enquiry = require("../../models/Enquiry");
const FollowUp = require("../../models/FollowUp");
const Communication = require("../../models/Communication");
const Meeting = require("../../models/Meeting");
const Discovery = require("../../models/Discovery");
const AccommodationCuration = require("../../models/AccommodationCuration");
const Presentation = require("../../models/Presentation");
const { toSafeLead } = require("../../leadView");
const { recordEvent } = require("../../events");
const { withErrorHandling, requireObjectId, notFound, badRequest, parseEnumParam, parseNumberParam, parseJsonBody } = require("../../validation");
const { sendSuccess } = require("../../apiResponse");
const { withCors } = require("../../cors");

const INTERNAL_ROLES = ["MARKETING_AGENT", "MARKETING_MANAGER", "ADMIN"];
const DELETE_ROLES = ["MARKETING_MANAGER", "ADMIN"];
// Kept in sync with api/_lib/models/Lead.js's LEAD_STATUSES (Milestone 22).
const LEAD_STATUSES = ["new", "contacted", "qualified", "nurturing", "converted", "lost"];
const LEAD_TEMPERATURES = ["cold", "warm", "hot"];

// Fields a PATCH may never touch, even if present in the body — internal
// audit fields, generated ids, and anything owned by a different endpoint
// (assignment has its own dedicated route with its own validation).
const IMMUTABLE_FIELDS = new Set(["_id", "id", "createdAt", "updatedAt", "assignedTo", "userId"]);

// Milestone 23.11 — every flag below is derived from a REAL persisted
// record, never fabricated. Each rule is deliberately stricter than "does
// a related record exist at all" wherever that distinction matters (Part
// 8's own warning: activity happened != the stage is complete):
//   - hasCompletedMeeting requires status==="completed", not merely
//     "a meeting was scheduled" — a still-upcoming meeting hasn't happened.
//   - hasConfirmedRequirements requires university + budget + currency +
//     an EXPLICIT numeric sharing value on Discovery — deliberately NOT
//     the looser "derived from roomPreference text" fallback the CRM's own
//     deriveFindRoomsRequirements() uses to unlock Find Rooms (that
//     fallback exists specifically to show a "please confirm" nudge, i.e.
//     it is NOT itself confirmed — see src/lib/findRooms/requirements.ts).
//     A lead can therefore be "ready for Find Rooms" (client-side gate)
//     before this journey stage reads complete — that's intentional, not
//     a bug: this stage means genuinely confirmed, not merely usable.
//   - hasCuratedProperties requires an AccommodationCuration with at least
//     one property, not merely a saved-but-empty shortlist.
//   - hasReadyPresentation requires a Presentation with status==="READY" —
//     GENERATING/FAILED never count, and existence alone is never treated
//     as "the customer received it" (this repo has no send-confirmation
//     event for a presentation at all, so the stage stops at "generated").
//   - "Rooms searched" has NO independent persisted evidence anywhere:
//     GET /api/properties/search is a stateless, unlogged orchestration
//     query (see api/properties/search.js) — nothing records that a
//     search happened. Rather than fabricate that signal, this journey
//     collapses "searched" and "curated" into hasCuratedProperties, which
//     IS real evidence (an agent can only reach Save Shortlist by having
//     gone through Find Rooms first).
//   - hasPendingTranscriptReview (Milestone 23.15) — mirrors the SAME rule
//     api/leads/work-queue.js's aggregation already uses for its
//     transcriptAvailableNeedsReview bucket (any meeting on this lead with
//     extractedRequirements.status === "pending_review"), just computed
//     per-lead instead of via $lookup. Before this, a Lead Detail page's
//     own Sales Journey/Next Action had no way to know a transcript
//     suggestion was sitting there — an agent had to scroll all the way to
//     Discovery to discover it, even though the Work Queue list one click
//     away already flagged it as the single highest-priority action for
//     that lead. This closes that handoff gap without inventing a second
//     "needs review" concept: same field, same meaning, two read paths.
function buildJourneyFlags({ lead, meetings, discovery, curation, presentations, followUps, hasOutboundCommunication }) {
    const hasConfirmedRequirements = Boolean(
        discovery &&
            discovery.student &&
            discovery.student.university &&
            discovery.accommodation &&
            (discovery.accommodation.budgetMin != null || discovery.accommodation.budgetMax != null) &&
            discovery.accommodation.currency &&
            discovery.accommodation.sharing != null &&
            discovery.accommodation.sharing > 0
    );

    return {
        hasAssignment: Boolean(lead.assignedTo),
        hasOutboundCommunication,
        hasCompletedMeeting: meetings.some((m) => m.status === "completed"),
        hasConfirmedRequirements,
        hasCuratedProperties: Boolean(curation && Array.isArray(curation.properties) && curation.properties.length > 0),
        hasReadyPresentation: presentations.some((p) => p.status === "READY"),
        hasAnyFollowUp: followUps.length > 0,
        hasPendingFollowUp: followUps.some((f) => f.status === "pending"),
        hasPendingTranscriptReview: meetings.some((m) => m.extractedRequirements && m.extractedRequirements.status === "pending_review"),
    };
}

async function buildLeadDetail(lead) {
    const [enquiries, followUps, communications, hasOutboundCommunication, meetings, discovery, curation, presentations] = await Promise.all([
        Enquiry.find({ leadId: lead._id }).sort({ createdAt: -1 }).limit(10).select("status source property contact createdAt"),
        // Unbounded (a lead realistically has a handful of follow-ups, never
        // thousands) — journey/completion flags need the FULL set, not just
        // the 10 most recent, or hasPendingFollowUp could read wrong.
        FollowUp.find({ leadId: lead._id }).sort({ dueAt: 1 }).select("type priority dueAt status notes"),
        Communication.find({ leadId: lead._id }).sort({ createdAt: -1 }).limit(10).select("channel direction type status createdAt"),
        // A separate, unbounded existence check — a heavily-communicated
        // lead's single outbound message could easily fall outside the 10
        // most recent (all-inbound) shown above; the journey flag must
        // still see it (same "full collection, not just the recent window"
        // rule the original CRM design called for).
        Communication.exists({ leadId: lead._id, direction: "outbound" }).then(Boolean),
        // extractedRequirements.status included (not just "status") — see
        // hasPendingTranscriptReview above; the rest of that subdocument is
        // deliberately not selected here, this projection is journey-flag
        // input only, not the actual Meeting section's data source.
        Meeting.find({ leadId: lead._id }).select("status extractedRequirements.status"),
        Discovery.findOne({ leadId: lead._id }).select("student.university accommodation.budgetMin accommodation.budgetMax accommodation.currency accommodation.sharing"),
        AccommodationCuration.findOne({ leadId: lead._id }).select("properties"),
        Presentation.find({ leadId: lead._id }).select("status"),
    ]);

    // lastInboundCommunicationAt — computed for free from the same
    // already-fetched, already-sorted (createdAt desc) `communications`
    // list: its first element IS the most recent communication. Never
    // persisted separately (Milestone 23.9/23.11: "one authoritative source
    // of truth") — this is that source, recomputed fresh on every GET.
    const lastInboundCommunicationAt = communications[0] && communications[0].direction === "inbound" ? communications[0].createdAt : null;

    const journey = buildJourneyFlags({ lead, meetings, discovery, curation, presentations, followUps, hasOutboundCommunication });

    return { ...toSafeLead(lead), enquiries, followUps, communications, lastInboundCommunicationAt, journey };
}

async function handleGet(req, res, id) {
    const identity = await requireRole(req, res, INTERNAL_ROLES);
    if (!identity) return;
    await connectToDatabase();
    const lead = await Lead.findById(id);
    if (!lead) throw notFound("Lead not found.");
    sendSuccess(res, await buildLeadDetail(lead));
}

async function handlePatch(req, res, id) {
    const identity = await requireRole(req, res, INTERNAL_ROLES);
    if (!identity) return;
    await connectToDatabase();
    const lead = await Lead.findById(id);
    if (!lead) throw notFound("Lead not found.");

    const body = parseJsonBody(req);
    const attemptedImmutable = Object.keys(body).filter((k) => IMMUTABLE_FIELDS.has(k));
    if (attemptedImmutable.length) {
        throw badRequest("VALIDATION_ERROR", `These fields cannot be updated here: ${attemptedImmutable.join(", ")}.`);
    }

    const previousStatus = lead.status;

    if (body.status !== undefined) lead.status = parseEnumParam(body.status, LEAD_STATUSES, "status");
    if (body.temperature !== undefined) lead.temperature = parseEnumParam(body.temperature, LEAD_TEMPERATURES, "temperature");
    if (body.source !== undefined) lead.source = body.source;
    if (body.sourceDetails !== undefined && typeof body.sourceDetails === "object") lead.sourceDetails = body.sourceDetails;
    if (body.notes !== undefined) lead.notes = body.notes;
    if (Array.isArray(body.tags)) lead.tags = body.tags.map(String);
    if (body.score !== undefined) lead.score = parseNumberParam(body.score, "score");
    if (body.lostReason !== undefined) lead.lostReason = body.lostReason;

    if (body.contact && typeof body.contact === "object") {
        if (body.contact.name !== undefined) lead.contact.name = body.contact.name;
        if (body.contact.email !== undefined) lead.contact.email = body.contact.email;
        if (body.contact.phone !== undefined) lead.contact.phone = body.contact.phone;
    }
    if (body.property && typeof body.property === "object") {
        if (body.property.id !== undefined) lead.property.id = body.property.id;
        if (body.property.name !== undefined) lead.property.name = body.property.name;
        if (body.property.city !== undefined) lead.property.city = body.property.city;
    }

    if (body.status === "converted" && previousStatus !== "converted") lead.convertedAt = new Date();
    if (body.status === "lost" && previousStatus !== "lost") lead.lostAt = new Date();
    lead.lastContactAt = new Date();

    await lead.save();

    if (body.status !== undefined && lead.status !== previousStatus) {
        await recordEvent({
            userId: lead.userId,
            event: "LEAD_STATUS_CHANGED",
            properties: { leadId: String(lead._id), from: previousStatus, to: lead.status },
            metadata: { changedBy: String(identity.mongoUser._id), changedByRole: identity.mongoUser.role },
        });
    }

    sendSuccess(res, toSafeLead(lead));
}

async function handleDelete(req, res, id) {
    const identity = await requireRole(req, res, DELETE_ROLES);
    if (!identity) return;
    await connectToDatabase();
    const lead = await Lead.findById(id);
    if (!lead) throw notFound("Lead not found.");

    lead.archivedAt = new Date();
    await lead.save();

    sendSuccess(res, toSafeLead(lead));
}

module.exports = withErrorHandling(async (req, res) => {
    if (withCors(req, res)) return; // preflight handled

    const id = requireObjectId(req.query.id, "id");
    if (req.method === "GET") return handleGet(req, res, id);
    if (req.method === "PATCH") {
        await checkBusinessWriteRateLimit(req);
        return handlePatch(req, res, id);
    }
    if (req.method === "DELETE") {
        await checkBusinessWriteRateLimit(req);
        return handleDelete(req, res, id);
    }
    res.status(405).json({ error: "Method not allowed" });
});
