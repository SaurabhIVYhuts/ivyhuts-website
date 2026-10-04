import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowRight, Calendar, ChevronRight, Clock, Lightbulb, MessageCircle, RefreshCw } from "lucide-react";
import SiteNavbar from "../components/layout/SiteNavbar";
import SiteFooter from "../components/layout/SiteFooter";
import Seo, { CANONICAL_ORIGIN } from "../components/Seo";
import { BlogBlocks, parseSections } from "../components/blog/BlogContent";
import BlogToc from "../components/blog/BlogToc";
import BlogFaq from "../components/blog/BlogFaq";
import NotFoundPage from "./NotFoundPage";
import { fetchBlog, fetchBlogs, formatBlogDate, readingMinutes } from "../lib/blogApi";
import { getBlogExtras } from "../data/blogExtras";
import "./BlogPage.css";

// Shown under "Keep Exploring" when there are no other articles yet —
// existing IvyHuts routes only.
const EXPLORE_LINKS = [
  { to: "/university-housing", title: "University Housing", text: "Find student accommodation near your university." },
  { to: "/student-planner", title: "Student Planner", text: "Plan your study abroad budget and options." },
  { to: "/life-abroad", title: "Placement Podcast", text: "Hear real stories from students living abroad." },
];

const DAY_MS = 24 * 60 * 60 * 1000;

function Figure({ image, priority = false, className = "" }) {
  return (
    <figure className={`blog-figure ${className}`}>
      <img
        src={image.src}
        alt={image.alt}
        width={image.width || 1200}
        height={image.height || 800}
        loading={priority ? "eager" : "lazy"}
        decoding="async"
        {...(priority ? { fetchPriority: "high" } : {})}
      />
      {/* Shown only when the image's licence requires visible attribution
          (credit.required) — e.g. not for Unsplash photos. */}
      {image.credit?.required && (
        <figcaption>
          Photo: <a href={image.credit.url} target="_blank" rel="noopener noreferrer">{image.credit.name}</a> on {image.credit.source}
        </figcaption>
      )}
    </figure>
  );
}

function TipBox({ tip }) {
  return (
    <aside className="blog-tip">
      <span className="blog-tip-icon" aria-hidden="true"><Lightbulb size={18} /></span>
      <div>
        <p className="blog-tip-title">{tip.title}</p>
        <p className="blog-tip-text">{tip.text}</p>
      </div>
    </aside>
  );
}

function ArticleSection({ section, extra }) {
  const [firstBlock, ...rest] = section.blocks;
  // The image sits after the section's opening paragraph so the heading and
  // its lead sentence stay together.
  const imageAfterFirst = extra?.image && firstBlock?.type === "p";

  if (extra?.variant === "cta") {
    return (
      <section className="blog-section blog-help" aria-labelledby={section.id}>
        <h2 id={section.id}>{section.title}</h2>
        <BlogBlocks blocks={section.blocks} keyPrefix={`${section.id}-`} />
        <div className="blog-help-actions">
          <Link to="/university-housing" className="btn btn-primary">
            Explore University Housing <ArrowRight size={16} aria-hidden="true" />
          </Link>
          <Link to="/contact" className="btn btn-outline">
            <MessageCircle size={16} aria-hidden="true" /> Talk to Our Team
          </Link>
        </div>
      </section>
    );
  }

  return (
    <section className="blog-section" aria-labelledby={section.id}>
      <h2 id={section.id}>{section.title}</h2>
      {imageAfterFirst ? (
        <>
          <BlogBlocks blocks={[firstBlock]} keyPrefix={`${section.id}-a`} />
          <Figure image={extra.image} />
          <BlogBlocks blocks={rest} keyPrefix={`${section.id}-b`} />
        </>
      ) : (
        <>
          {extra?.image && <Figure image={extra.image} />}
          <BlogBlocks blocks={section.blocks} keyPrefix={`${section.id}-`} />
        </>
      )}
      {extra?.tip && <TipBox tip={extra.tip} />}
    </section>
  );
}

function RelatedSection({ currentSlug }) {
  const [related, setRelated] = useState([]);
  useEffect(() => {
    let cancelled = false;
    fetchBlogs()
      .then((all) => { if (!cancelled) setRelated(all.filter((b) => b.slug !== currentSlug).slice(0, 3)); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [currentSlug]);

  if (related.length) {
    return (
      <section className="blog-related" aria-labelledby="related-heading">
        <h2 id="related-heading">Related Blogs</h2>
        <div className="blog-related-grid">
          {related.map((b) => {
            const image = getBlogExtras(b.slug)?.hero?.src || b.featuredImage;
            return (
              <Link key={b.id} to={`/blog/${b.slug}`} className="blog-related-card">
                <span className="blog-related-media">
                  {image ? <img src={image} alt="" loading="lazy" /> : <span className="blog-card-media-fallback" />}
                </span>
                <span className="blog-related-body">
                  <span className="blog-related-date">{formatBlogDate(b.publishedAt)}</span>
                  <span className="blog-related-title">{b.title}</span>
                </span>
              </Link>
            );
          })}
        </div>
      </section>
    );
  }

  return (
    <section className="blog-related" aria-labelledby="related-heading">
      <h2 id="related-heading">Keep Exploring</h2>
      <p className="blog-related-sub">More articles are on the way. In the meantime, these IvyHuts tools can help you plan your move.</p>
      <div className="blog-related-grid">
        {EXPLORE_LINKS.map((l) => (
          <Link key={l.to} to={l.to} className="blog-explore-card">
            <span className="blog-related-title">{l.title}</span>
            <span className="blog-explore-text">{l.text}</span>
            <span className="blog-explore-link">Explore <ArrowRight size={14} aria-hidden="true" /></span>
          </Link>
        ))}
      </div>
    </section>
  );
}

export default function BlogPostPage() {
  const { slug } = useParams();
  const [blog, setBlog] = useState(null);
  const [status, setStatus] = useState("loading"); // loading | ready | notfound | error

  const load = useCallback(() => {
    let cancelled = false;
    setStatus("loading");
    fetchBlog(slug)
      .then((data) => { if (!cancelled) { setBlog(data); setStatus("ready"); } })
      .catch((err) => {
        if (cancelled) return;
        if (err.status === 404) { setStatus("notfound"); return; }
        console.error("[Blog] Failed to load blog:", err.message);
        setStatus("error");
      });
    return () => { cancelled = true; };
  }, [slug]);

  useEffect(() => load(), [load]);

  // The article renders after the fetch, so the browser's own #anchor scroll
  // on page load finds nothing — redo it once the sections exist (shared TOC
  // links like /blog/<slug>#check-safety-and-security).
  useEffect(() => {
    if (status !== "ready") return;
    const id = decodeURIComponent(window.location.hash.slice(1));
    if (id) requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView());
  }, [status]);

  const extras = getBlogExtras(slug);
  const parsed = useMemo(() => (blog ? parseSections(blog.content) : null), [blog]);

  // Section extras are keyed by heading id, so renaming a "## " heading
  // silently drops its image/tip unless blogExtras.js is updated too.
  useEffect(() => {
    if (process.env.NODE_ENV !== "development" || !parsed || !extras?.sections) return;
    const ids = new Set(parsed.sections.map((s) => s.id));
    const orphans = Object.keys(extras.sections).filter((k) => !ids.has(k));
    if (orphans.length) console.warn("[Blog] blogExtras keys with no matching heading:", orphans);
  }, [parsed, extras]);
  const tocItems = useMemo(() => {
    if (!parsed) return [];
    const items = parsed.sections.map((s) => ({ id: s.id, label: s.title }));
    if (extras?.faqs?.length) items.push({ id: "faqs", label: "FAQs" });
    return items;
  }, [parsed, extras]);

  // Reuses the site's real not-found page (noindex + its own nav/footer).
  if (status === "notfound") return <NotFoundPage />;

  const hero = extras?.hero || (blog?.featuredImage ? { src: blog.featuredImage, alt: "", width: 1600, height: 900 } : null);
  const ogImage = hero ? (hero.src.startsWith("http") ? hero.src : `${CANONICAL_ORIGIN}${hero.src}`) : undefined;
  const updated = blog?.updatedAt && blog?.publishedAt && new Date(blog.updatedAt) - new Date(blog.publishedAt) > DAY_MS;
  const [lead, ...introRest] = parsed?.intro || [];

  return (
    <div className="blog-page blog-page--article">
      {status === "ready" && blog
        ? <Seo title={blog.seoTitle || blog.title} description={blog.metaDescription || blog.excerpt} image={ogImage} type="article" />
        : <Seo title="Blog" />}
      <SiteNavbar />

      <main className="blog-article-main">
        {status === "loading" && (
          <div className="blog-state" role="status">
            <div className="route-loading-spinner" aria-hidden="true" />
            <p>Loading article…</p>
          </div>
        )}

        {status === "error" && (
          <div className="blog-state" role="alert">
            <h2>We couldn't load this article</h2>
            <p>Please check your connection and try again.</p>
            <button type="button" className="btn btn-secondary" onClick={load}>Try again</button>
          </div>
        )}

        {status === "ready" && blog && parsed && (
          <article className="blog-article">
            <header className="blog-article-header">
              <nav className="blog-breadcrumb" aria-label="Breadcrumb">
                <ol>
                  <li><Link to="/">Home</Link><ChevronRight size={14} aria-hidden="true" /></li>
                  <li><Link to="/blog">Blog</Link><ChevronRight size={14} aria-hidden="true" /></li>
                  <li aria-current="page">{blog.title}</li>
                </ol>
              </nav>
              {extras?.category && <span className="blog-category">{extras.category}</span>}
              <h1>{blog.title}</h1>
              <p className="blog-meta blog-article-meta">
                {blog.publishedAt && (
                  <span className="blog-meta-item">
                    <Calendar size={15} aria-hidden="true" />
                    Published <time dateTime={blog.publishedAt}>{formatBlogDate(blog.publishedAt)}</time>
                  </span>
                )}
                {updated && (
                  <span className="blog-meta-item">
                    <RefreshCw size={15} aria-hidden="true" />
                    Updated <time dateTime={blog.updatedAt}>{formatBlogDate(blog.updatedAt)}</time>
                  </span>
                )}
                <span className="blog-meta-item">
                  <Clock size={15} aria-hidden="true" />
                  {readingMinutes(blog.content)} min read
                </span>
              </p>
            </header>

            {hero && <Figure image={hero} priority className="blog-hero-figure" />}

            <div className="blog-article-layout">
              <aside className="blog-article-aside">
                <BlogToc items={tocItems} variant="sidebar" />
              </aside>

              <div className="blog-content blog-article-body">
                {lead && <div className="blog-lead"><BlogBlocks blocks={[lead]} keyPrefix="lead" /></div>}
                <BlogBlocks blocks={introRest} keyPrefix="intro" />

                <BlogToc items={tocItems} variant="inline" />

                {parsed.sections.map((section) => (
                  <ArticleSection key={section.id} section={section} extra={extras?.sections?.[section.id]} />
                ))}

                <BlogFaq faqs={extras?.faqs} />

                <section className="blog-cta" aria-labelledby="blog-cta-heading">
                  <h2 id="blog-cta-heading">Ready to Find Your Student Home?</h2>
                  <Link to="/university-housing" className="btn btn-lg blog-cta-btn">
                    Explore Accommodation <ArrowRight size={18} aria-hidden="true" />
                  </Link>
                </section>
              </div>
            </div>

            <RelatedSection currentSlug={blog.slug} />
          </article>
        )}
      </main>

      <SiteFooter />
    </div>
  );
}
