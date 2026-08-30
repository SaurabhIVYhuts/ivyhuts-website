// Single reusable entry point for creating a Notification — Milestone 23.14.
// Every place in this backend that needs to nudge an agent calls THIS
// function; notification-creation logic never gets scattered inline into
// route handlers (that's the exact anti-pattern this file exists to avoid).
//
// Deliberately fire-and-forget-safe: a notification is a courtesy, not a
// transaction. If it fails to write, the caller's real work (an assignment,
// a transcript extraction) must still succeed — see createNotification's
// try/catch below, mirroring api/_lib/businessAuth.js's
// getOptionalMongoUserId's "never let a nice-to-have break the real
// operation" philosophy.
const Notification = require("./models/Notification");

async function createNotification({ recipientUserId, leadId = null, type, title, message, actionHref = null }) {
    if (!recipientUserId || !type || !title || !message) return null;
    try {
        return await Notification.create({ recipientUserId, leadId, type, title, message, actionHref });
    } catch (err) {
        console.error("[notify] failed to create notification (non-fatal):", err.message);
        return null;
    }
}

module.exports = { createNotification };
