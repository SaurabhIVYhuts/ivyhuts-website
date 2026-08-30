// POST /api/leads/:id/meetings/:meetingId/extract-requirements — Milestone
// 23.14.
//
// Explicit agent action only — never automatic, never a side effect of any
// other request (see api/_lib/transcriptExtraction.js's header comment).
// Runs AI-assisted extraction against this meeting's OWN transcriptText,
// stores the result on THIS meeting's extractedRequirements (a suggestion,
// never written to Discovery directly), and notifies the lead's assigned
// agent that requirements are ready for review — Part 9's second
// notification trigger, alongside assignment.
const { connectToDatabase } = require("../../../../../mongodb");
const { requireRole } = require("../../../../../businessAuth");
const { checkBusinessWriteRateLimit } = require("../../../../../businessRateLimit");
const { withCors } = require("../../../../../cors");
const Lead = require("../../../../../models/Lead");
const Meeting = require("../../../../../models/Meeting");
const { extractRequirementsFromTranscript, isTranscriptExtractionConfigured } = require("../../../../../transcriptExtraction");
const { createNotification } = require("../../../../../notify");
const { withErrorHandling, requireObjectId, notFound, badRequest } = require("../../../../../validation");
const { sendSuccess, sendError } = require("../../../../../apiResponse");
const { toSafeMeeting } = require("../index.js");

const INTERNAL_ROLES = ["MARKETING_AGENT", "MARKETING_MANAGER", "ADMIN"];

const handler = withErrorHandling(async (req, res) => {
    if (withCors(req, res)) return;
    if (req.method !== "POST") {
        res.status(405).json({ error: "Method not allowed" });
        return;
    }

    const leadId = requireObjectId(req.query.id, "id");
    const meetingId = requireObjectId(req.query.meetingId, "meetingId");

    const identity = await requireRole(req, res, INTERNAL_ROLES);
    if (!identity) return;

    await checkBusinessWriteRateLimit(req);

    if (!isTranscriptExtractionConfigured()) {
        sendError(res, 503, "SERVICE_UNAVAILABLE", "Transcript extraction is not configured on this deployment.");
        return;
    }

    await connectToDatabase();
    const lead = await Lead.findById(leadId);
    if (!lead) throw notFound("Lead not found.");

    const meeting = await Meeting.findOne({ _id: meetingId, leadId });
    if (!meeting) throw notFound("Meeting not found.");

    if (!meeting.transcriptText || !meeting.transcriptText.trim()) {
        throw badRequest("NO_TRANSCRIPT_TEXT", "This meeting has no transcript text to extract from. Paste the transcript first.");
    }

    const extracted = await extractRequirementsFromTranscript(meeting.transcriptText);
    if (!extracted) {
        sendError(res, 503, "SERVICE_UNAVAILABLE", "Transcript extraction is temporarily unavailable. Please try again shortly.");
        return;
    }

    meeting.extractedRequirements = { ...extracted, status: "pending_review", extractedAt: new Date() };
    meeting.updatedBy = identity.mongoUser._id;
    await meeting.save();

    if (lead.assignedTo) {
        const studentName = (lead.contact && lead.contact.name) || "this lead";
        await createNotification({
            recipientUserId: lead.assignedTo,
            leadId: lead._id,
            type: "TRANSCRIPT_READY_FOR_REVIEW",
            title: "Requirements ready for review",
            message: `Transcript-derived requirements for ${studentName} are ready — review and confirm them in Discovery.`,
            actionHref: `/dashboard/leads/${lead._id}#discovery`,
        });
    }

    sendSuccess(res, toSafeMeeting(meeting));
});

module.exports = handler;
