// Student Plan PPT -- Design System.
//
// A small set of reusable visual primitives that every slide in
// ./pptBuilder.js is built from, so the deck reads as ONE consistent,
// premium presentation rather than independently-styled slides. Change a
// radius, a spacing value, or a type size here ONCE and it propagates to
// every slide that uses these primitives -- no per-slide magic numbers.
//
// Pure presentation. Takes no planner data, makes no decisions about what
// content to show -- ./pptBuilder.js's slide functions decide WHAT to show,
// this module only decides HOW it looks.
//
// Font: "Segoe UI" rather than IVYHUTS's web brand font ("Plus Jakarta
// Sans"). Plus Jakarta Sans is a Google Font -- pptxgenjs only writes a
// fontFace NAME into the XML, it never embeds or fetches the font, so a
// viewer without that font installed would silently fall back to whatever
// PowerPoint substitutes (inconsistently, machine to machine). Segoe UI is
// the default Windows/Office UI font and is reliably present everywhere
// PowerPoint itself runs -- the "PowerPoint-safe font stack" the design
// brief calls for. This is a presentation-layer decision only; the website
// keeps using Plus Jakarta Sans (src/styles/global.css is untouched).
"use strict";

// ---- Brand palette (hex, no '#') -- unchanged from src/styles/global.css ----
const COLORS = {
    purple: "5E3A6B",
    purpleDeep: "3A2442",
    rose: "B07898",
    gold: "C8960C",
    goldLight: "F5D978",
    ink: "3A2442",
    inkSoft: "6B4E5E",
    inkFaint: "A68E9B",
    surface: "FBF4F8",
    white: "FFFFFF",
    success: "1E7B4D",
    warning: "B0752B",
    border: "E4CFDC",
    track: "EFDEE7",
};

const FONT = "Segoe UI";

// Strict type scale (pt) -- see this module's own header for why a single
// scale, used everywhere, is the point.
const TYPE = {
    coverTitle: 40,
    coverLabel: 13,
    slideTitle: 29,
    sectionLabel: 11,
    metricLarge: 32,
    cardTitle: 18,
    valueImportant: 24,
    body: 15,
    secondary: 12,
    table: 13,
};

// ---- Page geometry: 16:9 widescreen, designed for 1920x1080 ----
const PAGE_W = 13.333;
const PAGE_H = 7.5;
const MARGIN = 0.6;
const CONTENT_W = PAGE_W - MARGIN * 2; // 12.133in
const CONTENT_TOP = 2.0; // fixed on every content slide -- same content start line everywhere
const CONTENT_BOTTOM = 6.95; // fixed footer rule position
const CONTENT_H = CONTENT_BOTTOM - CONTENT_TOP; // 4.95in usable body height
const GUTTER = 0.28;

const RADIUS_CARD = 0.1;
const RADIUS_PILL = 0.5; // large enough to always fully round a pill's short edge

// One shared "shadow" decision: NONE. Flat cards + a single hairline border
// color (COLORS.border) separate surfaces consistently everywhere, rather
// than mixing shadowed and unshadowed cards (plan item 30 -- avoid
// excessive shadows; plan item 20 -- one border style, not several).
const CARD_LINE = { color: COLORS.border, width: 1 };

function truncate(text, maxLen) {
    if (typeof text !== "string") return "";
    if (text.length <= maxLen) return text;
    const ellipsis = "...";
    return `${text.slice(0, Math.max(0, maxLen - ellipsis.length)).trimEnd()}${ellipsis}`;
}

// ---- Slide frame: the consistent top/bottom chrome every content slide shares ----
// TOP: small purple section-label pill + large slide title + optional
// one-line description + a hairline rule. BOTTOM (via footer()): a second
// hairline rule + understated wordmark + page number. Returns the slide and
// the fixed y-coordinate (CONTENT_TOP) every slide's main content starts at.
function frame(pptx, { sectionLabel, title }) {
    const slide = pptx.addSlide();
    slide.background = { color: COLORS.surface };

    slide.addText(
        [{ text: "IVY", options: { color: COLORS.purple, bold: true } }, { text: "huts", options: { color: COLORS.gold, bold: true } }],
        { x: PAGE_W - MARGIN - 1.6, y: 0.42, w: 1.6, h: 0.32, fontSize: 12.5, align: "right", fontFace: FONT }
    );

    if (sectionLabel) {
        const labelText = sectionLabel.toUpperCase();
        const labelW = Math.min(3.4, labelText.length * 0.1 + 0.5);
        slide.addShape("roundRect", { x: MARGIN, y: 0.5, w: labelW, h: 0.32, rectRadius: 0.16, fill: { color: COLORS.purple } });
        slide.addText(labelText, {
            x: MARGIN, y: 0.5, w: labelW, h: 0.32, fontSize: TYPE.sectionLabel, bold: true,
            color: COLORS.goldLight, align: "center", valign: "middle", charSpacing: 1.5, fontFace: FONT,
        });
    }

    slide.addText(title, { x: MARGIN, y: 0.88, w: CONTENT_W - 1.8, h: 0.6, fontSize: TYPE.slideTitle, bold: true, color: COLORS.ink, fontFace: FONT });
    slide.addShape("line", { x: MARGIN, y: 1.78, w: CONTENT_W, h: 0, line: { color: COLORS.border, width: 1 } });

    return { slide, contentTop: CONTENT_TOP };
}

function footer(slide, pageNum, totalPages) {
    slide.addShape("line", { x: MARGIN, y: CONTENT_BOTTOM, w: CONTENT_W, h: 0, line: { color: COLORS.border, width: 0.75 } });
    slide.addText("IVYHUTS  ·  Housing to Hiring", { x: MARGIN, y: CONTENT_BOTTOM + 0.08, w: 6, h: 0.3, fontSize: 9.5, color: COLORS.inkFaint, fontFace: FONT });
    slide.addText(`${pageNum} / ${totalPages}`, { x: PAGE_W - MARGIN - 1.0, y: CONTENT_BOTTOM + 0.08, w: 1.0, h: 0.3, fontSize: 9.5, color: COLORS.inkFaint, align: "right", fontFace: FONT });
}

// ---- Metric card: one large emphasized number (e.g. "Estimated / Month") ----
function metricCard(slide, { x, y, w, h, label, value, sublabel, tone = "outline" }) {
    const solid = tone === "solid";
    slide.addShape("roundRect", {
        x, y, w, h, rectRadius: RADIUS_CARD,
        fill: { color: solid ? COLORS.purple : COLORS.white },
        line: solid ? undefined : CARD_LINE,
    });
    const pad = 0.24;
    slide.addText(label.toUpperCase(), {
        x: x + pad, y: y + pad, w: w - pad * 2, h: 0.28, fontSize: TYPE.sectionLabel, bold: true,
        color: solid ? COLORS.goldLight : COLORS.inkFaint, charSpacing: 1, fontFace: FONT,
    });
    slide.addText(value, {
        x: x + pad, y: y + pad + 0.3, w: w - pad * 2, h: h - pad * 2 - (sublabel ? 0.6 : 0.3), fontSize: TYPE.metricLarge, bold: true,
        color: solid ? COLORS.white : COLORS.purple, fontFace: FONT, valign: "top",
    });
    if (sublabel) {
        slide.addText(sublabel, {
            x: x + pad, y: y + h - pad - 0.28, w: w - pad * 2, h: 0.28, fontSize: 11,
            color: solid ? "E8D8E3" : COLORS.inkFaint, fontFace: FONT,
        });
    }
}

// ---- Info card: a titled white card with a short body or bullet items ----
function infoCard(slide, { x, y, w, h, title, body, items }) {
    slide.addShape("roundRect", { x, y, w, h, rectRadius: RADIUS_CARD, fill: { color: COLORS.white }, line: CARD_LINE });
    const pad = 0.22;
    slide.addText(title.toUpperCase(), { x: x + pad, y: y + pad, w: w - pad * 2, h: 0.28, fontSize: TYPE.sectionLabel, bold: true, color: COLORS.rose, charSpacing: 1, fontFace: FONT });
    if (body) {
        slide.addText(body, { x: x + pad, y: y + pad + 0.32, w: w - pad * 2, h: h - pad * 2 - 0.32, fontSize: TYPE.body, color: COLORS.inkSoft, fontFace: FONT, valign: "top", lineSpacingMultiple: 1.25 });
    } else if (items && items.length > 0) {
        slide.addText(
            items.map((item) => ({ text: item, options: { bullet: { code: "2022", color: COLORS.rose }, breakLine: true } })),
            { x: x + pad, y: y + pad + 0.34, w: w - pad * 2, h: h - pad * 2 - 0.34, fontSize: TYPE.body, color: COLORS.inkSoft, fontFace: FONT, valign: "top", lineSpacingMultiple: 1.3 }
        );
    }
}

// ---- Pill: small rounded badge, auto-width unless w given ----
function pill(slide, { x, y, w, h = 0.32, text, fill = COLORS.purple, textColor = COLORS.white, fontSize = 10.5 }) {
    const pillW = w || Math.min(3.6, text.length * 0.082 + 0.36);
    slide.addShape("roundRect", { x, y, w: pillW, h, rectRadius: h / 2, fill: { color: fill } });
    slide.addText(text.toUpperCase(), { x, y, w: pillW, h, fontSize, bold: true, color: textColor, align: "center", valign: "middle", charSpacing: 0.6, fontFace: FONT });
    return pillW;
}

// ---- Progress bar: track + proportional fill, optional trailing value label ----
function progressBar(slide, { x, y, w, h = 0.14, value, max = 100, fillColor = COLORS.purple, trackColor = COLORS.track }) {
    const ratio = Math.max(0, Math.min(1, (Number(value) || 0) / max));
    slide.addShape("roundRect", { x, y, w, h, rectRadius: h / 2, fill: { color: trackColor } });
    if (ratio > 0) {
        slide.addShape("roundRect", { x, y, w: Math.max(h, w * ratio), h, rectRadius: h / 2, fill: { color: fillColor } });
    }
}

// ---- Numbered circle badge (rank markers, timeline steps) ----
function numberBadge(slide, { x, y, d = 0.42, text, fill = COLORS.purple, textColor = COLORS.white, fontSize = 14 }) {
    slide.addShape("ellipse", { x, y, w: d, h: d, fill: { color: fill } });
    slide.addText(String(text), { x, y, w: d, h: d, fontSize, bold: true, color: textColor, align: "center", valign: "middle", fontFace: FONT });
}

// ---- Chip row: flows short labels (skills, technical areas) left-to-right,
// wrapping to additional rows -- a lightweight, deliberately approximate
// layout (no real text measurement exists in a PPTX generator), tuned with
// generous padding so chips never look clipped. Returns the y just below
// the last row actually used, so callers can stack content beneath it. ----
function chipRow(slide, items, { x, y, w, chipH = 0.34, fontSize = 11.5, fill = COLORS.surface, textColor = COLORS.purple, gap = 0.1, lineGap = 0.12 }) {
    if (!items || items.length === 0) return y;
    let cx = x;
    let cy = y;
    const maxX = x + w;
    items.forEach((item) => {
        const label = truncate(item, 28);
        const chipW = Math.min(w, label.length * fontSize * 0.0105 + 0.32);
        if (cx + chipW > maxX + 0.01 && cx > x) {
            cx = x;
            cy += chipH + lineGap;
        }
        slide.addShape("roundRect", { x: cx, y: cy, w: chipW, h: chipH, rectRadius: chipH / 2, fill: { color: fill } });
        slide.addText(label, { x: cx, y: cy, w: chipW, h: chipH, fontSize, bold: true, color: textColor, align: "center", valign: "middle", fontFace: FONT });
        cx += chipW + gap;
    });
    return cy + chipH;
}

// ---- Journey chain: N evenly-spaced nodes connected by one line, used by
// both the cover's mini-journey and the full dedicated Journey slide. ----
function journeyChain(slide, steps, { x, y, w, nodeD = 0.62, fontSize = 11, activeLast = true }) {
    const n = steps.length;
    const slotW = w / n;
    const lineY = y + nodeD / 2;
    slide.addShape("line", { x, y: lineY, w, h: 0, line: { color: COLORS.border, width: 2 } });
    steps.forEach((step, i) => {
        const cx = x + slotW * i + slotW / 2 - nodeD / 2;
        const isLast = activeLast && i === n - 1;
        slide.addShape("ellipse", { x: cx, y, w: nodeD, h: nodeD, fill: { color: isLast ? COLORS.gold : COLORS.purple } });
        slide.addText(String(i + 1), { x: cx, y, w: nodeD, h: nodeD, fontSize: fontSize + 1, bold: true, color: COLORS.white, align: "center", valign: "middle", fontFace: FONT });
        slide.addText(step, {
            x: x + slotW * i, y: y + nodeD + 0.1, w: slotW, h: 0.5, fontSize, bold: true,
            color: isLast ? COLORS.gold : COLORS.inkSoft, align: "center", fontFace: FONT, valign: "top",
        });
    });
}

module.exports = {
    COLORS, FONT, TYPE,
    PAGE_W, PAGE_H, MARGIN, CONTENT_W, CONTENT_TOP, CONTENT_BOTTOM, CONTENT_H, GUTTER,
    RADIUS_CARD, RADIUS_PILL, CARD_LINE,
    truncate,
    frame, footer, metricCard, infoCard, pill, progressBar, numberBadge, chipRow, journeyChain,
};
