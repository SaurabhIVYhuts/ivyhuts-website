// Auto-assigns a freshly-created Lead to the least-loaded active marketing
// agent — CRM plan item 3. "Least-loaded" = the agent with the fewest OPEN
// leads right now (status not converted/lost, not archived). Ties break in
// a stable order (agents come back sorted by _id) so the rotation is
// deterministic, not random.
//
// Gated by env LEAD_AUTO_ASSIGN === "true" so it can be switched off
// without a code change. Fire-and-forget-safe: every failure here is caught
// and logged — lead creation must never fail because auto-assignment did
// (same philosophy as api/_lib/notify.js).
"use strict";

const Lead = require("./models/Lead");
const User = require("./models/User");
const { recordEvent } = require("./events");
const { createNotification } = require("./notify");

// Only these roles can hold a lead (mirrors every lead route's
// INTERNAL_ROLES). MARKETING_MANAGER / ADMIN are included so a small team
// with no dedicated agents still gets round-robin coverage.
const ASSIGNABLE_ROLES = ["MARKETING_AGENT", "MARKETING_MANAGER", "ADMIN"];

function isEnabled() {
    return String(process.env.LEAD_AUTO_ASSIGN || "").trim().toLowerCase() === "true";
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
// null. `notify` controls the in-app Notification — callers doing a bulk
// import (leadSheetSync) pass false so a backfill of hundreds of rows
// doesn't fan out hundreds of notifications.
async function assignLeadAutomatically(lead, { notify = true } = {}) {
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
        return agent;
    } catch (err) {
        console.error("[leadAutoAssign] failed (non-fatal — lead creation still succeeds):", err.message);
        return null;
    }
}

module.exports = { assignLeadAutomatically, pickLeastLoadedAgent, isEnabled };
