// GET /api/staff — internal roles only. Populates the Lead assignment
// dropdown with real staff (users holding an internal role), never a
// fake/hardcoded agent list. See src/lib/api/staff.ts /
// src/types/staff.ts in ivyhuts-crm — contract was already precisely
// specified there before this route existed.
const { connectToDatabase } = require("./_lib/mongodb");
const { requireRole } = require("./_lib/businessAuth");
const { withCors } = require("./_lib/cors");
const User = require("./_lib/models/User");
const { toSafeStaff } = require("./_lib/staffView");
const { withErrorHandling } = require("./_lib/validation");
const { sendSuccess } = require("./_lib/apiResponse");

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
