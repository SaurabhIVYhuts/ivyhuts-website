// GET/POST /api/leads/:id/presentations — Milestone 23.8.
//
// GET lists every generated version for this lead (metadata only — never
// the .pptx bytes, see toSafePresentation below; use
// .../presentations/:presentationId/download for that), newest first.
//
// POST generates a NEW version. The only client input accepted is an
// optional display `title` — every other field is derived server-side from
// the lead's already-SAVED AccommodationCuration
// (api/_lib/models/AccommodationCuration.js), never from live Find Rooms
// search state and never from CompetitiveAnalysis (confirmed backend-absent,
// Milestones 23.2/23.6 — see Presentation.js's own header comment for why
// that system is never the source here). If nothing has been saved yet,
// this 409s with the exact message the CRM's disabled-button copy already
// promises ("Save your curated accommodation options before generating the
// presentation") — the client-side gate in PresentationsSection.tsx is a UX
// convenience, not the real enforcement boundary.
//
// Never overwrites a previous version — every successful POST inserts a new
// document with the next integer version number for this lead; V1 is
// untouched by V2's generation (Milestone 23.8 Part 9/17 — version
// integrity). The saved properties/criteria are deep-copied into
// `snapshot` at generation time so a later edit to the live curation (or a
// provider's live listing) can never change what an already-generated
// version renders (Part 18 — snapshot integrity).
const { connectToDatabase } = require("../../../../mongodb");
const { requireRole } = require("../../../../businessAuth");
const { checkBusinessWriteRateLimit } = require("../../../../businessRateLimit");
const { withCors } = require("../../../../cors");
const { acquireLock, releaseLock } = require("../../../../sharedStore");
const Lead = require("../../../../models/Lead");
const AccommodationCuration = require("../../../../models/AccommodationCuration");
const Presentation = require("../../../../models/Presentation");
const { withErrorHandling, requireObjectId, notFound, badRequest, parseJsonBody, ApiError } = require("../../../../validation");
const { sendSuccess, sendCollection } = require("../../../../apiResponse");
const { normalizeAccommodationCurationForPresentation } = require("../../../../pptNormalizeAccommodation");
const { generateAccommodationPresentationPptxBuffer } = require("../../../../pptBuilderAccommodation");

const INTERNAL_ROLES = ["MARKETING_AGENT", "MARKETING_MANAGER", "ADMIN"];
const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const MAX_TITLE_LEN = 120;
// Same spirit as the curation route's own local payload cap — this body is
// only ever `{title?}`, so 2KB is already generous.
const MAX_PAYLOAD_BYTES = 2_000;
// One in-flight generation per lead at a time — the double-click/idempotency
// guard (Milestone 23.8 Part 19), reusing the SAME advisory-lock primitive
// amberGateway.js/universityResolveService.js already use for this exact
// "collapse concurrent duplicate work" purpose, not a new mechanism.
const LOCK_TTL_MS = 30_000;

function toSafePresentation(doc) {
    return {
        id: String(doc._id),
        leadId: String(doc.leadId),
        version: doc.version,
        title: doc.title,
        status: doc.status,
        errorMessage: doc.errorMessage,
        file: {
            filename: doc.file ? doc.file.filename : null,
            mimeType: doc.file ? doc.file.mimeType : null,
            sizeBytes: doc.file ? doc.file.sizeBytes : null,
        },
        generatedFrom: {
            accommodationCurationId: doc.generatedFrom && doc.generatedFrom.accommodationCurationId ? String(doc.generatedFrom.accommodationCurationId) : null,
            accommodationCurationUpdatedAt: doc.generatedFrom ? doc.generatedFrom.accommodationCurationUpdatedAt : null,
        },
        createdBy: doc.createdBy ? String(doc.createdBy) : null,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
    };
}

function buildFilename(normalized, version) {
    const parts = [normalized.university.available ? normalized.university.name : null, normalized.student.name]
        .filter(Boolean)
        .join("-");
    const slug = parts
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60);
    return `ivyhuts-accommodation-presentation${slug ? `-${slug}` : ""}-v${version}.pptx`;
}

async function handleGet(req, res, leadId) {
    const identity = await requireRole(req, res, INTERNAL_ROLES);
    if (!identity) return;

    await connectToDatabase();
    const lead = await Lead.findById(leadId);
    if (!lead) throw notFound("Lead not found.");

    const docs = await Presentation.find({ leadId }).sort({ version: -1 });
    sendCollection(res, docs.map(toSafePresentation), { total: docs.length });
}

async function handlePost(req, res, leadId) {
    const identity = await requireRole(req, res, INTERNAL_ROLES);
    if (!identity) return;

    await checkBusinessWriteRateLimit(req);
    await connectToDatabase();

    const lead = await Lead.findById(leadId);
    if (!lead) throw notFound("Lead not found.");

    const raw = req.body;
    const rawSize = Buffer.byteLength(typeof raw === "string" ? raw : JSON.stringify(raw || {}), "utf8");
    if (rawSize > MAX_PAYLOAD_BYTES) {
        throw badRequest("PAYLOAD_TOO_LARGE", `Request body exceeds the ${MAX_PAYLOAD_BYTES}-byte limit.`);
    }
    const body = parseJsonBody(req);
    let title = null;
    if (body.title !== undefined && body.title !== null) {
        if (typeof body.title !== "string" || !body.title.trim()) throw badRequest("VALIDATION_ERROR", "title must be a non-empty string when provided.");
        title = body.title.trim().slice(0, MAX_TITLE_LEN);
    }

    // Same-lead-scoped lock — a second concurrent POST for a DIFFERENT lead
    // is never blocked by this, only a duplicate click on the same lead's
    // Generate button.
    const lockKey = `presentation-generate:${leadId}`;
    const lockToken = await acquireLock(lockKey, LOCK_TTL_MS);
    if (!lockToken) {
        throw new ApiError(409, "GENERATION_IN_PROGRESS", "A presentation is already being generated for this lead. Please wait a moment and try again.");
    }

    try {
        const curation = await AccommodationCuration.findOne({ leadId });
        if (!curation || !Array.isArray(curation.properties) || curation.properties.length === 0) {
            throw new ApiError(409, "NO_CURATION_SAVED", "Save your curated accommodation options before generating the presentation.");
        }

        const lastVersionDoc = await Presentation.findOne({ leadId }).sort({ version: -1 }).select("version");
        const nextVersion = lastVersionDoc ? lastVersionDoc.version + 1 : 1;

        const curationPlain = curation.toObject();
        const normalized = normalizeAccommodationCurationForPresentation(curationPlain, {
            studentName: lead.contact && lead.contact.name,
            title: title || "Accommodation Presentation",
        });

        const snapshot = {
            criteriaSnapshot: curationPlain.criteriaSnapshot || null,
            properties: curationPlain.properties || [],
            recommendedPropertyId: curationPlain.recommendedPropertyId || null,
            recommendationReason: curationPlain.recommendationReason || null,
            notes: curationPlain.notes || null,
        };
        const generatedFrom = {
            accommodationCurationId: curation._id,
            accommodationCurationUpdatedAt: curation.updatedAt,
        };

        let doc;
        try {
            const buffer = await generateAccommodationPresentationPptxBuffer(normalized);
            doc = await Presentation.create({
                leadId,
                version: nextVersion,
                title: normalized.title,
                status: "READY",
                snapshot,
                generatedFrom,
                file: { data: buffer, filename: buildFilename(normalized, nextVersion), mimeType: PPTX_MIME, sizeBytes: buffer.length },
                createdBy: identity.mongoUser._id,
            });
        } catch (buildErr) {
            // A pptxgenjs/build-time failure still records a version (Part 9 —
            // "GENERATING/READY/FAILED" is a real status, not decoration) so a
            // repeated attempt after a fix doesn't silently reuse the same
            // version number, and the agent sees a clear failed entry instead
            // of nothing happening.
            console.error("[presentations] generation failed:", buildErr);
            doc = await Presentation.create({
                leadId,
                version: nextVersion,
                title: normalized.title,
                status: "FAILED",
                errorMessage: "Presentation generation failed. Please try again.",
                snapshot,
                generatedFrom,
                createdBy: identity.mongoUser._id,
            });
        }

        sendSuccess(res, toSafePresentation(doc), 201);
    } finally {
        await releaseLock(lockKey, lockToken);
    }
}

const handler = withErrorHandling(async (req, res) => {
    if (withCors(req, res)) return; // preflight handled

    const leadId = requireObjectId(req.query.id, "id");

    if (req.method === "GET") return handleGet(req, res, leadId);
    if (req.method === "POST") return handlePost(req, res, leadId);

    res.status(405).json({ error: "Method not allowed" });
});

// Exposed for scripts/verify-presentations.js's pure unit tests, same
// precedent as the curation/discovery routes' own exported helpers.
handler.toSafePresentation = toSafePresentation;
handler.buildFilename = buildFilename;
handler.MAX_TITLE_LEN = MAX_TITLE_LEN;
handler.MAX_PAYLOAD_BYTES = MAX_PAYLOAD_BYTES;

module.exports = handler;
