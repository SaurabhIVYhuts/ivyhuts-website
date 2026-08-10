// Shared "Enquiry document -> API response" projection — same normalization
// as api/_lib/leadView.js (_id -> id, drop __v).
function toSafeEnquiry(enquiry) {
    const obj = enquiry.toObject ? enquiry.toObject() : enquiry;
    const { _id, __v, ...rest } = obj;
    return { id: _id, ...rest };
}

module.exports = { toSafeEnquiry };
