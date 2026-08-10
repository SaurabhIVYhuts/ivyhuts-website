// Shared "Lead document -> API response" projection — Lead has no secrets
// to strip (unlike User), this just normalizes _id -> id and drops the
// internal __v version key for a consistent response shape.
function toSafeLead(lead) {
    const obj = lead.toObject ? lead.toObject() : lead;
    const { _id, __v, ...rest } = obj;
    return { id: _id, ...rest };
}

module.exports = { toSafeLead };
