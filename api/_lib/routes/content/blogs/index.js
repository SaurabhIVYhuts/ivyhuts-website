// GET /api/blogs — published blog articles, newest first. PUBLIC. Listing
// shape only: `content` is omitted to keep the payload small; the full
// article comes from GET /api/blogs/:slug (./[slug].js).
const { connectToDatabase } = require("../../../mongodb");
const Blog = require("../../../models/Blog");
const { toBlogSummary } = require("./view");
const { withErrorHandling, parsePagination, buildPaginationMeta } = require("../../../validation");
const { sendCollection } = require("../../../apiResponse");

module.exports = withErrorHandling(async (req, res) => {
    if (req.method !== "GET") {
        res.status(405).json({ error: "Method not allowed" });
        return;
    }
    await connectToDatabase();
    const pagination = parsePagination(req.query);
    const filter = { status: "published" };

    const [documents, total] = await Promise.all([
        Blog.find(filter)
            .select("-content")
            .sort({ publishedAt: -1, _id: -1 })
            .skip(pagination.skip)
            .limit(pagination.limit)
            .lean(),
        Blog.countDocuments(filter),
    ]);

    res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    sendCollection(res, documents.map(toBlogSummary), buildPaginationMeta(pagination, total));
});
