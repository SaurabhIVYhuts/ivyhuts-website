// Best-effort behavioural-event recording, using the existing UserEvent
// model from Milestone 1 rather than inventing a second activity
// collection (per the Milestone 2 spec). Deliberately fire-and-forget in
// spirit — a failure to record an event must never fail the business
// operation it's describing (creating a lead, changing a status). This is
// NOT the event-tracking system itself (that's a future milestone); it's
// just reused here for the handful of events this milestone's own actions
// naturally produce (LEAD_CREATED, LEAD_STATUS_CHANGED, ENQUIRY_SUBMITTED).
const UserEvent = require("./models/UserEvent");

async function recordEvent({ userId, anonymousId, event, properties, metadata }) {
    try {
        await UserEvent.create({
            userId: userId || null,
            anonymousId: anonymousId || null,
            event,
            properties: properties || {},
            metadata: metadata || {},
        });
    } catch (err) {
        console.error(`[events] Failed to record ${event} (non-fatal):`, err.message);
    }
}

module.exports = { recordEvent };
