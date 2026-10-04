// GET /api/blogs/:slug — one published blog article. PUBLIC. Drafts and
// unknown slugs are both a plain 404 so a draft's existence never leaks.
//
// Reached in production via vercel.json's rewrite /api/blogs/:slug ->
// /api/content/blog--:slug (the catch-all only matches one segment — see
// api/_lib/routes/content.js), and locally via scripts/local-api-server.js.
// Either way the handler just reads req.query.slug.
const { connectToDatabase } = require("../../../mongodb");
const Blog = require("../../../models/Blog");
const { toBlogDetail } = require("./view");
const { withErrorHandling, notFound } = require("../../../validation");
const { sendSuccess } = require("../../../apiResponse");

module.exports = withErrorHandling(async (req, res) => {
    if (req.method !== "GET") {
        res.status(405).json({ error: "Method not allowed" });
        return;
    }
    const slug = typeof req.query.slug === "string" ? req.query.slug.trim().toLowerCase() : "";
    // Malformed slugs can't match any stored document (the schema enforces
    // the same pattern), so answer 404 without a database round-trip.
    if (!Blog.SLUG_PATTERN.test(slug)) throw notFound("Blog not found.");

    await connectToDatabase();
    const blog = await Blog.findOne({ slug, status: "published" }).lean();
    if (!blog) throw notFound("Blog not found.");

    res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    sendSuccess(res, toBlogDetail(blog));
});
