// Public blog article — backs GET /api/blogs and GET /api/blogs/:slug
// (api/_lib/routes/content/blogs/*). Deliberately minimal: one flat
// collection, Markdown `content` rendered client-side by
// src/components/blog/BlogContent.js (never as raw HTML).
//
// Written to by scripts/seed-blog-post.js today; shaped so a future
// generator/admin tool can create documents as `draft` and later publish
// them by setting status + publishedAt — the public routes only ever
// return `published` documents.
const mongoose = require("mongoose");
const { Schema } = mongoose;

const BLOG_STATUSES = ["draft", "published"];

// Lowercase words joined by single hyphens. Excluding "--" is load-bearing,
// not cosmetic: vercel.json flattens /api/blogs/:slug into the single
// segment `blog--:slug`, and routeMatcher.js splits that on "--".
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const BlogSchema = new Schema(
    {
        title: { type: String, required: true, trim: true },
        slug: { type: String, required: true, unique: true, lowercase: true, trim: true, match: SLUG_PATTERN },
        excerpt: { type: String, required: true, trim: true },
        content: { type: String, required: true },
        // Site-relative path (e.g. "/purple_student_hero.jpg") or absolute URL.
        featuredImage: { type: String, default: null },
        status: { type: String, enum: BLOG_STATUSES, default: "draft" },
        publishedAt: { type: Date, default: null },
        // Optional search-engine overrides; the page falls back to title /
        // excerpt when absent. Limits are generous ceilings, not targets
        // (aim for ~60 / ~155 characters).
        seoTitle: { type: String, trim: true, maxlength: 90, default: null },
        metaDescription: { type: String, trim: true, maxlength: 200, default: null },
    },
    { timestamps: true }
);

// status + publishedAt: query pattern = "published articles, newest first" —
// the listing route's only query.
BlogSchema.index({ status: 1, publishedAt: -1 });

module.exports = mongoose.models.Blog || mongoose.model("Blog", BlogSchema);
module.exports.BLOG_STATUSES = BLOG_STATUSES;
module.exports.SLUG_PATTERN = SLUG_PATTERN;
