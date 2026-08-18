// GET /api/leads/work-queue — internal roles only. Drives the Dashboard's
// "My Work" tiles (summary) and the Lead Inbox's prioritized table (leads)
// from one request — see src/types/workQueue.ts in ivyhuts-crm, whose
// contract this route was built against (already precisely specified
// there, including the exact WorkQueueLead $project field list, before
// this route existed).
//
// Bucket semantics (not specified anywhere else, so decided and recorded
// here — mutually exclusive per lead, priority order matches
// WORK_QUEUE_BUCKETS in the CRM type):
//   overdue      — has a PENDING follow-up due before today
//   today        — has a PENDING follow-up due today
//   new          — status "new" (and didn't already match overdue/today)
//   upcoming     — has a PENDING follow-up due after today (and didn't
//                  already match a higher bucket)
//   nurturing    — status "nurturing" (and didn't match a higher bucket)
//   noNextAction — everything else (the catch-all)
// `summary` always reflects the full scope (status/source/assignedTo/
// search filters applied, bucket NOT applied) — `leads` additionally
// applies the `bucket` filter. This is why the aggregation runs twice
// (BASE_STAGES shared, PAGINATED_STAGES vs SUMMARY_STAGES diverge only
// after that point) rather than once.
//
// lastInboundCommunicationAt (CRM Milestone 16's "Customer Replied"
// signal) is computed here from Communication.direction — no such
// precomputed/maintained field exists on Lead itself (confirmed absent by
// direct grep before writing this route); this is the first real
// implementation of it, scoped to this endpoint's own response only.
const { connectToDatabase } = require("../_lib/mongodb");
const { requireRole } = require("../_lib/businessAuth");
const { withCors } = require("../_lib/cors");
const Lead = require("../_lib/models/Lead");
const { withErrorHandling, escapeRegex, parseEnumParam } = require("../_lib/validation");
const { sendSuccess } = require("../_lib/apiResponse");

const INTERNAL_ROLES = ["MARKETING_AGENT", "MARKETING_MANAGER", "ADMIN"];
const LEAD_STATUSES = ["new", "contacted", "qualified", "nurturing", "converted", "lost"];
const WORK_QUEUE_BUCKETS = ["overdue", "today", "new", "upcoming", "nurturing", "noNextAction"];
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

// Shared stages: attach nextFollowUp (earliest pending), lastCommunication
// (most recent, any direction), and the computed `bucket` — used by both
// the summary and paginated legs so the two can never disagree about what
// bucket a given lead falls in.
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
        {
            $addFields: {
                bucket: {
                    $switch: {
                        branches: [
                            { case: { $and: ["$nextFollowUp", { $lt: ["$nextFollowUp.dueAt", todayStart] }] }, then: "overdue" },
                            { case: { $and: ["$nextFollowUp", { $gte: ["$nextFollowUp.dueAt", todayStart] }, { $lt: ["$nextFollowUp.dueAt", tomorrowStart] }] }, then: "today" },
                            { case: { $eq: ["$status", "new"] }, then: "new" },
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

const BUCKET_SORT_RANK = { overdue: 0, today: 1, new: 2, upcoming: 3, nurturing: 4, noNextAction: 5 };

module.exports = withErrorHandling(async (req, res) => {
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
        lastInboundCommunicationAt: lead.lastInboundCommunicationAt || null,
    }));

    sendSuccess(res, {
        summary: summaryCounts,
        leads,
        pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    });
});
