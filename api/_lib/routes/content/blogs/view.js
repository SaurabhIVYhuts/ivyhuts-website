// Public-safe JSON shapes for Blog documents — same role as
// api/_lib/enquiryView.js et al.: an explicit field allowlist, so a field
// added to the model later is never exposed by accident.
function toBlogSummary(doc) {
    return {
        id: String(doc._id),
        title: doc.title,
        slug: doc.slug,
        excerpt: doc.excerpt,
        featuredImage: doc.featuredImage || null,
        publishedAt: doc.publishedAt,
    };
}

function toBlogDetail(doc) {
    return {
        ...toBlogSummary(doc),
        content: doc.content,
        seoTitle: doc.seoTitle || null,
        metaDescription: doc.metaDescription || null,
        updatedAt: doc.updatedAt,
    };
}

module.exports = { toBlogSummary, toBlogDetail };
