// Auto-assigns a freshly-created Lead to the least-loaded active marketing
// agent — CRM plan item 3. "Least-loaded" = the agent with the fewest OPEN
// leads right now (status not converted/lost, not archived). Ties break in
// a stable order (agents come back sorted by _id) so the rotation is
// deterministic, not random.
//
// ON by default; set env LEAD_AUTO_ASSIGN=false to switch it off without a
// code change. (It shipped opt-in, which meant every deployment that never
// set the flag quietly landed its leads unassigned — the sales flow's step
// 4, "leads booked against the sales guy", simply didn't happen. Opt-out
// makes the default match the documented process; nothing is irreversible,
// since an assignment can be changed from the Lead Inbox at any time.)
// Fire-and-forget-safe: every failure here is caught and logged — lead
// creation must never fail because auto-assignment did (same philosophy as
// api/_lib/notify.js).
"use strict";

const Lead = require("./models/Lead");
const User = require("./models/User");
const { recordEvent } = require("./events");
const { createNotification } = require("./notify");
const { ensureFirstContactTask } = require("./firstContactTask");

// Only these roles can hold a lead (mirrors every lead route's
// INTERNAL_ROLES). MARKETING_MANAGER / ADMIN are included so a small team
// with no dedicated agents still gets round-robin coverage.
const ASSIGNABLE_ROLES = ["MARKETING_AGENT", "MARKETING_MANAGER", "ADMIN"];

function isEnabled() {
    return String(process.env.LEAD_AUTO_ASSIGN || "").trim().toLowerCase() !== "false";
}

// The active, assignable agent with the fewest open leads — or null when
// there are no eligible agents at all.
async function pickLeastLoadedAgent() {
    const agents = await User.find({ role: { $in: ASSIGNABLE_ROLES }, active: { $ne: false } })
        .select("_id name email")
        .sort({ _id: 1 })
        .lean();
    if (agents.length === 0) return null;

    const agentIds = agents.map((a) => String(a._id));
    const counts = await Lead.aggregate([
        { $match: { assignedTo: { $in: agentIds }, status: { $nin: ["converted", "lost"] }, archivedAt: null } },
        { $group: { _id: "$assignedTo", n: { $sum: 1 } } },
    ]);
    const openByAgent = new Map(counts.map((c) => [c._id, c.n]));

    let best = null;
    let bestOpen = Infinity;
    for (const agent of agents) {
        const open = openByAgent.get(String(agent._id)) || 0;
        if (open < bestOpen) {
            bestOpen = open;
            best = agent;
        }
    }
    return best;
}

// Assigns `lead` in place (mutates + saves it) when auto-assign is enabled
// and the lead has no agent yet. Returns the chosen agent (lean doc) or
// null.
//
// Two independent notification budgets, because the two channels cost very
// different things: `notify` controls the in-app Notification (cheap and
// internal — leadSheetSync caps it per run), while `taskEmail` controls the
// first-contact task's EMAIL to that agent. A bulk importer passes
// taskEmail:false unconditionally: an inbox is not a work queue, and the
// task is waiting in the CRM either way.
async function assignLeadAutomatically(lead, { notify = true, taskEmail = notify } = {}) {
    if (!isEnabled()) return null;
    if (!lead || lead.assignedTo) return null; // never override an existing assignment

    try {
        const agent = await pickLeastLoadedAgent();
        if (!agent) return null;

        lead.assignedTo = String(agent._id);
        await lead.save();

        await recordEvent({
            userId: lead.userId || null,
            event: "LEAD_ASSIGNED",
            properties: { leadId: String(lead._id), assignedTo: lead.assignedTo },
            metadata: { changedBy: "auto", changedByRole: "system" },
        });

        if (notify) {
            const studentName = (lead.contact && lead.contact.name) || "this lead";
            await createNotification({
                recipientUserId: agent._id,
                leadId: lead._id,
                type: "LEAD_ASSIGNED",
                title: "New lead assigned",
                message: `${studentName} was auto-assigned to you. Reach out to get started.`,
                actionHref: `/dashboard/leads/${lead._id}`,
            });
        }

        // Flow step 5 — a notification is read once and gone, so give the
        // agent a dated task to actually chase.
        await ensureFirstContactTask(lead, { notifyAgent: taskEmail });

        return agent;
    } catch (err) {
        console.error("[leadAutoAssign] failed (non-fatal — lead creation still succeeds):", err.message);
        return null;
    }
}

module.exports = { assignLeadAutomatically, pickLeastLoadedAgent, isEnabled };
