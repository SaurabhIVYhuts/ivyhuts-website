// GET /api/leads/assignment-summary — internal roles only. Aggregate
// per-agent workload counts + unassigned count, for the Dashboard's "My
// Work"/team-workload tiles. Never returns raw lead/contact data — see
// src/types/assignmentSummary.ts in ivyhuts-crm, whose contract this
// route was built against (already precisely specified there before this
// route existed).
//
// Definitions (not specified anywhere else, so recorded here as the one
// place they're decided):
//   - "agent" = any User currently holding an internal role (same set
//     api/staff.js lists) — everyone who can be assigned a lead.
//   - totalLeads = every non-archived lead currently assigned to this
//     agent, any status (mirrors api/leads/index.js's own "archived
//     hidden by default" convention).
//   - activeLeads = the subset of totalLeads still in the working pipeline
//     (new/contacted/qualified) — not yet nurturing, converted, or lost.
//   - nurturingLeads = the subset with status "nurturing", broken out
//     separately since it's a distinct dashboard signal from "actively
//     being worked".
//   - todayFollowUps / overdueFollowUps = this agent's own PENDING
//     FollowUp documents (FollowUp.assignedTo, a stringified User._id,
//     same convention as Lead.assignedTo) due today / due before today,
//     using the server's local calendar day as the boundary — single-
//     region deployment, no per-agent timezone concept exists anywhere
//     else in this codebase to base a different choice on.
const { connectToDatabase } = require("../_lib/mongodb");
const { requireRole } = require("../_lib/businessAuth");
const { withCors } = require("../_lib/cors");
const Lead = require("../_lib/models/Lead");
const FollowUp = require("../_lib/models/FollowUp");
const User = require("../_lib/models/User");
const { withErrorHandling } = require("../_lib/validation");
const { sendSuccess } = require("../_lib/apiResponse");

const INTERNAL_ROLES = ["MARKETING_AGENT", "MARKETING_MANAGER", "ADMIN"];
const ACTIVE_STATUSES = ["new", "contacted", "qualified"];

function startOfDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

module.exports = withErrorHandling(async (req, res) => {
    if (withCors(req, res)) return; // preflight handled

    if (req.method !== "GET") {
        res.status(405).json({ error: "Method not allowed" });
        return;
    }

    const identity = await requireRole(req, res, INTERNAL_ROLES);
    if (!identity) return;

    await connectToDatabase();

    const now = new Date();
    const todayStart = startOfDay(now);
    const tomorrowStart = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);

    const agents = await User.find({ role: { $in: INTERNAL_ROLES } }).select("_id").sort({ name: 1 });
    const agentIds = agents.map((a) => String(a._id));

    const [leadCounts, todayCounts, overdueCounts, unassigned] = await Promise.all([
        Lead.aggregate([
            { $match: { archivedAt: null, assignedTo: { $in: agentIds } } },
            {
                $group: {
                    _id: "$assignedTo",
                    totalLeads: { $sum: 1 },
                    activeLeads: { $sum: { $cond: [{ $in: ["$status", ACTIVE_STATUSES] }, 1, 0] } },
                    nurturingLeads: { $sum: { $cond: [{ $eq: ["$status", "nurturing"] }, 1, 0] } },
                },
            },
        ]),
        FollowUp.aggregate([
            { $match: { assignedTo: { $in: agentIds }, status: "pending", dueAt: { $gte: todayStart, $lt: tomorrowStart } } },
            { $group: { _id: "$assignedTo", count: { $sum: 1 } } },
        ]),
        FollowUp.aggregate([
            { $match: { assignedTo: { $in: agentIds }, status: "pending", dueAt: { $lt: todayStart } } },
            { $group: { _id: "$assignedTo", count: { $sum: 1 } } },
        ]),
        Lead.countDocuments({ archivedAt: null, assignedTo: null }),
    ]);

    const leadCountsByAgent = new Map(leadCounts.map((c) => [c._id, c]));
    const todayByAgent = new Map(todayCounts.map((c) => [c._id, c.count]));
    const overdueByAgent = new Map(overdueCounts.map((c) => [c._id, c.count]));

    const summary = {
        agents: agentIds.map((agentId) => {
            const leadStats = leadCountsByAgent.get(agentId);
            return {
                agentId,
                activeLeads: leadStats ? leadStats.activeLeads : 0,
                nurturingLeads: leadStats ? leadStats.nurturingLeads : 0,
                totalLeads: leadStats ? leadStats.totalLeads : 0,
                todayFollowUps: todayByAgent.get(agentId) || 0,
                overdueFollowUps: overdueByAgent.get(agentId) || 0,
            };
        }),
        unassigned,
    };

    sendSuccess(res, summary);
});
