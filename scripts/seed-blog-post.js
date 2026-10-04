#!/usr/bin/env node
// Inserts the launch blog article into the `blogs` collection of the
// EXISTING database (whatever MONGODB_URI points at — loaded from
// .env.local/.env, same convention as scripts/local-api-server.js).
//
// SAFETY — insert-only and idempotent:
//   • A single updateOne({ slug }, { $setOnInsert }, { upsert: true }).
//     If a blog with this slug already exists, NOTHING is written — the
//     existing document is never modified, overwritten or duplicated.
//   • No deletes, drops, or writes to any other collection.
//   • The document is validated against the Blog schema BEFORE connecting.
//   • MONGODB_URI itself is never printed (it embeds credentials) — only
//     the database name, so you can confirm the target before it writes.
//
// Usage:
//   node scripts/seed-blog-post.js            # insert if missing
//   node scripts/seed-blog-post.js --dry-run  # validate only, no connection
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
require("dotenv").config({ path: path.join(ROOT, ".env.local") });
require("dotenv").config({ path: path.join(ROOT, ".env") });

const mongoose = require("mongoose");
const Blog = require("../api/_lib/models/Blog");

const SLUG = "how-to-choose-student-accommodation-abroad";

const POST = {
    title: "How to Choose the Right Student Accommodation Abroad: A Complete Guide",
    slug: SLUG,
    excerpt:
        "Moving abroad to study? Learn how to choose student accommodation abroad, from location and budget to safety, room types, amenities and contracts.",
    seoTitle: "How to Choose Student Accommodation Abroad",
    metaDescription:
        "Learn how to choose student accommodation abroad: location, budget, safety, room types, amenities and contracts, plus a checklist to compare before you book.",
    content: fs.readFileSync(path.join(__dirname, "blog-content", `${SLUG}.md`), "utf8").trim(),
    featuredImage: "/images/blog/how-to-choose-student-accommodation-abroad/hero-campus.jpg",
    status: "published",
};

async function main() {
    const dryRun = process.argv.includes("--dry-run");

    try {
        await new Blog({ ...POST, publishedAt: new Date() }).validate();
    } catch (validationError) {
        console.error("[seed-blog] Schema validation FAILED:", validationError.message);
        process.exit(1);
    }
    console.log(`[seed-blog] Schema validation passed (${POST.content.length} chars of content).`);
    if (dryRun) {
        console.log("[seed-blog] --dry-run: not connecting, nothing written.");
        return;
    }

    // Reuses the app's own connection module (same pool options, same
    // never-log-the-URI behaviour).
    const { connectToDatabase, disconnectFromDatabase } = require("../api/_lib/mongodb");
    try {
        await connectToDatabase();
        console.log(`[seed-blog] Connected to database "${mongoose.connection.name}".`);

        // timestamps: false — Mongoose otherwise adds `$set: { updatedAt }`
        // to every updateOne, which would touch an EXISTING document on a
        // re-run. Timestamps are set inside $setOnInsert instead, so they're
        // written only when the document is actually created.
        const now = new Date();
        const result = await Blog.updateOne(
            { slug: SLUG },
            { $setOnInsert: { ...POST, publishedAt: now, createdAt: now, updatedAt: now } },
            { upsert: true, runValidators: true, timestamps: false }
        );

        if (result.upsertedCount === 1) {
            console.log(`[seed-blog] Inserted blog "${SLUG}" (id ${result.upsertedId}).`);
        } else {
            console.log(`[seed-blog] Blog "${SLUG}" already exists — left unchanged, nothing written.`);
        }
        const count = await Blog.countDocuments({ slug: SLUG });
        console.log(`[seed-blog] Documents with this slug: ${count}.`);
    } finally {
        await disconnectFromDatabase();
    }
}

main().catch((err) => {
    console.error("[seed-blog] FAILED:", err.message);
    process.exit(1);
});
