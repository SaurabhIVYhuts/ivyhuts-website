// GET /api/leads/work-queue — internal roles only. Drives the Dashboard's
// "My Work" tiles (summary) and the Lead Inbox's prioritized table (leads)
// from one request — see src/types/workQueue.ts in ivyhuts-crm, whose
// contract this route was built against (already precisely specified
// there, including the exact WorkQueueLead $project field list, before
// this route existed).
//
// Bucket semantics (not specified anywhere else, so decided and recorded
// here — mutually exclusive per lead, priority order matches
// WORK_QUEUE_BUCKETS in the CRM type). Milestone 23.12 extends the
// original 6 buckets with 4 new operational-pipeline signals (meetingToday
// / discoveryIncomplete / readyForFindRooms / presentationNoFollowUp);
// Milestone 23.14 adds one more (transcriptAvailableNeedsReview) — every
// addition reuses the SAME aggregation this route already runs rather than
// a second/parallel queue system:
//   overdue              — has a PENDING follow-up due before today
//   meetingToday         — has a SCHEDULED (not completed/cancelled)
//                           meeting whose scheduledAt falls today
//   today                — has a PENDING follow-up due today
//   new                  — status "new"
//   transcriptAvailableNeedsReview — Milestone 23.14: at least one meeting
//                           on this lead has extractedRequirements with
//                           status "pending_review" (an AI extraction ran
//                           against a real pasted transcript and hasn't yet
//                           been confirmed/dismissed by the agent). Ranked
//                           above discoveryIncomplete deliberately — a
//                           ready-to-review suggestion is a faster, more
//                           concrete action than starting Discovery from
//                           nothing, even though both ultimately serve the
//                           same "requirements aren't confirmed yet" goal.
//                           No new prioritization engine — this reuses the
//                           exact same $switch/bucket mechanism as every
//                           other row here.
//   discoveryIncomplete  — status is contacted/qualified/nurturing (i.e.
//                           NOT "new" — that already won a higher bucket)
//                           and Discovery does not yet have EXPLICIT
//                           university+budget+currency+sharing confirmed.
//                           Deliberately the same strict bar as
//                           hasConfirmedRequirements in api/leads/[id].js's
//                           buildJourneyFlags (Milestone 23.11) — a
//                           roomPreference-derived guess does NOT count as
//                           confirmed here either.
//   readyForFindRooms    — requirements ARE confirmed, but no
//                           AccommodationCuration with at least one
//                           property exists yet (an empty/never-saved
//                           shortlist counts as "not ready", matching
//                           hasCuratedProperties' own rule)
//   presentationNoFollowUp — a READY Presentation exists, but this lead has
//                           NO FollowUp at all (never recorded one) — a
//                           generated PPT is not the same as the customer
//                           having been followed up with (Milestone 23.12
//                           Part 8: "A generated PPT != delivered PPT")
//   upcoming             — has a PENDING follow-up due after today (and
//                          didn't already match a higher bucket)
//   nurturing            — status "nurturing" (and didn't match a higher bucket)
//   noNextAction         — everything else (the catch-all)
// `summary` always reflects the full scope (status/source/assignedTo/
// search filters applied, bucket NOT applied) — `leads` additionally
// applies the `bucket` filter. This is why the aggregation runs twice
// (BASE_STAGES shared, PAGINATED_STAGES vs SUMMARY_STAGES diverge only
// after that point) rather than once.
//
// Lead.score is deliberately NOT used anywhere in this file — inspected
// before writing this (Milestone 23.12 Part 5): it is a plain,
// manually-PATCHable number with no automatic derivation anywhere in this
// codebase, so it is not a reliable prioritization signal. Inventing a
// scoring algorithm here was explicitly ruled out.
//
// lastInboundCommunicationAt (CRM Milestone 16's "Customer Replied"
// signal) is computed here from Communication.direction — no such
// precomputed/maintained field exists on Lead itself (confirmed absent by
// direct grep before writing this route); this is the first real
// implementation of it, scoped to this endpoint's own response only.
const { connectToDatabase } = require("../../mongodb");
const { requireRole } = require("../../businessAuth");
const { withCors } = require("../../cors");
const Lead = require("../../models/Lead");
const { withErrorHandling, escapeRegex, parseEnumParam } = require("../../validation");
const { sendSuccess } = require("../../apiResponse");

const INTERNAL_ROLES = ["MARKETING_AGENT", "MARKETING_MANAGER", "ADMIN"];
const LEAD_STATUSES = ["new", "contacted", "qualified", "nurturing", "converted", "lost"];
const WORK_QUEUE_BUCKETS = [
    "overdue",
    "meetingToday",
    "today",
    "new",
    "transcriptAvailableNeedsReview",
    "discoveryIncomplete",
    "readyForFindRooms",
    "presentationNoFollowUp",
    "upcoming",
    "nurturing",
    "noNextAction",
];
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

function startOfDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function buildBaseMatch(query) {
    const match = { archivedAt: null };
    if (query.search) {
        const pattern = new RegExp(escapeRegex(query.search.trim()), "i");
        match.$or = [{ "contact.name": pattern }, { "contact.email": pattern }];
    }
    const status = parseEnumParam(query.status, LEAD_STATUSES, "status");
    if (status) match.status = status;
    if (query.source) match.source = query.source;
    if (query.assignedTo) match.assignedTo = query.assignedTo === "unassigned" ? null : query.assignedTo;
    return match;
}

// Shared stages: attach nextFollowUp (earliest pending), nextMeeting
// (earliest scheduled), lastCommunication (most recent, any direction),
// pipeline-completion signals (Discovery/AccommodationCuration/Presentation
// — Milestone 23.12), and the computed `bucket` — used by both the summary
// and paginated legs so the two can never disagree about what bucket a
// given lead falls in.
function buildEnrichmentStages(todayStart, tomorrowStart) {
    return [
        {
            $lookup: {
                from: "followups",
                let: { leadId: "$_id" },
                pipeline: [
                    { $match: { $expr: { $and: [{ $eq: ["$leadId", "$$leadId"] }, { $eq: ["$status", "pending"] }] } } },
                    { $sort: { dueAt: 1 } },
                    { $limit: 1 },
                    { $project: { _id: 1, type: 1, priority: 1, dueAt: 1 } },
                ],
                as: "_nextFollowUpArr",
            },
        },
        { $addFields: { nextFollowUp: { $arrayElemAt: ["$_nextFollowUpArr", 0] } } },
        // Milestone 23.12 — has this lead EVER had any follow-up at all
        // (any status), distinct from `nextFollowUp` (pending, earliest
        // only) — needed for the presentationNoFollowUp bucket ("no
        // recorded follow-up" means none ever, not just none pending).
        {
            $lookup: {
                from: "followups",
                let: { leadId: "$_id" },
                pipeline: [{ $match: { $expr: { $eq: ["$leadId", "$$leadId"] } } }, { $limit: 1 }, { $project: { _id: 1 } }],
                as: "_anyFollowUpArr",
            },
        },
        { $addFields: { _hasAnyFollowUp: { $gt: [{ $size: "$_anyFollowUpArr" }, 0] } } },
        {
            $lookup: {
                from: "communications",
                let: { leadId: "$_id" },
                pipeline: [
                    { $match: { $expr: { $eq: ["$leadId", "$$leadId"] } } },
                    { $sort: { createdAt: -1 } },
                    { $limit: 1 },
                    { $project: { _id: 0, direction: 1, createdAt: 1 } },
                ],
                as: "_lastCommunicationArr",
            },
        },
        { $addFields: { _lastCommunication: { $arrayElemAt: ["$_lastCommunicationArr", 0] } } },
        {
            $addFields: {
                lastInboundCommunicationAt: {
                    $cond: [{ $eq: ["$_lastCommunication.direction", "inbound"] }, "$_lastCommunication.createdAt", null],
                },
            },
        },
        // Milestone 23.13 — found via end-to-end integration testing (never
        // caught by any single-feature test): Lead.status is a manually-set
        // field an agent must explicitly change, and nothing in this
        // codebase ever auto-advances it. A lead that's been fully worked
        // (contacted, met, curated, presented, followed up) but whose
        // status an agent simply never bothered to flip from "new" was
        // bucketing as "new" forever — permanently hiding a fully-handled
        // lead behind the wrong priority tile. The fix is NOT to
        // auto-mutate status (every other write in this system is
        // explicit, deliberate agent action, and this shouldn't be the one
        // silent exception) — it's to require genuinely NO outbound contact
        // yet before "new" wins, matching what "new" is actually supposed
        // to mean ("nobody has reached out"), using evidence this
        // aggregation already computes.
        {
            $lookup: {
                from: "communications",
                let: { leadId: "$_id" },
                pipeline: [{ $match: { $expr: { $and: [{ $eq: ["$leadId", "$$leadId"] }, { $eq: ["$direction", "outbound"] }] } } }, { $limit: 1 }, { $project: { _id: 1 } }],
                as: "_outboundCommunicationArr",
            },
        },
        { $addFields: { _hasOutboundCommunication: { $gt: [{ $size: "$_outboundCommunicationArr" }, 0] } } },
        // Milestone 23.12 — earliest still-SCHEDULED meeting (never
        // completed/cancelled ones — those aren't "happening").
        {
            $lookup: {
                from: "meetings",
                let: { leadId: "$_id" },
                pipeline: [
                    { $match: { $expr: { $and: [{ $eq: ["$leadId", "$$leadId"] }, { $eq: ["$status", "scheduled"] }] } } },
                    { $sort: { scheduledAt: 1 } },
                    { $limit: 1 },
                    { $project: { _id: 1, scheduledAt: 1 } },
                ],
                as: "_nextMeetingArr",
            },
        },
        { $addFields: { nextMeeting: { $arrayElemAt: ["$_nextMeetingArr", 0] } } },
        // Milestone 23.14 — does ANY meeting on this lead have an extraction
        // still awaiting agent review? Deliberately "any meeting", not just
        // the next/latest one — an older meeting's suggestion is still a
        // real pending action until an agent reviews or a newer extraction
        // supersedes it.
        {
            $lookup: {
                from: "meetings",
                let: { leadId: "$_id" },
                pipeline: [
                    { $match: { $expr: { $and: [{ $eq: ["$leadId", "$$leadId"] }, { $eq: ["$extractedRequirements.status", "pending_review"] }] } } },
                    { $limit: 1 },
                    { $project: { _id: 1 } },
                ],
                as: "_pendingTranscriptReviewArr",
            },
        },
        { $addFields: { _hasPendingTranscriptReview: { $gt: [{ $size: "$_pendingTranscriptReviewArr" }, 0] } } },
        // Milestone 23.12 — requirements-confirmed check, mirroring
        // api/leads/[id].js's buildJourneyFlags EXACTLY (same strict bar:
        // explicit numeric sharing, never the roomPreference-derived
        // fallback). Kept as its own small lookup rather than importing
        // that route's function, since this is a Mongo pipeline stage, not
        // reusable JS — the RULE is what's kept identical, documented in
        // both places.
        {
            $lookup: {
                from: "discoveries",
                let: { leadId: "$_id" },
                pipeline: [
                    { $match: { $expr: { $eq: ["$leadId", "$$leadId"] } } },
                    { $limit: 1 },
                    {
                        $project: {
                            _id: 0,
                            hasConfirmedRequirements: {
                                $and: [
                                    { $ne: ["$student.university", null] },
                                    { $ne: ["$student.university", ""] },
                                    { $or: [{ $ne: ["$accommodation.budgetMin", null] }, { $ne: ["$accommodation.budgetMax", null] }] },
                                    { $ne: ["$accommodation.currency", null] },
                                    { $ne: ["$accommodation.sharing", null] },
                                    { $gt: ["$accommodation.sharing", 0] },
                                ],
                            },
                        },
                    },
                ],
                as: "_discoveryArr",
            },
        },
        { $addFields: { hasConfirmedRequirements: { $ifNull: [{ $arrayElemAt: ["$_discoveryArr.hasConfirmedRequirements", 0] }, false] } } },
        // Milestone 23.12 — a non-empty curated shortlist (same rule as
        // hasCuratedProperties in buildJourneyFlags).
        {
            $lookup: {
                from: "accommodationcurations",
                let: { leadId: "$_id" },
                pipeline: [
                    { $match: { $expr: { $eq: ["$leadId", "$$leadId"] } } },
                    { $limit: 1 },
                    { $project: { _id: 0, hasProperties: { $gt: [{ $size: { $ifNull: ["$properties", []] } }, 0] } } },
                ],
                as: "_curationArr",
            },
        },
        { $addFields: { hasCuratedProperties: { $ifNull: [{ $arrayElemAt: ["$_curationArr.hasProperties", 0] }, false] } } },
        // Milestone 23.12 — at least one READY (never GENERATING/FAILED)
        // presentation exists (same rule as hasReadyPresentation).
        {
            $lookup: {
                from: "presentations",
                let: { leadId: "$_id" },
                pipeline: [
                    { $match: { $expr: { $and: [{ $eq: ["$leadId", "$$leadId"] }, { $eq: ["$status", "READY"] }] } } },
                    { $limit: 1 },
                    { $project: { _id: 1 } },
                ],
                as: "_readyPresentationArr",
            },
        },
        { $addFields: { hasReadyPresentation: { $gt: [{ $size: "$_readyPresentationArr" }, 0] } } },
        {
            $addFields: {
                bucket: {
                    $switch: {
                        branches: [
                            { case: { $and: ["$nextFollowUp", { $lt: ["$nextFollowUp.dueAt", todayStart] }] }, then: "overdue" },
                            { case: { $and: ["$nextMeeting", { $gte: ["$nextMeeting.scheduledAt", todayStart] }, { $lt: ["$nextMeeting.scheduledAt", tomorrowStart] }] }, then: "meetingToday" },
                            { case: { $and: ["$nextFollowUp", { $gte: ["$nextFollowUp.dueAt", todayStart] }, { $lt: ["$nextFollowUp.dueAt", tomorrowStart] }] }, then: "today" },
                            { case: { $and: [{ $eq: ["$status", "new"] }, { $eq: ["$_hasOutboundCommunication", false] }] }, then: "new" },
                            {
                                case: {
                                    $and: [{ $not: { $in: ["$status", ["nurturing", "converted", "lost"]] } }, "$_hasPendingTranscriptReview"],
                                },
                                then: "transcriptAvailableNeedsReview",
                            },
                            // The three pipeline-progress buckets below only
                            // apply to leads still being ACTIVELY worked —
                            // never nurturing (an agent's own deliberate
                            // "not right now" choice) or converted/lost
                            // (terminal, nothing left to progress). A truly
                            // untouched "new" lead (no outbound contact yet)
                            // already matched the "new" branch above and
                            // never reaches here, so this guard does NOT
                            // need to re-check status=="new" itself — see
                            // this file's Milestone 23.13 comment above
                            // (_hasOutboundCommunication) for why a literal
                            // status string is no longer trusted alone.
                            { case: { $and: [{ $not: { $in: ["$status", ["nurturing", "converted", "lost"]] } }, { $eq: ["$hasConfirmedRequirements", false] }] }, then: "discoveryIncomplete" },
                            { case: { $and: [{ $not: { $in: ["$status", ["nurturing", "converted", "lost"]] } }, { $eq: ["$hasCuratedProperties", false] }] }, then: "readyForFindRooms" },
                            { case: { $and: [{ $not: { $in: ["$status", ["nurturing", "converted", "lost"]] } }, "$hasReadyPresentation", { $eq: ["$_hasAnyFollowUp", false] }] }, then: "presentationNoFollowUp" },
                            { case: { $and: ["$nextFollowUp", { $gte: ["$nextFollowUp.dueAt", tomorrowStart] }] }, then: "upcoming" },
                            { case: { $eq: ["$status", "nurturing"] }, then: "nurturing" },
                        ],
                        default: "noNextAction",
                    },
                },
            },
        },
    ];
}

const BUCKET_SORT_RANK = {
    overdue: 0,
    meetingToday: 1,
    today: 2,
    new: 3,
    transcriptAvailableNeedsReview: 4,
    discoveryIncomplete: 5,
    readyForFindRooms: 6,
    presentationNoFollowUp: 7,
    upcoming: 8,
    nurturing: 9,
    noNextAction: 10,
};

const handler = withErrorHandling(async (req, res) => {
    if (withCors(req, res)) return; // preflight handled

    if (req.method !== "GET") {
        res.status(405).json({ error: "Method not allowed" });
        return;
    }

    const identity = await requireRole(req, res, INTERNAL_ROLES);
    if (!identity) return;

    await connectToDatabase();

    const query = req.query || {};
    let page = parseInt(query.page, 10);
    let limit = parseInt(query.limit, 10);
    if (!Number.isFinite(page) || page < 1) page = 1;
    if (!Number.isFinite(limit) || limit < 1) limit = DEFAULT_LIMIT;
    if (limit > MAX_LIMIT) limit = MAX_LIMIT;

    const bucketFilter = parseEnumParam(query.bucket, WORK_QUEUE_BUCKETS, "bucket");

    const now = new Date();
    const todayStart = startOfDay(now);
    const tomorrowStart = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);

    const baseMatch = buildBaseMatch(query);
    const enrichmentStages = buildEnrichmentStages(todayStart, tomorrowStart);

    const [summaryRows, leadsResult] = await Promise.all([
        // Summary — full scope (base filters, no bucket filter, no pagination).
        Lead.aggregate([{ $match: baseMatch }, ...enrichmentStages, { $group: { _id: "$bucket", count: { $sum: 1 } } }]),
        // Paginated leads — base scope + bucket filter, sorted by priority.
        Lead.aggregate([
            { $match: baseMatch },
            ...enrichmentStages,
            ...(bucketFilter ? [{ $match: { bucket: bucketFilter } }] : []),
            {
                $addFields: {
                    _bucketRank: {
                        $switch: {
                            branches: Object.entries(BUCKET_SORT_RANK).map(([bucket, rank]) => ({ case: { $eq: ["$bucket", bucket] }, then: rank })),
                            default: 99,
                        },
                    },
                },
            },
            { $sort: { _bucketRank: 1, "nextFollowUp.dueAt": 1, createdAt: -1 } },
            {
                $facet: {
                    data: [
                        { $skip: (page - 1) * limit },
                        { $limit: limit },
                        {
                            $project: {
                                id: "$_id",
                                _id: 0,
                                contact: 1,
                                status: 1,
                                temperature: 1,
                                score: 1,
                                source: 1,
                                assignedTo: 1,
                                property: 1,
                                tags: 1,
                                notes: 1,
                                createdAt: 1,
                                updatedAt: 1,
                                firstContactAt: 1,
                                lastContactAt: 1,
                                lastInboundCommunicationAt: 1,
                                nextFollowUp: 1,
                                nextMeeting: 1,
                                bucket: 1,
                            },
                        },
                    ],
                    totalCount: [{ $count: "count" }],
                },
            },
        ]),
    ]);

    const summaryCounts = Object.fromEntries(WORK_QUEUE_BUCKETS.map((b) => [b, 0]));
    summaryRows.forEach((row) => {
        if (Object.prototype.hasOwnProperty.call(summaryCounts, row._id)) summaryCounts[row._id] = row.count;
    });

    const facetResult = leadsResult[0] || { data: [], totalCount: [] };
    const total = facetResult.totalCount[0] ? facetResult.totalCount[0].count : 0;
    const leads = facetResult.data.map((lead) => ({
        ...lead,
        nextFollowUp: lead.nextFollowUp || null,
        nextMeeting: lead.nextMeeting || null,
        lastInboundCommunicationAt: lead.lastInboundCommunicationAt || null,
    }));

    sendSuccess(res, {
        summary: summaryCounts,
        leads,
        pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    });
});

// Exposed so the read-only Ivy Assistant `my_work_queue` tool can run the
// EXACT SAME bucket aggregation this route runs (actor-scoped to the
// caller's own assigned leads) instead of reimplementing the ~150-line
// $switch/$lookup pipeline and risking it drifting out of sync. Same
// "attach pure helpers to the exported handler" precedent as every other
// lead-scoped route in this repo (handler.toSafeMeeting, etc.).
handler.buildBaseMatch = buildBaseMatch;
handler.buildEnrichmentStages = buildEnrichmentStages;
handler.startOfDay = startOfDay;
handler.BUCKET_SORT_RANK = BUCKET_SORT_RANK;
handler.WORK_QUEUE_BUCKETS = WORK_QUEUE_BUCKETS;

module.exports = handler;
