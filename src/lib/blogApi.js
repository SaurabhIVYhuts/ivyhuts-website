// Read-only client for the public blog API (api/_lib/routes/content/blogs/*).
// Unlike the fire-and-forget helpers in this folder, these ARE awaited by
// the blog pages, so they throw — with `status` set — for the pages to turn
// into an error or not-found state.
//
// TEMPORARY LOCAL FALLBACK: when the API returns no articles (empty database)
// or can't be reached (e.g. local dev without MongoDB), published articles
// from src/data/blogs.json are shown instead. The API always wins when it
// has data, so nothing is duplicated once the database is seeded. Remove
// this file's fallback (and src/data/blogs.json) once the database is live.
import localBlogs from "../data/blogs.json";

const publishedLocal = localBlogs
  .filter((b) => b.status === "published")
  .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

function toSummary({ content, status, ...summary }) {
  return summary;
}

async function getJson(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.success) {
    const err = new Error(body?.error?.message || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return body;
}

export async function fetchBlogs() {
  try {
    const body = await getJson("/api/blogs");
    const data = body.data || [];
    if (data.length > 0 || publishedLocal.length === 0) return data;
  } catch (err) {
    if (publishedLocal.length === 0) throw err;
    console.warn("[Blog] API unavailable, using local articles:", err.message);
  }
  return publishedLocal.map(toSummary);
}

export async function fetchBlog(slug) {
  try {
    const body = await getJson(`/api/blogs/${encodeURIComponent(slug)}`);
    return body.data;
  } catch (err) {
    const local = publishedLocal.find((b) => b.slug === slug);
    if (local) {
      const { status, ...blog } = local;
      return blog;
    }
    throw err;
  }
}

export function formatBlogDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

// ~200 words per minute, minimum 1.
export function readingMinutes(markdown) {
  const words = String(markdown || "").split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}
