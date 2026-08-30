// Accommodation Presentation -- slide construction (Milestone 23.8,
// restructured Milestone 23.18 to match the reference deck "IVYHUTS -
// Rajdev Sir - Dubai Accommodation Proposal.pptx" studied for this
// milestone: premium cover with "Prepared exclusively for [client]",
// one detailed slide per curated property (room table + features +
// location + booking + provenance footer, not a compact 3-per-slide
// card grid), and a closing "Why IVYHUTS?" value-proposition slide).
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
// Milestone 23.18 -- the reference deck's own content (Rajdev Sir, Dubai,
// UOWD, AED, Makaan, Al Sufouh, Staybridge, Amber Property/Room IDs) was
// studied for VISUAL HIERARCHY AND SALES LOGIC ONLY -- none of it is a data
// source. Every value rendered below comes from the actual normalized
// model (Discovery + AccommodationCuration only); Amber is never
// referenced (this pipeline's four providers are UHomes/UniAcco/
// University Living/Gradding Homes -- see AccommodationCuration.js's
// PROVIDERS -- confirmed by inspection before writing this file), and
// "booking" language is deliberately softened to "view the original
// listing" rather than the reference's "bookable via the IVYHUTS listing",
// since this pipeline has no IVYHUTS-hosted listing/booking capability of
// its own (see pptNormalizeAccommodation.js's formatListingLine).
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
const { NOT_AVAILABLE, formatListingLine, formatPropertyProvenance } = require("./pptNormalizeAccommodation");

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

// ---- Slide 1: Cover -- personalized WHO/WHERE/WHY (Milestone 23.18 Part 7) ----
function buildCoverSlide(pptx, n) {
    const slide = pptx.addSlide();
    slide.background = { color: COLORS.purpleDeep };

    slide.addText(
        [{ text: "IVY", options: { color: COLORS.white, bold: true } }, { text: "huts", options: { color: COLORS.goldLight, bold: true } }],
        { x: MARGIN, y: 0.55, w: 3, h: 0.4, fontSize: 18, fontFace: FONT }
    );

    const leftW = 9.2;
    slide.addText("STUDENT ACCOMMODATION PROPOSAL", { x: MARGIN, y: 1.5, w: leftW, h: 0.32, fontSize: TYPE.coverLabel, bold: true, color: COLORS.gold, charSpacing: 2.5, fontFace: FONT });

    // WHERE -- the university's own resolved location (city, country) when
    // known; the university name itself as a second line. Neither is
    // invented when Discovery/criteriaSnapshot couldn't supply it -- the
    // title simply falls back to a plain, honest generic line.
    const destination = n.university.available && n.university.location ? n.university.location.split(",")[0].trim() : null;
    const titleLine1 = destination ? `Student Accommodation Options in ${destination}` : "Your Personalized Accommodation Options";
    const titleLine2 = n.university.available ? `Near ${n.university.name}` : null;
    slide.addText(titleLine2 ? `${titleLine1}\n${titleLine2}` : titleLine1, {
        x: MARGIN, y: 1.9, w: leftW, h: 1.9, fontSize: 32, bold: true, color: COLORS.white, fontFace: FONT, lineSpacingMultiple: 1.1,
    });

    slide.addShape("line", { x: MARGIN, y: 3.95, w: 0.7, h: 0, line: { color: COLORS.gold, width: 3 } });

    // WHO -- "Prepared exclusively for [client]" (Milestone 23.18 Part 7's
    // explicit wording), honestly generic when no confirmed name exists.
    const preparedFor = n.student.name ? `Prepared exclusively for ${n.student.name}` : "Prepared exclusively for you";
    slide.addText(preparedFor, { x: MARGIN, y: 4.25, w: leftW, h: 0.5, fontSize: 19, bold: true, color: COLORS.white, fontFace: FONT });

    slide.addText(`${CONTACT.website}  ·  Real, agent-curated accommodation options`, {
        x: MARGIN, y: 4.85, w: leftW, h: 0.32, fontSize: 11, color: COLORS.goldLight, fontFace: FONT,
    });

    slide.addText(
        "Prepared by IVYHUTS. Property details reflect the options curated for this student -- always confirm current availability and pricing with the provider before booking.",
        { x: MARGIN, y: PAGE_H - 0.55, w: 12.1, h: 0.4, fontSize: 9, color: "9C82A0", fontFace: FONT }
    );
    return slide;
}

// ---- Slide: Your Accommodation Requirements (Milestone 23.18 Parts 6/8) ----
// Only fields the agent actually confirmed appear -- Part 6/15: "Only show
// fields that exist... omission is acceptable", so a field this student
// never confirmed is simply left off the grid rather than shown as an
// empty/"Not available" tile (a client reading their own proposal should
// never see a visible gap where a requirement they never gave should be).
function buildRequirementsSlide(pptx, n, pageNum, totalPages) {
    const { slide } = DS.frame(pptx, { sectionLabel: "Your Requirements", title: "Your Accommodation Requirements" });
    const r = n.requirements;

    if (!r.available) {
        DS.infoCard(slide, { x: MARGIN, y: CONTENT_TOP, w: CONTENT_W, h: 1.2, title: "Requirements", body: NOT_AVAILABLE });
        DS.footer(slide, pageNum, totalPages);
        return slide;
    }

    const candidateCards = [
        n.university.available && ["University", n.university.name],
        r.courseLabel !== NOT_AVAILABLE && ["Course", r.courseLabel],
        r.intakeLabel !== NOT_AVAILABLE && ["Intake", r.intakeLabel],
        r.budgetLabel !== NOT_AVAILABLE && ["Budget", `${r.budgetLabel} / week`],
        r.roomPreferenceLabel !== NOT_AVAILABLE && ["Room Preference", r.roomPreferenceLabel],
        r.sharingLabel !== NOT_AVAILABLE && ["Sharing", r.sharingLabel],
        r.moveInDateLabel !== NOT_AVAILABLE && ["Move-in", r.moveInDateLabel],
        r.stayDurationLabel !== NOT_AVAILABLE && ["Stay Duration", r.stayDurationLabel],
        r.preferredLocationLabel !== NOT_AVAILABLE && ["Preferred Area", r.preferredLocationLabel],
        r.distancePreferenceLabel !== NOT_AVAILABLE && ["Distance Priority", r.distancePreferenceLabel],
    ].filter(Boolean);

    if (candidateCards.length === 0) {
        DS.infoCard(slide, { x: MARGIN, y: CONTENT_TOP, w: CONTENT_W, h: 1.2, title: "Requirements", body: "No specific requirements have been confirmed yet." });
        DS.footer(slide, pageNum, totalPages);
        return slide;
    }

    // Up to 9 cards (3x3) fit CONTENT_H cleanly; any confirmed requirement
    // beyond that is rare in practice (this is already a superset of the
    // reference deck's own requirement list) and simply doesn't appear
    // rather than overflow the slide -- never silently dropped data the
    // agent needs to worry about, since Discovery itself remains the real
    // record.
    const cards = candidateCards.slice(0, 9);
    const colW = (CONTENT_W - GUTTER * 2) / 3;
    const rowH = Math.min(1.35, (CONTENT_H - (n.requirements.priorities.length > 0 ? 0.6 : 0)) / Math.ceil(cards.length / 3) - GUTTER);
    cards.forEach(([label, value], i) => {
        const col = i % 3;
        const row = Math.floor(i / 3);
        DS.metricCard(slide, {
            x: MARGIN + col * (colW + GUTTER), y: CONTENT_TOP + row * (rowH + GUTTER), w: colW, h: rowH,
            label, value: truncate(value, 34), tone: row === 0 && col === 0 ? "solid" : "outline",
        });
    });

    if (r.priorities.length > 0) {
        const chipsY = CONTENT_TOP + Math.ceil(cards.length / 3) * (rowH + GUTTER) + 0.06;
        slide.addText("WHAT MATTERS MOST", { x: MARGIN, y: chipsY, w: CONTENT_W, h: 0.26, fontSize: TYPE.sectionLabel, bold: true, color: COLORS.rose, charSpacing: 1, fontFace: FONT });
        DS.chipRow(slide, r.priorities, { x: MARGIN, y: chipsY + 0.3, w: CONTENT_W });
    }
    DS.footer(slide, pageNum, totalPages);
    return slide;
}

// ---- Slide(s): one property per slide (Milestone 23.18 Part 9, restructured
// Milestone 23.19 to match the reference deck's MEASURED composition: a
// tall photo panel filling roughly the left half of the slide, property
// details stacked in the right half -- confirmed by inspecting the
// reference PPTX's own shape geometry (its embedded photo spans x=0.55in
// to x=6.5in of a 13.33in-wide slide, full content height). This pipeline
// never fetches/embeds a real photo (zero network calls during generation
// -- see this file's own header comment), so the left panel is an honest
// placeholder (DS.photoPlaceholder) reproducing the reference's spatial
// weight/whitespace rhythm without implying a real photograph is shown. ----
function buildPropertySlide(pptx, n, property, index, total, pageNum, totalPages) {
    const universityShort = n.university.available ? n.university.name : "Your University";
    const { slide } = DS.frame(pptx, { sectionLabel: `Near ${universityShort} · ${index}/${total}`, title: property.name });

    const photoW = 5.5;
    DS.photoPlaceholder(slide, { x: MARGIN, y: CONTENT_TOP, w: photoW, h: CONTENT_H, hasVerifiedPhoto: Boolean(property.image) });

    const rightX = MARGIN + photoW + GUTTER;
    const rightW = CONTENT_W - photoW - GUTTER;
    let y = CONTENT_TOP;

    // Distance -- honest straight-line disclaimer, same spirit as the
    // reference deck's own "actual travel time varies by route" caveat,
    // without asserting a specific computation method this file hasn't
    // itself verified.
    if (property.distanceLabel !== NOT_AVAILABLE) {
        slide.addText(`📍  ${property.distanceLabel} from ${universityShort}`, { x: rightX, y, w: rightW, h: 0.3, fontSize: 13, bold: true, color: COLORS.purple, fontFace: FONT });
        slide.addText("Straight-line distance -- actual travel time and route may vary.", { x: rightX, y: y + 0.3, w: rightW, h: 0.22, fontSize: 8.5, italic: true, color: COLORS.inkFaint, fontFace: FONT });
        y += 0.62;
    } else {
        slide.addText(`📍  Distance from ${universityShort}: ${NOT_AVAILABLE}`, { x: rightX, y, w: rightW, h: 0.3, fontSize: 13, bold: true, color: COLORS.inkFaint, fontFace: FONT });
        y += 0.4;
    }
    y += 0.1;

    // Room details -- a compact 2x2 stat grid, not a table: this pipeline's
    // CuratedProperty model captures exactly ONE room/rate combination per
    // curated property (never several room-type variants, unlike the
    // reference deck's own multi-room-type tables) -- see
    // AccommodationCuration.js's schema. A permanently-single-row table
    // reads oddly; a small stat grid (matching the reference deck's OWN
    // single-room-type slide, which used a label/value grid rather than a
    // table for exactly this case) is the more honest, better-fitting
    // treatment. Bathroom/Kitchen/Move-in are omitted entirely (not shown
    // as a permanent "Not available") because this data model has no such
    // per-property fields at all (Move-in IS captured, but as the
    // STUDENT's own confirmed requirement, already on the Requirements
    // slide -- not a per-property fact to repeat here).
    const statColW = (rightW - GUTTER) / 2;
    const statRowH = 0.82;
    const stats = [
        ["Room Type", property.roomType],
        ["Sharing", property.sharingLabel],
        ["Price", property.rentLabel],
        ["Availability", property.availabilityLabel],
    ];
    stats.forEach(([label, value], i) => {
        const col = i % 2;
        const row = Math.floor(i / 2);
        DS.metricCard(slide, {
            x: rightX + col * (statColW + GUTTER), y: y + row * (statRowH + 0.12), w: statColW, h: statRowH,
            label, value: truncate(String(value), 22), tone: i === 2 ? "solid" : "outline",
        });
    });
    y += 2 * statRowH + 0.12 + 0.2;

    // Key Features -- fills the remaining right-column space.
    const featuresH = Math.max(0.9, CONTENT_BOTTOM - y - 0.62);
    if (property.amenities.length > 0) {
        DS.infoCard(slide, { x: rightX, y, w: rightW, h: featuresH, title: "Key Features", items: property.amenities });
    } else {
        DS.infoCard(slide, { x: rightX, y, w: rightW, h: featuresH, title: "Key Features", body: NOT_AVAILABLE });
    }
    y += featuresH + 0.14;

    // Location + Booking -- compact single lines (the photo panel's own
    // caption already covers the honest photo-availability note, so it's
    // not repeated here).
    slide.addText(
        [{ text: "Location  ", options: { bold: true, color: COLORS.rose, fontFace: FONT } }, { text: property.locationLabel, options: { color: COLORS.inkSoft, fontFace: FONT } }],
        { x: rightX, y, w: rightW, h: 0.24, fontSize: 10.5 }
    );
    y += 0.26;
    slide.addText(truncate(formatListingLine(property), 76), { x: rightX, y, w: rightW, h: 0.24, fontSize: 9.5, color: property.url ? COLORS.purple : COLORS.inkFaint, fontFace: FONT });

    DS.footer(slide, pageNum, totalPages, `IVYHUTS  ·  Prepared for ${n.student.name || "you"}  ·  ${formatPropertyProvenance(property)}`);
    return slide;
}

function buildPropertySlides(pptx, n, startPageNum, totalPages) {
    const slides = [];
    n.properties.forEach((p, i) => {
        slides.push(buildPropertySlide(pptx, n, p, i + 1, n.properties.length, startPageNum + i, totalPages));
    });
    return slides;
}

// ---- Slide: Comparison at a Glance (Milestone 23.18 Part 11 -- adds a
// "Key Match" column, computed the same objective-evidence way as the
// recommendation slide, never a subjective "best"/"cheapest" label without
// evidence). ----
function buildComparisonSlide(pptx, n, pageNum, totalPages) {
    const { slide } = DS.frame(pptx, { sectionLabel: "Comparison", title: "Comparison at a Glance" });

    const evidenceByPropertyId = new Map();
    if (n.recommendation) evidenceByPropertyId.set(n.recommendation.property.propertyId, n.recommendation.evidence);
    n.otherProperties.forEach((o) => evidenceByPropertyId.set(o.property.propertyId, o.evidence));

    // Milestone 23.19 -- refactored onto DS.dataTable (this is the one
    // genuinely multi-row table in this deck, a natural fit for that
    // primitive, unlike the per-property slide's now-single-row stat grid
    // -- see buildPropertySlide's own comment on why THAT slide moved away
    // from a table). rowFill highlights the recommended property's row the
    // same way the pre-23.19 hand-drawn version did.
    const rows = [
        ["Property", "Price", "Distance", "Availability", "Key Match"],
        ...n.properties.map((p) => {
            const evidence = evidenceByPropertyId.get(p.propertyId) || [];
            return [truncate(p.name, 30), p.rentLabel, p.distanceLabel, p.availabilityLabel, evidence.length > 0 ? truncate(evidence[0], 44) : "—"];
        }),
    ];
    DS.dataTable(slide, rows, {
        x: MARGIN, y: CONTENT_TOP, colWidths: [3.3, 2.0, 1.5, 1.833, 3.5],
        headerH: 0.46, rowH: Math.min(0.6, (CONTENT_H - 0.46) / Math.max(1, n.properties.length)),
        rowFill: (i) => (n.recommendation && n.recommendation.property.propertyId === n.properties[i].propertyId ? "F3E7EE" : null),
        cellColor: (i, col) => (col === 0 ? COLORS.ink : col === 3 && n.properties[i].availabilityLabel === "Available" ? COLORS.success : null),
        cellBold: (i, col) => col === 0 || col === 3,
    });
    DS.footer(slide, pageNum, totalPages);
    return slide;
}

// ---- Slide: Recommended Options (Milestone 23.18 Part 12 -- the agent's
// own explicit top pick, PLUS every other curated property with its own
// objective match evidence, in curation order. Never a fabricated #2/#3
// ranking -- this pipeline's curation model records exactly one explicit
// recommendation; anything beyond that is presented as "also in your
// shortlist", not a second/third invented tier.) ----
function buildRecommendationSlide(pptx, n, pageNum, totalPages) {
    const { slide } = DS.frame(pptx, { sectionLabel: "Recommendation", title: "Recommended For You" });
    const p = n.recommendation.property;

    slide.addShape("roundRect", { x: MARGIN, y: CONTENT_TOP, w: CONTENT_W, h: 1.3, rectRadius: RADIUS_CARD, fill: { color: COLORS.purple } });
    DS.pill(slide, { x: MARGIN + 0.26, y: CONTENT_TOP + 0.22, w: 1.8, h: 0.3, text: p.providerLabel, fill: COLORS.gold, textColor: COLORS.purpleDeep, fontSize: 10 });
    slide.addText(p.name, { x: MARGIN + 0.26, y: CONTENT_TOP + 0.58, w: 8.5, h: 0.44, fontSize: 20, bold: true, color: COLORS.white, fontFace: FONT });
    slide.addText(`${p.rentLabel}   ·   ${p.sharingLabel}   ·   ${p.distanceLabel}`, { x: MARGIN + 0.26, y: CONTENT_TOP + 1.0, w: CONTENT_W - 0.52, h: 0.26, fontSize: 12, color: COLORS.goldLight, fontFace: FONT });

    const evidenceY = CONTENT_TOP + 1.44;
    const evidenceItems = n.recommendation.evidence.length > 0 ? n.recommendation.evidence : [n.recommendation.reason ? "See advisor notes below." : "No confirmed-requirement match evidence is available for this option."];
    DS.infoCard(slide, { x: MARGIN, y: evidenceY, w: CONTENT_W, h: 0.9, title: "Best Match For", items: evidenceItems });

    const reasonY = evidenceY + 1.05;
    if (n.recommendation.reason) {
        DS.infoCard(slide, { x: MARGIN, y: reasonY, w: CONTENT_W, h: 1.0, title: "Advisor's Note", body: n.recommendation.reason });
    }

    // "Also in your shortlist" -- every other curated property, compact,
    // curation order, with its own objective evidence line (never
    // reordered/ranked -- Part 17).
    const otherY = reasonY + (n.recommendation.reason ? 1.14 : 0.06);
    if (n.otherProperties.length > 0 && otherY < CONTENT_BOTTOM - 0.3) {
        slide.addText("ALSO IN YOUR SHORTLIST", { x: MARGIN, y: otherY, w: CONTENT_W, h: 0.24, fontSize: TYPE.sectionLabel, bold: true, color: COLORS.rose, charSpacing: 1, fontFace: FONT });
        const rowH = Math.min(0.34, (CONTENT_BOTTOM - otherY - 0.3) / n.otherProperties.length);
        n.otherProperties.slice(0, 4).forEach((o, i) => {
            const y = otherY + 0.3 + i * rowH;
            const line = o.evidence.length > 0 ? `${o.property.name} — ${o.evidence[0]}` : `${o.property.name} — ${o.property.rentLabel} · ${o.property.distanceLabel}`;
            slide.addText(truncate(line, 110), { x: MARGIN, y, w: CONTENT_W, h: rowH, fontSize: 11, color: COLORS.inkSoft, fontFace: FONT, valign: "middle" });
        });
    }

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
        // Milestone 23.20 fix -- one card per (currency, rentPeriod) pair,
        // never one card per currency alone: "GBP / week" and "GBP / month"
        // are always shown as separate ranges, never merged into a single
        // misleading figure (see buildCostSummary's own header comment).
        const colW = (CONTENT_W - GUTTER * (groups.length - 1)) / groups.length;
        groups.forEach((g, i) => {
            DS.metricCard(slide, {
                x: MARGIN + i * (colW + GUTTER), y: CONTENT_TOP, w: colW, h: 1.85,
                label: `${g.currency} / ${g.periodLabel}`, value: g.rangeLabel, sublabel: `${g.count} propert${g.count === 1 ? "y" : "ies"}`,
                tone: i === 0 ? "solid" : "outline",
            });
        });
    }

    const noteY = CONTENT_TOP + 2.1;
    const notes = ["Amounts are shown in each property's own listed currency and rent period -- no currency conversion and no week/month conversion has been applied."];
    if (unknownCount > 0) notes.push(`${unknownCount} propert${unknownCount === 1 ? "y has" : "ies have"} no confirmed rent/currency/period on file and ${unknownCount === 1 ? "is" : "are"} excluded from the ranges above.`);
    slide.addText(
        notes.map((t) => ({ text: t, options: { bullet: { code: "2022", color: COLORS.rose }, breakLine: true } })),
        { x: MARGIN, y: noteY, w: CONTENT_W, h: 1.0, fontSize: TYPE.body, color: COLORS.inkSoft, fontFace: FONT, valign: "top", lineSpacingMultiple: 1.3 }
    );
    DS.footer(slide, pageNum, totalPages);
    return slide;
}

// ---- Slide: Why IVYHUTS? (Milestone 23.18 Part 13 -- NEW. Every claim
// below is about THIS pipeline's own actual, verifiable behavior
// (explicit agent curation, immutable snapshot, requirement-based
// matching, honest availability, real listing links) -- deliberately NOT
// the reference deck's "live inventory"/"verified pricing" language, since
// this deck's properties come from whichever of the four providers were
// actually configured and searched, which this module has no way to
// assert is "live" at read time; claiming so would be exactly the
// overclaim Part 13 warns against. ----
function buildWhyIvyhutsSlide(pptx, n, pageNum, totalPages) {
    const { slide } = DS.frame(pptx, { sectionLabel: "Why IVYHUTS", title: "Why IVYHUTS?" });
    const claims = [
        "Every property in this shortlist was personally selected and reviewed by your IVYHUTS advisor -- never an automated or unreviewed list.",
        "Recommendations are matched against your own confirmed requirements, not a generic ranking.",
        "Pricing and availability are shown exactly as recorded when this shortlist was prepared.",
        "Availability status is always shown honestly, including any option that is no longer available.",
        "Every option links back to its original listing, where available, so you can verify the details independently.",
    ];
    slide.addText(
        claims.map((t) => ({ text: t, options: { bullet: { code: "2713", color: COLORS.success }, breakLine: true } })),
        { x: MARGIN, y: CONTENT_TOP, w: CONTENT_W, h: CONTENT_H - 0.3, fontSize: TYPE.body + 1, color: COLORS.ink, fontFace: FONT, valign: "top", lineSpacingMultiple: 1.6 }
    );
    DS.footer(slide, pageNum, totalPages);
    return slide;
}

// ---- Slide: Next Steps / Contact (Milestone 23.18 Part 14 -- personalized CTA) ----
function buildClosingSlide(pptx, n, pageNum, totalPages) {
    const slide = pptx.addSlide();
    slide.background = { color: COLORS.purpleDeep };
    const leftW = 6.0;

    slide.addText("YOUR NEXT STEP", { x: MARGIN, y: 1.5, w: leftW, h: 0.32, fontSize: 12, bold: true, color: COLORS.gold, charSpacing: 2, fontFace: FONT });
    const name = n.student.name || "you";
    slide.addText(`Find the accommodation\nthat's right for ${name}.`, { x: MARGIN, y: 1.95, w: leftW, h: 1.8, fontSize: 30, bold: true, color: COLORS.white, fontFace: FONT, lineSpacingMultiple: 1.08 });
    slide.addShape("line", { x: MARGIN, y: 3.95, w: 0.7, h: 0, line: { color: COLORS.gold, width: 3 } });
    slide.addText(
        `Explore ${name === "you" ? "your" : `${name.split(" ")[0]}'s`} shortlisted options above, or reach out to your IVYHUTS advisor to confirm availability and move forward.`,
        { x: MARGIN, y: 4.2, w: leftW, h: 0.9, fontSize: 13, color: "D9C4E0", fontFace: FONT, lineSpacingMultiple: 1.3 }
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
    // receives its own page number sequentially. Slide count is dynamic --
    // one property slide per curated property (Milestone 23.18 Part 20 --
    // never a fixed slide count the data doesn't justify).
    const propertyCount = normalized.properties.length;
    const hasComparison = propertyCount > 0;
    const hasRecommendation = Boolean(normalized.recommendation);
    const totalPages = 1 // cover
        + 1 // requirements
        + propertyCount
        + (hasComparison ? 1 : 0)
        + (hasRecommendation ? 1 : 0)
        + 1 // cost summary
        + 1 // why ivyhuts
        + 1; // closing

    let pageNum = 2;
    buildRequirementsSlide(pptx, normalized, pageNum, totalPages);
    pageNum += 1;

    if (propertyCount > 0) {
        buildPropertySlides(pptx, normalized, pageNum, totalPages);
        pageNum += propertyCount;
        buildComparisonSlide(pptx, normalized, pageNum, totalPages);
        pageNum += 1;
    }

    if (hasRecommendation) {
        buildRecommendationSlide(pptx, normalized, pageNum, totalPages);
        pageNum += 1;
    }

    buildCostSummarySlide(pptx, normalized, pageNum, totalPages);
    pageNum += 1;
    buildWhyIvyhutsSlide(pptx, normalized, pageNum, totalPages);
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
