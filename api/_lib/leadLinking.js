// Implements the Milestone 2 requirement that creating an Enquiry should
// "create or associate a Lead if appropriate". Rule (deliberately simple —
// no scoring/automation engine, that's out of scope):
//
//   - If the enquirer already has an open (non-converted, non-lost,
//     non-archived) Lead — matched by userId if authenticated, else by
//     contact.email if given — reuse it and bump lastContactAt, rather
//     than creating a duplicate Lead for every repeat enquiry.
//   - Otherwise, create a new Lead from the enquiry's own details.
//   - A fully anonymous enquiry with no email at all gets its own fresh
//     Lead every time — there's no reliable key to dedupe it against.
const Lead = require("./models/Lead");

const OPEN_STATUS = { $nin: ["converted", "lost"] };

async function findOrCreateLeadForEnquiry({ userId, contact, source, sourceDetails, property }) {
    let existing = null;
    if (userId) {
        existing = await Lead.findOne({ userId, archivedAt: null, status: OPEN_STATUS }).sort({ createdAt: -1 });
    } else if (contact && contact.email) {
        existing = await Lead.findOne({ "contact.email": String(contact.email).toLowerCase(), archivedAt: null, status: OPEN_STATUS }).sort({ createdAt: -1 });
    }

    if (existing) {
        existing.lastContactAt = new Date();
        await existing.save();
        return existing;
    }

    return Lead.create({
        userId: userId || null,
        contact: contact || {},
        source: source || null,
        sourceDetails: sourceDetails || {},
        property: property || {},
        status: "new",
        firstContactAt: new Date(),
        lastContactAt: new Date(),
    });
}

module.exports = { findOrCreateLeadForEnquiry };
