import { useEffect } from "react";
import { useLocation } from "react-router-dom";

/*  ── PER-ROUTE SEO / <head> METADATA ──────────────────────────────────────
    This is a client-rendered CRA app: every URL is served the SAME
    public/index.html shell, so without this component every page in Google's
    index carried the identical <title>/description and no canonical. That is
    exactly what Search Console was reporting:
      • "Crawled - currently not indexed"  → duplicate title/description, no canonical
      • "Soft 404"                         → thin/empty pages returning HTTP 200

    Googlebot (evergreen Chromium) executes this JS and waits for the page to
    settle before snapshotting, so updating the tags here is enough to give
    each route a real identity. This does NOT replace true server-side
    rendering / prerendering — see the PR note — but it resolves the
    reported buckets.

    Implementation is imperative (find-or-create each tag) rather than JSX so
    there is always exactly ONE of each tag: the static fallbacks already in
    index.html are updated in place, never duplicated. `noindex` is honoured
    by Google even when applied via JS.
*/

export const CANONICAL_ORIGIN = "https://www.ivyhuts.com";

const DEFAULT_TITLE = "IVYhuts: Student Accommodation Abroad";
const DEFAULT_DESCRIPTION =
  "IVYhuts helps international students find verified, affordable student accommodation abroad. Free to use. No hidden fees. 15+ countries, 50+ cities.";
const DEFAULT_IMAGE = `${CANONICAL_ORIGIN}/hero.png`;

function upsertMeta(attr, key, content) {
  let el = document.head.querySelector(`meta[${attr}="${key}"]`);
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute(attr, key);
    document.head.appendChild(el);
  }
  el.setAttribute("content", content);
}

function upsertLink(rel, href) {
  let el = document.head.querySelector(`link[rel="${rel}"]`);
  if (!el) {
    el = document.createElement("link");
    el.setAttribute("rel", rel);
    document.head.appendChild(el);
  }
  el.setAttribute("href", href);
}

/*  Build an absolute canonical URL. Pass an explicit `canonical` (path or
    full URL) to override; otherwise the current pathname is used WITHOUT its
    query string — the right default for every static route. Pages whose
    query string is meaningful (PropertyListingPage's ?city=) pass an
    explicit canonical carrying only the significant params.  */
function resolveCanonical(canonical, pathname) {
  if (canonical) {
    return canonical.startsWith("http") ? canonical : `${CANONICAL_ORIGIN}${canonical}`;
  }
  return `${CANONICAL_ORIGIN}${pathname === "/" ? "/" : pathname.replace(/\/$/, "")}`;
}

export default function Seo({
  title,
  description = DEFAULT_DESCRIPTION,
  canonical,
  noindex = false,
  image = DEFAULT_IMAGE,
  type = "website",
}) {
  const { pathname } = useLocation();
  const fullTitle = title
    ? (title.includes("IVYhuts") ? title : `${title} | IVYhuts`)
    : DEFAULT_TITLE;
  const canonicalUrl = resolveCanonical(canonical, pathname);

  useEffect(() => {
    document.title = fullTitle;
    upsertMeta("name", "description", description);
    upsertMeta("name", "robots", noindex ? "noindex, follow" : "index, follow");
    upsertLink("canonical", canonicalUrl);
    upsertMeta("property", "og:title", fullTitle);
    upsertMeta("property", "og:description", description);
    upsertMeta("property", "og:url", canonicalUrl);
    upsertMeta("property", "og:type", type);
    upsertMeta("property", "og:image", image);
    upsertMeta("name", "twitter:card", "summary_large_image");
    upsertMeta("name", "twitter:title", fullTitle);
    upsertMeta("name", "twitter:description", description);
    upsertMeta("name", "twitter:image", image);
  }, [fullTitle, description, canonicalUrl, noindex, image, type]);

  return null;
}
