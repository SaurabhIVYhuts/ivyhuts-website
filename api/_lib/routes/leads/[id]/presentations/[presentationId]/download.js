// GET /api/leads/:id/presentations/:presentationId/download — Milestone 23.8.
//
// Streams the exact stored .pptx bytes for one already-generated version.
// Same cross-lead isolation rule as ./index.js (query by {_id, leadId}
// together, 404 either way). A FAILED or still-GENERATING version has no
// file.data — that's a 404, not a 200 with an empty/corrupt body.
const { connectToDatabase } = require("../../../../../mongodb");
const { requireRole } = require("../../../../../businessAuth");
const { withCors } = require("../../../../../cors");
const Lead = require("../../../../../models/Lead");
const Presentation = require("../../../../../models/Presentation");
const { withErrorHandling, requireObjectId, notFound } = require("../../../../../validation");

const INTERNAL_ROLES = ["MARKETING_AGENT", "MARKETING_MANAGER", "ADMIN"];

const handler = withErrorHandling(async (req, res) => {
    if (withCors(req, res)) return; // preflight handled

    if (req.method !== "GET") {
        res.status(405).json({ error: "Method not allowed" });
        return;
    }

    const identity = await requireRole(req, res, INTERNAL_ROLES);
    if (!identity) return;

    const leadId = requireObjectId(req.query.id, "id");
    const presentationId = requireObjectId(req.query.presentationId, "presentationId");

    await connectToDatabase();
    const lead = await Lead.findById(leadId);
    if (!lead) throw notFound("Lead not found.");

    const doc = await Presentation.findOne({ _id: presentationId, leadId });
    if (!doc) throw notFound("Presentation not found.");

    if (doc.status !== "READY" || !doc.file || !doc.file.data) {
        throw notFound("This presentation version has no downloadable file.");
    }

    // Each version is unique to this lead and never regenerated in place —
    // safe to let a browser cache it, but never across a shared/proxy cache
    // (same reasoning student-planner-ppt.js documents for its own,
    // per-request-unique deck).
    res.setHeader("Content-Type", doc.file.mimeType || "application/vnd.openxmlformats-officedocument.presentationml.presentation");
    res.setHeader("Content-Disposition", `attachment; filename="${doc.file.filename || "presentation.pptx"}"`);
    res.setHeader("Content-Length", String(doc.file.data.length));
    res.setHeader("Cache-Control", "private, no-store");
    res.status(200);
    res.end(doc.file.data);
});

module.exports = handler;
