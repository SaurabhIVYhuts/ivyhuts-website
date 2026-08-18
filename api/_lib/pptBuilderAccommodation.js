// Accommodation Presentation -- slide construction (Milestone 23.8).
//
// Consumes ONLY the already-normalized model from
// ./pptNormalizeAccommodation.js. Styled entirely through the SAME shared
// primitives every Student Plan slide already uses (./pptDesignSystem.js --
// see that module's own header comment: "a small set of reusable visual
// primitives", not private to ./pptBuilder.js's own slide functions), so an
// accommodation deck and a Student Plan deck read as the same visual
// product family. The slide *compositions* below are new -- the Student
// Plan's slide functions in ./pptBuilder.js are all specific to an
// unrelated content domain (career/degree/salary) and are neither called
// nor duplicated here.
//
// No network calls: property images are referenced by URL in the saved
// curation, but this module never fetches them (same "zero network calls,
// zero filesystem writes" rule ./pptBuilder.js's own header documents for
// the existing pipeline) -- a slide notes whether a photo exists online
// rather than embedding one, so nothing here can hang, fail, or leak SSRF
// exposure on a slow/hostile provider URL. Zero storage beyond the
// in-memory buffer this returns.
"use strict";

const PptxGenJS = require("pptxgenjs");
const DS = require("./pptDesignSystem");
const { NOT_AVAILABLE } = require("./pptNormalizeAccommodation");

const { COLORS, FONT, TYPE, PAGE_W, PAGE_H, MARGIN, CONTENT_W, CONTENT_TOP, CONTENT_BOTTOM, CONTENT_H, GUTTER, RADIUS_CARD, CARD_LINE, truncate } = DS;

const CONTACT = {
    email: "contact@ivyhuts.com",
    whatsapp: "+91 884 772 5089",
    website: "ivyhuts.com",
};

function wordmark(slide, { x, y, w, h, fontSize, align = "left" }) {
    slide.addText(
        [{ text: "IVY", options: { color: COLORS.purple, bold: true } }, { text: "huts", options: { color: COLORS.gold, bold: true } }],
        { x, y, w, h, fontSize, align, fontFace: FONT }
    );
}

// ---- Slide 1: Cover ----
function buildCoverSlide(pptx, n) {
    const slide = pptx.addSlide();
    slide.background = { color: COLORS.purpleDeep };

    slide.addText(
        [{ text: "IVY", options: { color: COLORS.white, bold: true } }, { text: "huts", options: { color: COLORS.goldLight, bold: true } }],
        { x: MARGIN, y: 0.55, w: 3, h: 0.4, fontSize: 18, fontFace: FONT }
    );

    const leftW = 8.5;
    slide.addText("ACCOMMODATION PRESENTATION", { x: MARGIN, y: 1.55, w: leftW, h: 0.32, fontSize: TYPE.coverLabel, bold: true, color: COLORS.gold, charSpacing: 2.5, fontFace: FONT });
    slide.addText("Your Personalized\nAccommodation Options", {
        x: MARGIN, y: 1.95, w: leftW, h: 1.9, fontSize: 36, bold: true, color: COLORS.white, fontFace: FONT, lineSpacingMultiple: 1.06,
    });
    slide.addShape("line", { x: MARGIN, y: 3.95, w: 0.7, h: 0, line: { color: COLORS.gold, width: 3 } });

    const infoRows = [];
    if (n.student.name) infoRows.push(["Student", n.student.name]);
    if (n.university.available) infoRows.push(["University", [n.university.name, n.university.location].filter(Boolean).join(" -- ")]);
    infoRows.forEach(([label, value], i) => {
        const y = 4.25 + i * 0.72;
        slide.addText(label.toUpperCase(), { x: MARGIN, y, w: leftW, h: 0.26, fontSize: 10.5, bold: true, color: COLORS.gold, charSpacing: 1.2, fontFace: FONT });
        slide.addText(truncate(value, 90), { x: MARGIN, y: y + 0.27, w: leftW, h: 0.4, fontSize: 17, bold: true, color: COLORS.white, fontFace: FONT });
    });

    slide.addText(
        "Prepared by IVYHUTS. Property details reflect the options curated for this student -- always confirm current availability and pricing with the provider before booking.",
        { x: MARGIN, y: PAGE_H - 0.55, w: 12.1, h: 0.4, fontSize: 9, color: "9C82A0", fontFace: FONT }
    );
    return slide;
}

// ---- Slide: Your Requirements ----
function buildRequirementsSlide(pptx, n, pageNum, totalPages) {
    const { slide } = DS.frame(pptx, { sectionLabel: "Requirements", title: "What We're Solving For" });
    const r = n.requirements;

    if (!r.available) {
        DS.infoCard(slide, { x: MARGIN, y: CONTENT_TOP, w: CONTENT_W, h: 1.2, title: "Requirements", body: NOT_AVAILABLE });
        DS.footer(slide, pageNum, totalPages);
        return slide;
    }

    const cards = [
        ["Budget", r.budgetLabel],
        ["Sharing", r.sharingLabel],
        ["Move-in Date", r.moveInDateLabel],
        ["Stay Duration", r.stayDurationLabel],
        ["Distance Preference", r.distancePreferenceLabel],
    ];
    const colW = (CONTENT_W - GUTTER * 2) / 3;
    const rowH = 1.35;
    cards.forEach(([label, value], i) => {
        const col = i % 3;
        const row = Math.floor(i / 3);
        DS.metricCard(slide, {
            x: MARGIN + col * (colW + GUTTER), y: CONTENT_TOP + row * (rowH + GUTTER), w: colW, h: rowH,
            label, value: truncate(value, 34), tone: row === 0 && col === 0 ? "solid" : "outline",
        });
    });

    if (r.amenities.length > 0) {
        const chipsY = CONTENT_TOP + 2 * (rowH + GUTTER) + 0.1;
        slide.addText("REQUESTED AMENITIES", { x: MARGIN, y: chipsY, w: CONTENT_W, h: 0.28, fontSize: TYPE.sectionLabel, bold: true, color: COLORS.rose, charSpacing: 1, fontFace: FONT });
        DS.chipRow(slide, r.amenities, { x: MARGIN, y: chipsY + 0.34, w: CONTENT_W });
    }
    DS.footer(slide, pageNum, totalPages);
    return slide;
}

// ---- Slide(s): Accommodation Options (one card per property, up to 3/slide) ----
function buildOptionCard(slide, p, { x, y, w, h }) {
    slide.addShape("roundRect", { x, y, w, h, rectRadius: RADIUS_CARD, fill: { color: COLORS.white }, line: CARD_LINE });
    const pad = 0.22;
    DS.pill(slide, { x: x + pad, y: y + pad, w: 1.9, h: 0.3, text: p.providerLabel, fill: COLORS.purple, fontSize: 9 });
    slide.addText(p.availabilityLabel, {
        x: x + w - pad - 1.6, y: y + pad, w: 1.6, h: 0.3, fontSize: 9.5, bold: true, align: "right",
        color: p.availabilityLabel === "Available" ? COLORS.success : (p.availabilityLabel === "Unavailable" ? "B03A3A" : COLORS.inkFaint), fontFace: FONT,
    });

    slide.addText(truncate(p.name, 46), { x: x + pad, y: y + pad + 0.4, w: w - pad * 2, h: 0.55, fontSize: TYPE.cardTitle, bold: true, color: COLORS.ink, fontFace: FONT, valign: "top" });
    slide.addText(p.roomType, { x: x + pad, y: y + pad + 0.98, w: w - pad * 2, h: 0.28, fontSize: 11.5, color: COLORS.inkFaint, fontFace: FONT });
    slide.addText(p.sharingLabel, { x: x + pad, y: y + pad + 1.26, w: w - pad * 2, h: 0.28, fontSize: 11.5, color: COLORS.inkFaint, fontFace: FONT });

    slide.addText(p.rentLabel, { x: x + pad, y: y + pad + 1.62, w: w - pad * 2, h: 0.42, fontSize: 19, bold: true, color: COLORS.purple, fontFace: FONT });
    slide.addText(p.distanceLabel === NOT_AVAILABLE ? "Distance: " + NOT_AVAILABLE : `${p.distanceLabel} from campus`, { x: x + pad, y: y + pad + 2.06, w: w - pad * 2, h: 0.26, fontSize: 10.5, color: COLORS.inkSoft, fontFace: FONT });

    const imgNote = p.image ? "Photos available on listing" : "No photo on file";
    slide.addText(imgNote, { x: x + pad, y: y + h - 0.92, w: w - pad * 2, h: 0.24, fontSize: 9.5, italic: true, color: COLORS.inkFaint, fontFace: FONT });

    if (p.amenities.length > 0) {
        DS.chipRow(slide, p.amenities.slice(0, 3), { x: x + pad, y: y + h - 0.66, w: w - pad * 2, chipH: 0.26, fontSize: 9, fill: COLORS.surface, textColor: COLORS.inkSoft });
    }
    slide.addText(p.url ? truncate(p.url, 44) : `Listing link: ${NOT_AVAILABLE}`, {
        x: x + pad, y: y + h - 0.32, w: w - pad * 2, h: 0.26, fontSize: 9, color: p.url ? COLORS.purple : COLORS.inkFaint, fontFace: FONT,
    });
}

function buildOptionsSlides(pptx, n, startPageNum, totalPages) {
    const perSlide = 3;
    const slides = [];
    for (let i = 0; i < n.properties.length; i += perSlide) {
        const group = n.properties.slice(i, i + perSlide);
        const isFirst = i === 0;
        const { slide } = DS.frame(pptx, { sectionLabel: "Options", title: isFirst ? "Accommodation Options" : "Accommodation Options (continued)" });
        const cardW = (CONTENT_W - GUTTER * (group.length - 1)) / (group.length || 1);
        group.forEach((p, idx) => {
            buildOptionCard(slide, p, { x: MARGIN + idx * (cardW + GUTTER), y: CONTENT_TOP, w: cardW, h: CONTENT_H });
        });
        DS.footer(slide, startPageNum + slides.length, totalPages);
        slides.push(slide);
    }
    return slides;
}

// ---- Slide: Comparison at a Glance ----
function buildComparisonSlide(pptx, n, pageNum, totalPages) {
    const { slide } = DS.frame(pptx, { sectionLabel: "Comparison", title: "Comparison at a Glance" });
    const cols = [
        { key: "name", label: "Property", w: 4.0 },
        { key: "providerLabel", label: "Provider", w: 2.0 },
        { key: "rentLabel", label: "Rent", w: 2.2 },
        { key: "distanceLabel", label: "Distance", w: 1.7 },
        { key: "availabilityLabel", label: "Availability", w: 2.233 },
    ];
    const colX = [];
    let cx = MARGIN;
    cols.forEach((c) => { colX.push(cx); cx += c.w; });

    const headerH = 0.46;
    const rowH = Math.min(0.6, (CONTENT_H - headerH) / Math.max(1, n.properties.length));
    slide.addShape("roundRect", { x: MARGIN, y: CONTENT_TOP, w: CONTENT_W, h: headerH, rectRadius: 0.06, fill: { color: COLORS.purple } });
    cols.forEach((c, i) => {
        slide.addText(c.label.toUpperCase(), { x: colX[i] + 0.18, y: CONTENT_TOP, w: c.w - 0.3, h: headerH, fontSize: TYPE.sectionLabel, bold: true, color: COLORS.goldLight, valign: "middle", charSpacing: 1, fontFace: FONT });
    });

    n.properties.forEach((p, i) => {
        const y = CONTENT_TOP + headerH + i * rowH;
        const isRecommended = n.recommendation && n.recommendation.property.propertyId === p.propertyId;
        slide.addShape("rect", { x: MARGIN, y, w: CONTENT_W, h: rowH, fill: { color: isRecommended ? "F3E7EE" : (i % 2 === 0 ? COLORS.white : COLORS.surface) } });
        if (isRecommended) slide.addShape("rect", { x: MARGIN, y, w: 0.06, h: rowH, fill: { color: COLORS.gold } });

        slide.addText(truncate(p.name, 38), { x: colX[0] + 0.18, y, w: cols[0].w - 0.3, h: rowH, fontSize: TYPE.table, bold: true, color: COLORS.ink, valign: "middle", fontFace: FONT });
        slide.addText(p.providerLabel, { x: colX[1] + 0.18, y, w: cols[1].w - 0.3, h: rowH, fontSize: TYPE.table, color: COLORS.inkSoft, valign: "middle", fontFace: FONT });
        slide.addText(p.rentLabel, { x: colX[2] + 0.18, y, w: cols[2].w - 0.3, h: rowH, fontSize: TYPE.table, color: COLORS.inkSoft, valign: "middle", fontFace: FONT });
        slide.addText(p.distanceLabel, { x: colX[3] + 0.18, y, w: cols[3].w - 0.3, h: rowH, fontSize: TYPE.table, color: COLORS.inkSoft, valign: "middle", fontFace: FONT });
        slide.addText(p.availabilityLabel, { x: colX[4] + 0.18, y, w: cols[4].w - 0.3, h: rowH, fontSize: TYPE.table, bold: true, color: p.availabilityLabel === "Available" ? COLORS.success : COLORS.inkSoft, valign: "middle", fontFace: FONT });
    });
    DS.footer(slide, pageNum, totalPages);
    return slide;
}

// ---- Slide: Our Recommendation (only when a recommendation is saved) ----
function buildRecommendationSlide(pptx, n, pageNum, totalPages) {
    const { slide } = DS.frame(pptx, { sectionLabel: "Recommendation", title: "Our Recommendation" });
    const p = n.recommendation.property;

    slide.addShape("roundRect", { x: MARGIN, y: CONTENT_TOP, w: CONTENT_W, h: 1.5, rectRadius: RADIUS_CARD, fill: { color: COLORS.purple } });
    DS.pill(slide, { x: MARGIN + 0.26, y: CONTENT_TOP + 0.24, w: 1.8, h: 0.32, text: p.providerLabel, fill: COLORS.gold, textColor: COLORS.purpleDeep, fontSize: 10 });
    slide.addText(p.name, { x: MARGIN + 0.26, y: CONTENT_TOP + 0.64, w: 8.5, h: 0.5, fontSize: 22, bold: true, color: COLORS.white, fontFace: FONT });
    slide.addText(`${p.rentLabel}   ·   ${p.sharingLabel}   ·   ${p.distanceLabel}`, { x: MARGIN + 0.26, y: CONTENT_TOP + 1.12, w: CONTENT_W - 0.52, h: 0.3, fontSize: 12.5, color: COLORS.goldLight, fontFace: FONT });

    const whyY = CONTENT_TOP + 1.75;
    DS.infoCard(slide, { x: MARGIN, y: whyY, w: CONTENT_W, h: 0.95, title: "Why This Property", body: n.recommendation.reason || NOT_AVAILABLE });

    const listY = whyY + 1.15;
    const colW = (CONTENT_W - GUTTER) / 2;
    const listH = CONTENT_BOTTOM - listY;
    DS.infoCard(slide, { x: MARGIN, y: listY, w: colW, h: listH, title: "Advantages", body: p.advantages || NOT_AVAILABLE });
    DS.infoCard(slide, { x: MARGIN + colW + GUTTER, y: listY, w: colW, h: listH, title: "Considerations", body: p.disadvantages || NOT_AVAILABLE });

    DS.footer(slide, pageNum, totalPages);
    return slide;
}

// ---- Slide: Cost Summary ----
function buildCostSummarySlide(pptx, n, pageNum, totalPages) {
    const { slide } = DS.frame(pptx, { sectionLabel: "Cost", title: "Cost Summary" });
    const { groups, unknownCount } = n.costSummary;

    if (groups.length === 0) {
        DS.infoCard(slide, { x: MARGIN, y: CONTENT_TOP, w: CONTENT_W, h: 1.2, title: "Cost Summary", body: NOT_AVAILABLE });
    } else {
        const colW = (CONTENT_W - GUTTER * (groups.length - 1)) / groups.length;
        groups.forEach((g, i) => {
            DS.metricCard(slide, {
                x: MARGIN + i * (colW + GUTTER), y: CONTENT_TOP, w: colW, h: 1.85,
                label: `${g.currency} rent range`, value: g.rangeLabel, sublabel: `${g.count} propert${g.count === 1 ? "y" : "ies"}`,
                tone: i === 0 ? "solid" : "outline",
            });
        });
    }

    const noteY = CONTENT_TOP + 2.1;
    const notes = ["Amounts are shown in each property's own listed currency -- no currency conversion has been applied."];
    if (unknownCount > 0) notes.push(`${unknownCount} propert${unknownCount === 1 ? "y has" : "ies have"} no confirmed rent on file and ${unknownCount === 1 ? "is" : "are"} excluded from the range above.`);
    slide.addText(
        notes.map((t) => ({ text: t, options: { bullet: { code: "2022", color: COLORS.rose }, breakLine: true } })),
        { x: MARGIN, y: noteY, w: CONTENT_W, h: 1.0, fontSize: TYPE.body, color: COLORS.inkSoft, fontFace: FONT, valign: "top", lineSpacingMultiple: 1.3 }
    );
    DS.footer(slide, pageNum, totalPages);
    return slide;
}

// ---- Slide: Next Steps / Contact ----
function buildClosingSlide(pptx, n, pageNum, totalPages) {
    const slide = pptx.addSlide();
    slide.background = { color: COLORS.purpleDeep };
    const leftW = 6.0;

    slide.addText("YOUR NEXT STEP", { x: MARGIN, y: 1.5, w: leftW, h: 0.32, fontSize: 12, bold: true, color: COLORS.gold, charSpacing: 2, fontFace: FONT });
    slide.addText("Let's find your\nnew home.", { x: MARGIN, y: 1.95, w: leftW, h: 1.8, fontSize: 34, bold: true, color: COLORS.white, fontFace: FONT, lineSpacingMultiple: 1.08 });
    slide.addShape("line", { x: MARGIN, y: 3.95, w: 0.7, h: 0, line: { color: COLORS.gold, width: 3 } });
    slide.addText(
        "Reach out to your IVYHUTS advisor to confirm availability, ask questions, or move forward with any of these options.",
        { x: MARGIN, y: 4.2, w: leftW, h: 0.8, fontSize: 13, color: "D9C4E0", fontFace: FONT, lineSpacingMultiple: 1.3 }
    );

    const rightX = MARGIN + leftW + 0.7;
    const rightW = PAGE_W - MARGIN - rightX;
    slide.addShape("roundRect", { x: rightX, y: 1.9, w: rightW, h: 3.2, rectRadius: RADIUS_CARD, fill: { color: "4A2F55" } });
    const contactRows = [
        ["Email", CONTACT.email],
        ["WhatsApp", CONTACT.whatsapp],
        ["Website", CONTACT.website],
    ];
    contactRows.forEach(([label, value], i) => {
        const y = 2.2 + i * 0.95;
        slide.addText(label.toUpperCase(), { x: rightX + 0.3, y, w: rightW - 0.6, h: 0.26, fontSize: 10, bold: true, color: COLORS.gold, charSpacing: 1.2, fontFace: FONT });
        slide.addText(value, { x: rightX + 0.3, y: y + 0.28, w: rightW - 0.6, h: 0.4, fontSize: 15, bold: true, color: COLORS.white, fontFace: FONT });
    });

    slide.addShape("line", { x: MARGIN, y: PAGE_H - 1.1, w: PAGE_W - MARGIN * 2, h: 0, line: { color: COLORS.gold, width: 1 } });
    slide.addText(
        [{ text: "IVY", options: { color: COLORS.white, bold: true } }, { text: "huts", options: { color: COLORS.goldLight, bold: true } }, { text: "   Housing to Hiring", options: { color: "C9B4C4", bold: false } }],
        { x: MARGIN, y: PAGE_H - 0.92, w: 8, h: 0.4, fontSize: 14, fontFace: FONT }
    );
    slide.addText(`${pageNum} / ${totalPages}`, { x: PAGE_W - MARGIN - 1.0, y: PAGE_H - 0.6, w: 1.0, h: 0.3, fontSize: 9, color: "9C82A0", align: "right", fontFace: FONT });
    return slide;
}

function buildPresentation(normalized) {
    const pptx = new PptxGenJS();
    pptx.layout = "LAYOUT_WIDE";
    pptx.author = "IVYHUTS";
    pptx.company = "IVYHUTS";
    pptx.title = `IVYHUTS Accommodation Presentation${normalized.student.name ? ` -- ${normalized.student.name}` : ""}`;
    pptx.subject = "Personalized Accommodation Options";

    buildCoverSlide(pptx, normalized);

    // Page numbering: cover is unnumbered "page 1"; every function below
    // receives its own page number sequentially, and the options section
    // may span multiple slides depending on how many properties were
    // curated -- computed up front so every footer shows the correct total.
    const optionSlideCount = Math.max(1, Math.ceil(normalized.properties.length / 3));
    const hasComparison = normalized.properties.length > 0;
    const hasRecommendation = Boolean(normalized.recommendation);
    const totalPages = 1 // cover
        + 1 // requirements
        + optionSlideCount
        + (hasComparison ? 1 : 0)
        + (hasRecommendation ? 1 : 0)
        + 1 // cost summary
        + 1; // closing

    let pageNum = 2;
    buildRequirementsSlide(pptx, normalized, pageNum, totalPages);
    pageNum += 1;

    if (normalized.properties.length > 0) {
        buildOptionsSlides(pptx, normalized, pageNum, totalPages);
        pageNum += optionSlideCount;
        buildComparisonSlide(pptx, normalized, pageNum, totalPages);
        pageNum += 1;
    }

    if (hasRecommendation) {
        buildRecommendationSlide(pptx, normalized, pageNum, totalPages);
        pageNum += 1;
    }

    buildCostSummarySlide(pptx, normalized, pageNum, totalPages);
    pageNum += 1;
    buildClosingSlide(pptx, normalized, pageNum, totalPages);

    return pptx;
}

async function generateAccommodationPresentationPptxBuffer(normalized) {
    const pptx = buildPresentation(normalized);
    return pptx.write({ outputType: "nodebuffer" });
}

module.exports = {
    generateAccommodationPresentationPptxBuffer,
    buildPresentation,
    CONTACT,
    PAGE_W,
    PAGE_H,
};
