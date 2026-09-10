// Emails both parties about a follow-up — CRM plan item 5. The assigned
// agent gets the task with a button back into the CRM lead (so they can
// log the outcome and set the next step); the customer gets a plain
// heads-up. One place so the follow-up route and the daily reminder cron
// send identical messages.
//
// "Both parties" holds only for a follow-up a HUMAN scheduled. A
// system-created task (followUp.origin === "system") is internal and
// reaches the agent alone — see the guard in notifyFollowUpParties.
//
// Soft-fail throughout (see mailer.sendFollowUpEmail's own comment) — a
// notification is a courtesy, never a transaction; nothing here throws.
"use strict";

const User = require("./models/User");
const { sendFollowUpEmail } = require("./mailer");

// The CRM lead URL for the "Open lead in CRM" button. CRM_ORIGIN is the
// canonical value; SITE_URL is a last-resort fallback. Returns null when
// neither is configured (the email then simply omits the button).
function leadUrl(leadId) {
    const base = String(process.env.CRM_ORIGIN || process.env.SITE_URL || "").replace(/\/$/, "");
    return base ? `${base}/dashboard/leads/${leadId}` : null;
}

async function notifyFollowUpParties(lead, followUp, kind = "created") {
    const result = { agent: null, customer: null };
    try {
        if (lead && lead.assignedTo) {
            const agent = await User.findById(lead.assignedTo).select("email").lean();
            if (agent && agent.email) {
                result.agent = await sendFollowUpEmail({
                    to: agent.email,
                    audience: "agent",
                    kind,
                    lead,
                    followUp,
                    leadUrl: leadUrl(lead._id),
                });
            }
        }
        // A CRM-generated task (origin "system" — the first-contact call)
        // is INTERNAL. The student never agreed to it and must not be
        // emailed "your advisor will follow up around 4pm" about it; only
        // a follow-up a human actually scheduled earns that heads-up.
        const internalOnly = followUp && followUp.origin === "system";
        if (!internalOnly && lead && lead.contact && lead.contact.email) {
            result.customer = await sendFollowUpEmail({
                to: lead.contact.email,
                audience: "customer",
                kind,
                lead,
                followUp,
            });
        }
    } catch (err) {
        console.error("[followUpNotify] non-fatal:", err.message);
    }
    return result;
}

module.exports = { notifyFollowUpParties, leadUrl };
