// A stored segment DEFINITION only — e.g. "London high-intent users" as
// data (field/operator/value conditions), never as executable code. No
// query engine/evaluator is implemented in this milestone; this model only
// establishes a safe place to store what a segment means so a future
// milestone can interpret `rules` into an actual MongoDB query. There is
// deliberately no `eval`, no stored function body, and no string of code
// anywhere in this schema — every condition is plain data.
const mongoose = require("mongoose");
const { Schema } = mongoose;

const SegmentConditionSchema = new Schema(
    {
        field: { type: String, required: true }, // e.g. "profile.city", "lead.score", "wishlistCount"
        operator: {
            type: String,
            required: true,
            enum: ["eq", "ne", "gt", "gte", "lt", "lte", "in", "nin", "exists"],
        },
        value: { type: Schema.Types.Mixed, default: null },
    },
    { _id: false }
);

const SegmentSchema = new Schema(
    {
        name: { type: String, required: true, unique: true, trim: true },
        description: { type: String, default: null },
        rules: {
            operator: { type: String, enum: ["AND", "OR"], default: "AND" },
            conditions: { type: [SegmentConditionSchema], default: [] },
        },
        isActive: { type: Boolean, default: true },
    },
    { timestamps: true }
);

module.exports = mongoose.models.Segment || mongoose.model("Segment", SegmentSchema);
