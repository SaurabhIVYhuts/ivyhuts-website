// Creates the CRM's own "call this new lead" task — the missing half of
// the sales flow's step 5 ("CRM reminds sales guy to call the lead").
// Assignment already produced an in-app notification (leadAutoAssign.js,
// routes/leads/[id]/assignment.js), but nothing ever put a dated, chaseable
// ACTION in the agent's queue, so a freshly-arrived lead nagged nobody once
// that one notification was read.
//
// What this writes is an ordinary FollowUp — the same record an agent
// creates by hand — so everything already built on FollowUp works on it for
// free and no second reminder mechanism enters the codebase: the Lead
// Inbox's Next Step column and its overdue/today priority pills, the lead
// page's Next Action card, and the daily reminder email
// (api/leads/follow-ups/remind-cron.js).
//
// The one thing that marks it out is `origin: "system"`, which keeps the
// CUSTOMER out of its notifications (see followUpNotify.js): a student must
// never be emailed "your advisor will follow up around 4pm" about an
// internal task they never agreed to.
//
// Gated by env FIRST_CONTACT_TASK ("false" turns it off). Fire-and-forget-
// safe in the same way as leadAutoAssign.js: every failure is caught and
// logged, because a lead must never be lost because its task didn't write.
"use strict";

const FollowUp = require("./models/FollowUp");
const { notifyFollowUpParties } = require("./followUpNotify");

const DEFAULT_DUE_MINUTES = 120;
const MIN_DUE_MINUTES = 5;
const MAX_DUE_MINUTES = 7 * 24 * 60;
// Terminal statuses — a converted or lost lead needs no first call.
const TERMINAL_STATUSES = ["converted", "lost"];

// Opt-OUT, unlike leadAutoAssign's opt-in: this task is inert on its own
// (it writes one row an agent can complete or cancel), so the safe default
// is the behavior the sales flow actually asks for.
function isEnabled() {
    return String(process.env.FIRST_CONTACT_TASK || "").trim().toLowerCase() !== "false";
}

// How long the agent has to make first contact. Anything unparseable falls
// back to the default rather than producing a task due at "Invalid Date".
function dueMinutes() {
    const raw = Number(String(process.env.FIRST_CONTACT_TASK_DUE_MINUTES || "").trim());
    if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_DUE_MINUTES;
    return Math.min(MAX_DUE_MINUTES, Math.max(MIN_DUE_MINUTES, Math.round(raw)));
}

// Ensures `lead` has a first-contact call task, returning the FollowUp it
// created or null when it deliberately created nothing. `notifyAgent`
// controls the email to the assigned agent — bulk callers (leadSheetSync)
// pass false so importing a hundred sheet rows can never fan out a hundred
// emails; the task still lands in the agent's work queue either way.
async function ensureFirstContactTask(lead, { notifyAgent = true } = {}) {
    if (!isEnabled()) return null;
    if (!lead || !lead._id) return null;
    if (!lead.assignedTo) return null; // nobody to remind — the assignment route calls back here once there is
    if (lead.archivedAt) return null;
    if (TERMINAL_STATUSES.includes(lead.status)) return null;

    try {
        // ANY existing follow-up — pending, completed or cancelled — means
        // this lead's next step is already somebody's deliberate decision.
        // Never second-guess it, and never stack a duplicate task onto a
        // re-assignment.
        const existing = await FollowUp.exists({ leadId: lead._id });
        if (existing) return null;

        const studentName = (lead.contact && lead.contact.name) || "this lead";
        const followUp = await FollowUp.create({
            leadId: lead._id,
            userId: lead.userId || null,
            // Same derivation as the manual POST route: the task belongs to
            // whoever holds the LEAD, never to whoever triggered this.
            assignedTo: lead.assignedTo,
            type: "call",
            priority: "high",
            dueAt: new Date(Date.now() + dueMinutes() * 60 * 1000),
            notes: `First contact — call ${studentName} to introduce IVYHUTS and book a consultation.`,
            origin: "system",
        });

        if (notifyAgent) await notifyFollowUpParties(lead, followUp, "created");
        return followUp;
    } catch (err) {
        console.error("[firstContactTask] failed (non-fatal — the lead itself is unaffected):", err.message);
        return null;
    }
}

module.exports = { ensureFirstContactTask, isEnabled, dueMinutes };
