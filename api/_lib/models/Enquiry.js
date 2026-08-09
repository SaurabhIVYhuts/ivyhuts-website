// A specific expression of interest — distinct from Lead (the business
// qualification/pipeline state) and from User (the person). An Enquiry is
// the concrete "I'm interested in this" submission itself; a Lead can
// accumulate multiple Enquiries over time as the relationship develops.
//
// Does not require an account (userId is optional — the enquiry forms
// today are all anonymous, see docs/marketing-data-architecture.md section
// O) and never calls Amber to validate property.id — it's stored as an
// opaque snapshot of whatever the frontend had in hand at submission time,
// exactly like the current api/enquire.js -> mailer.js flow already does.
const mongoose = require("mongoose");
const { Schema } = mongoose;

const ENQUIRY_STATUSES = ["new", "contacted", "in_progress", "resolved", "converted", "closed"];

const EnquirySchema = new Schema(
    {
        userId: { type: Schema.Types.ObjectId, ref: "User", default: null },
        leadId: { type: Schema.Types.ObjectId, ref: "Lead", default: null },
        property: {
            id: { type: String, default: null },
            name: { type: String, default: null },
            city: { type: String, default: null },
        },
        message: { type: String, default: null },
        contact: {
            name: { type: String, required: true },
            email: { type: String, lowercase: true, trim: true },
            phone: { type: String, default: null },
        },
        status: { type: String, enum: ENQUIRY_STATUSES, default: "new" },
        source: { type: String, default: null }, // e.g. "find-rooms", "contact", "list-your-stay", "partner"
    },
    { timestamps: true }
);

// userId: query pattern = "all enquiries by this registered user".
EnquirySchema.index({ userId: 1 });
// leadId: query pattern = "all enquiries tied to this Lead".
EnquirySchema.index({ leadId: 1 });
// property.id: query pattern = "how much interest has this property gotten".
EnquirySchema.index({ "property.id": 1 });
// status: query pattern = admin queue filtering ("show unresolved enquiries").
EnquirySchema.index({ status: 1 });
// createdAt: query pattern = new-enquiries-over-time reporting.
EnquirySchema.index({ createdAt: -1 });

module.exports = mongoose.models.Enquiry || mongoose.model("Enquiry", EnquirySchema);
