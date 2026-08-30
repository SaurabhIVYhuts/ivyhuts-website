// GET /api/staff — internal roles only. Populates the Lead assignment
// dropdown with real staff (users holding an internal role), never a
// fake/hardcoded agent list. See src/lib/api/staff.ts /
// src/types/staff.ts in ivyhuts-crm — contract was already precisely
// specified there before this route existed.
const { connectToDatabase } = require("../../mongodb");
const { requireRole } = require("../../businessAuth");
const { withCors } = require("../../cors");
const User = require("../../models/User");
const { toSafeStaff } = require("../../staffView");
const { withErrorHandling } = require("../../validation");
const { sendSuccess } = require("../../apiResponse");

const INTERNAL_ROLES = ["MARKETING_AGENT", "MARKETING_MANAGER", "ADMIN"];

module.exports = withErrorHandling(async (req, res) => {
    if (withCors(req, res)) return; // preflight handled

    if (req.method !== "GET") {
        res.status(405).json({ error: "Method not allowed" });
        return;
    }

    const identity = await requireRole(req, res, INTERNAL_ROLES);
    if (!identity) return;

    await connectToDatabase();
    const staff = await User.find({ role: { $in: INTERNAL_ROLES } })
        .select("name email role")
        .sort({ name: 1 });

    sendSuccess(res, staff.map(toSafeStaff));
});
