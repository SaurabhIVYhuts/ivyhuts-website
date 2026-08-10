// POST /api/events — the one server-side entry point Milestone 4 adds for
// frontend-triggered behavioral events (PROPERTY_VIEWED, CITY_SEARCHED).
// Deliberately narrow: this is NOT a generic "log any event" endpoint — the
// event name is checked against a fixed whitelist and each event's
// `properties` are picked field-by-field from the request, never passed
// through verbatim, so a client can never write an arbitrary UserEvent
// document, spoof ENQUIRY_SUBMITTED/WISHLIST_ADDED/WISHLIST_REMOVED (those
// are only ever recorded from their real server-side source of truth — see
// api/enquiries/index.js and api/wishlist/*), or stuff unexpected data into
// storage. Reuses the existing api/_lib/events.js#recordEvent (same
// UserEvent model Milestone 1-3 already use) rather than a second
// event-tracking mechanism.
//
// Public endpoint (like POST /api/enquiries): identity is resolved
// optionally via the session — an anonymous visitor's request is accepted
// (200, not an error) but nothing is recorded for it, since this project
// has no anonymous-identifier mechanism yet (see the Milestone 4 report /
// docs for why one wasn't invented here) and a userId-less, anonymousId-less
// event would carry no reusable segmentation signal.
const { connectToDatabase } = require("../_lib/mongodb");
const { getOptionalMongoUserId } = require("../_lib/businessAuth");
const { checkBusinessWriteRateLimit } = require("../_lib/businessRateLimit");
const UserEvent = require("../_lib/models/UserEvent");
const { recordEvent } = require("../_lib/events");
const { withErrorHandling, badRequest, parseJsonBody } = require("../_lib/validation");
const { sendSuccess } = require("../_lib/apiResponse");

function cleanString(value, max) {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed ? trimmed.slice(0, max) : null;
}

// Each entry: how to pick a safe `properties` object out of the raw
// request body, and which single field (if any) identifies "the same
// thing happened again" for the dedup window below.
const EVENT_DEFS = {
    PROPERTY_VIEWED: {
        buildProperties(body) {
            const propertyId = cleanString(body.propertyId, 100);
            if (!propertyId) throw badRequest("VALIDATION_ERROR", "properties.propertyId is required for PROPERTY_VIEWED.");
            return {
                propertyId,
                propertySlug: cleanString(body.propertySlug, 200),
                city: cleanString(body.city, 120),
                source: cleanString(body.source, 60),
            };
        },
        dedupField: "propertyId",
    },
    CITY_SEARCHED: {
        buildProperties(body) {
            const city = cleanString(body.city, 120);
            if (!city) throw badRequest("VALIDATION_ERROR", "properties.city is required for CITY_SEARCHED.");
            return { city, source: cleanString(body.source, 60) };
        },
        dedupField: "city",
    },
};

// Property-view dedup strategy (Milestone 4 Part 13): a refresh/re-navigate
// to the same property (or a repeat search for the same city) by the same
// authenticated user within this window is treated as the same visit, not
// a new marketing signal — avoids counting five page refreshes as five
// separate "interest" events. Deliberately a plain query against the
// existing UserEvent.userId+timestamp index (no new index, no session/
// cache infrastructure) rather than an expensive analytics pipeline; 30
// minutes approximates "one browsing visit" without needing a real session
// concept. Documented here and in docs/marketing-data-architecture.md.
const DEDUP_WINDOW_MS = 30 * 60 * 1000;

async function wasRecentlyRecorded(userId, event, dedupField, value) {
    const since = new Date(Date.now() - DEDUP_WINDOW_MS);
    const existing = await UserEvent.findOne({
        userId,
        event,
        [`properties.${dedupField}`]: value,
        timestamp: { $gte: since },
    }).select("_id");
    return !!existing;
}

async function handlePost(req, res) {
    await connectToDatabase();
    const body = parseJsonBody(req);
    const eventName = typeof body.event === "string" ? body.event : "";
    const def = EVENT_DEFS[eventName];
    if (!def) {
        throw badRequest("VALIDATION_ERROR", `event must be one of: ${Object.keys(EVENT_DEFS).join(", ")}.`);
    }

    const rawProperties = body.properties && typeof body.properties === "object" ? body.properties : {};
    const properties = def.buildProperties(rawProperties);

    const userId = await getOptionalMongoUserId(req);
    if (!userId) {
        // Anonymous — accepted, not recorded (see header comment).
        sendSuccess(res, { recorded: false, reason: "anonymous" });
        return;
    }

    if (await wasRecentlyRecorded(userId, eventName, def.dedupField, properties[def.dedupField])) {
        sendSuccess(res, { recorded: false, reason: "deduped" });
        return;
    }

    await recordEvent({ userId, event: eventName, properties });
    sendSuccess(res, { recorded: true }, 201);
}

module.exports = withErrorHandling(async (req, res) => {
    if (req.method !== "POST") {
        res.status(405).json({ error: "Method not allowed" });
        return;
    }
    await checkBusinessWriteRateLimit(req);
    return handlePost(req, res);
});
