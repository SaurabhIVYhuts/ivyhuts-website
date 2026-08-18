// Vercel serverless function — returns the currently authenticated user, or
// 401 if there isn't one. Identity always comes from the session cookie via
// requireAuth (api/_lib/auth.js) — never from anything in the request body.
const { requireAuth } = require("../_lib/auth");
const { toSafeUser } = require("../_lib/userStore");
const { withCors } = require("../_lib/cors");

module.exports = async (req, res) => {
    if (withCors(req, res)) return; // preflight handled

    if (req.method !== "GET") {
        res.status(405).json({ error: "Method not allowed" });
        return;
    }

    const user = await requireAuth(req, res);
    if (!user) return; // requireAuth has already written the 401/503 response

    res.status(200).json({ ok: true, user: toSafeUser(user) });
};
