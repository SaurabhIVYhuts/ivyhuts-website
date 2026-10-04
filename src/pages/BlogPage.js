import React, { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Calendar } from "lucide-react";
import SiteNavbar from "../components/layout/SiteNavbar";
import SiteFooter from "../components/layout/SiteFooter";
import Seo from "../components/Seo";
import { fetchBlogs, formatBlogDate } from "../lib/blogApi";
import { getBlogExtras } from "../data/blogExtras";
import "./BlogPage.css";

export default function BlogPage() {
  const [blogs, setBlogs] = useState([]);
  const [status, setStatus] = useState("loading"); // loading | ready | error

  const load = useCallback(() => {
    let cancelled = false;
    setStatus("loading");
    fetchBlogs()
      .then((data) => { if (!cancelled) { setBlogs(data); setStatus("ready"); } })
      .catch((err) => {
        console.error("[Blog] Failed to load blogs:", err.message);
        if (!cancelled) setStatus("error");
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => load(), [load]);

  return (
    <div className="blog-page">
      <Seo
        title="Blog: Student Accommodation Guides & Tips"
        description="Practical guides for international students on choosing student accommodation abroad: location, budget, safety, contracts and more."
      />
      <SiteNavbar />

      <header className="blog-hero">
        <div className="blog-hero-inner">
          <p className="blog-eyebrow">IvyHuts Blog</p>
          <h1>Guides for Your Study Abroad Journey</h1>
          <p className="blog-hero-sub">
            Practical advice on finding the right student accommodation and settling into life abroad.
          </p>
        </div>
      </header>

      <main className="blog-main">
        {status === "loading" && (
          <div className="blog-state" role="status">
            <div className="route-loading-spinner" aria-hidden="true" />
            <p>Loading articles…</p>
          </div>
        )}

        {status === "error" && (
          <div className="blog-state" role="alert">
            <h2>We couldn't load the articles</h2>
            <p>Please check your connection and try again.</p>
            <button type="button" className="btn btn-secondary" onClick={load}>Try again</button>
          </div>
        )}

        {status === "ready" && blogs.length === 0 && (
          <div className="blog-state">
            <h2>No articles yet</h2>
            <p>New guides are on the way. Check back soon.</p>
          </div>
        )}

        {status === "ready" && blogs.length > 0 && (
          <div className="blog-grid">
            {blogs.map((blog, index) => {
              const href = `/blog/${blog.slug}`;
              const featured = index === 0;
              const extras = getBlogExtras(blog.slug);
              const image = extras?.hero?.src || blog.featuredImage;
              return (
                <article key={blog.id} className={`blog-card${featured ? " blog-card--featured" : ""}`}>
                  <Link to={href} className="blog-card-media" tabIndex={-1} aria-hidden="true">
                    {image
                      ? <img src={image} alt={extras?.hero?.alt || blog.title} loading={featured ? "eager" : "lazy"} />
                      : <span className="blog-card-media-fallback" />}
                  </Link>
                  <div className="blog-card-body">
                    <div className="blog-card-tags">
                      {featured && <span className="blog-card-badge">Latest article</span>}
                      {extras?.category && <span className="blog-card-category">{extras.category}</span>}
                    </div>
                    {blog.publishedAt && (
                      <p className="blog-meta">
                        <Calendar size={14} aria-hidden="true" />
                        <time dateTime={blog.publishedAt}>{formatBlogDate(blog.publishedAt)}</time>
                      </p>
                    )}
                    <h2 className="blog-card-title"><Link to={href}>{blog.title}</Link></h2>
                    <p className="blog-card-excerpt">{blog.excerpt}</p>
                    <Link to={href} className={`btn btn-primary ${featured ? "" : "btn-sm "}blog-card-btn`} aria-label={`Read article: ${blog.title}`}>
                      Read Article <ArrowRight size={16} aria-hidden="true" />
                    </Link>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </main>

      <SiteFooter />
    </div>
  );
}
