import React, { useEffect, useState } from "react";
import { ChevronDown, List } from "lucide-react";

/*  Article table of contents. `variant="sidebar"` is the sticky desktop
    version (highlights the section currently on screen); `variant="inline"`
    is the collapsible mobile/tablet version shown after the introduction.
    CSS shows exactly one of the two per breakpoint (see BlogPage.css).  */

function useActiveSection(ids) {
  const [active, setActive] = useState(ids[0] || null);
  useEffect(() => {
    if (!ids.length || typeof IntersectionObserver === "undefined") return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      // A heading counts as "current" once it reaches the top ~third of the viewport.
      { rootMargin: "-90px 0px -65% 0px" }
    );
    ids.forEach((id) => {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    });
    return () => observer.disconnect();
  }, [ids]);
  return active;
}

function scrollToId(e, id, onDone) {
  const el = document.getElementById(id);
  if (!el) return;
  e.preventDefault();
  el.scrollIntoView({ behavior: "smooth", block: "start" });
  window.history.replaceState(null, "", `#${id}`);
  if (onDone) onDone();
}

function TocList({ items, active, onNavigate }) {
  return (
    <ol className="blog-toc-list">
      {items.map((item) => (
        <li key={item.id}>
          <a
            href={`#${item.id}`}
            className={active === item.id ? "is-active" : undefined}
            aria-current={active === item.id ? "location" : undefined}
            onClick={(e) => scrollToId(e, item.id, onNavigate)}
          >
            {item.label}
          </a>
        </li>
      ))}
    </ol>
  );
}

export default function BlogToc({ items, variant }) {
  const ids = React.useMemo(() => items.map((i) => i.id), [items]);
  const active = useActiveSection(variant === "sidebar" ? ids : []);
  const [open, setOpen] = useState(false);

  if (!items.length) return null;

  if (variant === "sidebar") {
    return (
      <nav className="blog-toc blog-toc--sidebar" aria-label="Table of contents">
        <p className="blog-toc-title"><List size={16} aria-hidden="true" /> In this guide</p>
        <TocList items={items} active={active} />
      </nav>
    );
  }

  return (
    <nav className="blog-toc blog-toc--inline" aria-label="Table of contents">
      <button
        type="button"
        className="blog-toc-toggle"
        aria-expanded={open}
        aria-controls="blog-toc-inline-list"
        onClick={() => setOpen((o) => !o)}
      >
        <span><List size={16} aria-hidden="true" /> Table of contents</span>
        <ChevronDown size={18} className={open ? "is-open" : undefined} aria-hidden="true" />
      </button>
      <div id="blog-toc-inline-list" hidden={!open}>
        <TocList items={items} active={null} onNavigate={() => setOpen(false)} />
      </div>
    </nav>
  );
}
