// Consistent JSON response shapes for the Milestone 2 business API
// (api/customers/*, api/leads/*, api/enquiries/*). Deliberately a
// different shape from the older api/enquire.js / api/auth/* endpoints
// (which use `{ ok, ... }`) — those predate this convention and are out of
// scope to retrofit this milestone; new business endpoints use this
// consistently instead.
function sendSuccess(res, data, status = 200) {
    res.status(status).json({ success: true, data });
}

function sendCollection(res, data, pagination, status = 200) {
    res.status(status).json({ success: true, data, pagination });
}

// `message` is always safe to show a client — callers must never pass raw
// Mongo/Node error text here (see api/_lib/validation.js's ApiError for the
// pattern every handler uses to guarantee that).
function sendError(res, status, code, message) {
    res.status(status).json({ success: false, error: { code, message } });
}

module.exports = { sendSuccess, sendCollection, sendError };
