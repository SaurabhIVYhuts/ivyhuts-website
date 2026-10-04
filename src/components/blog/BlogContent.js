import React from "react";
import { Link } from "react-router-dom";

/*  Renders a blog article's Markdown `content` as React elements. Covers
    the subset blog articles use — ## / ### headings, paragraphs, "* " / "- "
    bullet lists, "1. " numbered lists, pipe tables, **bold** and
    [text](url) links — without adding a Markdown package. Everything is
    built as React elements (never dangerouslySetInnerHTML), so stored
    content can't inject markup or scripts.  */

const BULLET = /^[*-]\s+(.*)$/;
const NUMBERED = /^\d+\.\s+(.*)$/;
const HEADING = /^(#{2,3})\s+(.*)$/;
const TABLE_ROW = /^\|.*\|$/;
const TABLE_DIVIDER = /^\|(\s*:?-+:?\s*\|)+$/;
const INLINE = /\*\*(.+?)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g;

function isSafeHref(href) {
  return /^(https?:\/\/|\/(?!\/)|#|mailto:)/i.test(href);
}

function renderInline(text, keyPrefix) {
  const out = [];
  let last = 0;
  let match;
  INLINE.lastIndex = 0;
  while ((match = INLINE.exec(text)) !== null) {
    if (match.index > last) out.push(text.slice(last, match.index));
    const key = `${keyPrefix}-${match.index}`;
    if (match[1] !== undefined) {
      out.push(<strong key={key}>{match[1]}</strong>);
    } else if (!isSafeHref(match[3])) {
      out.push(match[2]);
    } else if (match[3].startsWith("/")) {
      out.push(<Link key={key} to={match[3]}>{match[2]}</Link>);
    } else {
      out.push(<a key={key} href={match[3]} target="_blank" rel="noopener noreferrer">{match[2]}</a>);
    }
    last = INLINE.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function splitRow(line) {
  return line.slice(1, -1).split("|").map((cell) => cell.trim());
}

function parseBlocks(markdown) {
  const lines = String(markdown || "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (!line) { i++; continue; }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ type: heading[1].length === 2 ? "h2" : "h3", text: heading[2] });
      i++;
      continue;
    }

    const listType = BULLET.test(line) ? "ul" : NUMBERED.test(line) ? "ol" : null;
    if (listType) {
      const pattern = listType === "ul" ? BULLET : NUMBERED;
      const items = [];
      while (i < lines.length && pattern.test(lines[i].trim())) {
        items.push(pattern.exec(lines[i].trim())[1]);
        i++;
      }
      blocks.push({ type: listType, items });
      continue;
    }

    if (TABLE_ROW.test(line)) {
      const rows = [];
      while (i < lines.length && TABLE_ROW.test(lines[i].trim())) {
        const row = lines[i].trim();
        if (!TABLE_DIVIDER.test(row)) rows.push(splitRow(row));
        i++;
      }
      if (rows.length) blocks.push({ type: "table", head: rows[0], body: rows.slice(1) });
      continue;
    }

    const paragraph = [];
    while (i < lines.length) {
      const next = lines[i].trim();
      if (!next || HEADING.test(next) || BULLET.test(next) || NUMBERED.test(next) || TABLE_ROW.test(next)) break;
      paragraph.push(next);
      i++;
    }
    blocks.push({ type: "p", text: paragraph.join(" ") });
  }
  return blocks;
}

// "1. Choose a Convenient Location" -> "choose-a-convenient-location".
// Leading section numbers are dropped so ids stay stable if sections are
// renumbered. Used for heading anchors, the table of contents, and as the
// key for per-section extras (src/data/blogExtras.js).
export function slugifyHeading(text) {
  return String(text)
    .replace(/^\d+\.\s*/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Splits an article into the blocks before the first "## " heading (the
// introduction) and one section per "## " heading.
export function parseSections(markdown) {
  const intro = [];
  const sections = [];
  for (const block of parseBlocks(markdown)) {
    if (block.type === "h2") {
      sections.push({ id: slugifyHeading(block.text), title: block.text, blocks: [] });
    } else if (sections.length) {
      sections[sections.length - 1].blocks.push(block);
    } else {
      intro.push(block);
    }
  }
  return { intro, sections };
}

export function BlogBlocks({ blocks, keyPrefix = "b" }) {
  return blocks.map((block, idx) => renderBlock(block, `${keyPrefix}${idx}`));
}

function renderBlock(block, key) {
  switch (block.type) {
    case "h2": return <h2 key={key} id={slugifyHeading(block.text)}>{renderInline(block.text, key)}</h2>;
    case "h3": return <h3 key={key}>{renderInline(block.text, key)}</h3>;
    case "ul":
    case "ol": {
      const List = block.type;
      return (
        <List key={key}>
          {block.items.map((item, j) => <li key={j}>{renderInline(item, `${key}-${j}`)}</li>)}
        </List>
      );
    }
    case "table":
      return (
        <div key={key} className="blog-table-wrap">
          <table className="blog-table">
            <thead>
              <tr>{block.head.map((cell, j) => <th key={j} scope="col">{renderInline(cell, `${key}-h${j}`)}</th>)}</tr>
            </thead>
            <tbody>
              {block.body.map((row, r) => (
                <tr key={r}>{row.map((cell, j) => <td key={j}>{renderInline(cell, `${key}-${r}-${j}`)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    default:
      return <p key={key}>{renderInline(block.text, key)}</p>;
  }
}

// Renders a whole article as one flow (no per-section extras).
export default function BlogContent({ content }) {
  return (
    <div className="blog-content">
      <BlogBlocks blocks={parseBlocks(content)} />
    </div>
  );
}
