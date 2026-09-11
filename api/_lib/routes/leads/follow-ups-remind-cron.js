// Served at GET /api/leads/follow-ups/remind-cron through the /api/leads
// dispatcher: vercel.json rewrites that URL to the one-segment
// /api/leads/__followups-remind-cron__, the same flattening every other
// multi-segment lead route uses (see api/_lib/routes/leads.js). It used to
// be its own file under api/leads/ — i.e. its own Vercel Function, the
// 13th, one past the Hobby plan's 12-per-deployment limit, which failed
// every production deploy until it moved here.
//
// Daily follow-up reminder — CRM plan item 5. Emails the assigned agent
// (the task + a button back into the CRM lead) and the customer (a plain
// heads-up) about every PENDING follow-up due within the next 24 hours
// that hasn't been reminded yet, then stamps reminderSentAt so a given
// follow-up is only ever reminded once.
//
// Auth: same bearer-secret contract as api/leads/import/sync-cron.js —
// CRON_SECRET checked against the Authorization header (Vercel Cron /
// cron-job.org convention). If CRON_SECRET isn't set the route exists but
// refuses every request (fails closed). Email delivery itself is soft-fail
// (see api/_lib/mailer.js): a Resend problem is logged and the run still
// reports which follow-ups it reached.
const { connectToDatabase } = require("../../mongodb");
const FollowUp = require("../../models/FollowUp");
const Lead = require("../../models/Lead");
const { notifyFollowUpParties } = require("../../followUpNotify");

const WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_PER_RUN = 200; // defensive ceiling — this is a batch job, not a list endpoint.

module.exports = async (req, res) => {
    if (req.method !== "GET") {
        res.status(405).json({ error: "Method not allowed" });
        return;
    }

    const secret = process.env.CRON_SECRET;
    if (!secret) {
        console.warn("[followup-remind-cron] CRON_SECRET not configured — refusing all requests to /api/leads/follow-ups/remind-cron");
        res.status(503).json({ ok: false, error: "not_configured" });
        return;
    }

    if ((req.headers.authorization || "") !== `Bearer ${secret}`) {
        res.status(401).json({ ok: false, error: "unauthorized" });
        return;
    }

    try {
        await connectToDatabase();

        const horizon = new Date(Date.now() + WINDOW_MS);
        // No lower bound on dueAt — an overdue follow-up that was never
        // reminded still deserves one.
        const due = await FollowUp.find({ status: "pending", reminderSentAt: null, dueAt: { $lte: horizon } })
            .sort({ dueAt: 1 })
            .limit(MAX_PER_RUN);

        let reminded = 0;
        let skipped = 0;
        for (const followUp of due) {
            const lead = await Lead.findById(followUp.leadId);
            if (!lead || lead.archivedAt) {
                skipped += 1;
                continue;
            }
            await notifyFollowUpParties(lead, followUp, "reminder");
            followUp.reminderSentAt = new Date();
            await followUp.save();
            reminded += 1;
        }

        res.status(200).json({ ok: true, status: "OK", checked: due.length, reminded, skipped, ranAt: new Date().toISOString() });
    } catch (err) {
        console.error("[followup-remind-cron] run failed:", err);
        res.status(500).json({ ok: false, error: "internal_error" });
    }
};
