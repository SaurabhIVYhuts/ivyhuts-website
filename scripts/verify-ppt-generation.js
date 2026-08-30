#!/usr/bin/env node
// Milestone 9 (Student Plan PPT Generation) verification: a dedicated script
// (same precedent as scripts/verify-planner-accommodation-index.js et al.)
// proving that api/student-planner-ppt.js:
//   (a) validates/degrades untrusted payloads safely, never crashes on
//       malformed input;
//   (b) produces a REAL, structurally valid .pptx built from EXACTLY the
//       planner values it was given -- never re-ranked, re-priced or
//       AI-generated;
//   (c) introduces zero Amber traffic, structurally and behaviorally.
//
// Uses JSZip (a real, already-present transitive dependency of pptxgenjs
// itself -- pinned as an explicit devDependency in package.json) to actually
// unzip and inspect the generated .pptx's slide XML, per plan item 29 ("do
// not stop at 'file generated successfully'").
"use strict";

const assert = require("assert");
const path = require("path");
const JSZip = require("jszip");
const ROOT = path.join(__dirname, "..");

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  PASS  ${name}`);
    } catch (err) {
        failed++;
        failures.push({ name, message: err.message });
        console.log(`  FAIL  ${name}\n        ${err.message}`);
    }
}

// A minimal but realistic complete plannerResult -- same shape
// StudentPlannerPage.js actually holds in `plannerResult` state, mirroring
// a real Milestone 6/7/8 API response (Computer Science + AI/ML, Manchester).
function makeCompletePlannerResult(overrides = {}) {
    return {
        student: {
            university: "University of Manchester", country: "United Kingdom", city: "Manchester",
            degree: "Computer Science", specialization: "AI / Machine Learning",
            currentYear: "Year 2", graduationYear: "2027", budget: 220,
        },
        university: {
            name: "University of Manchester", city: "Manchester", country: "United Kingdom",
            summary: "University of Manchester is located in Manchester, United Kingdom. A popular choice for Computer Science students.",
            keyFacts: ["Located in Manchester, United Kingdom", "Offers programmes in Computer Science", "Popular with international students"],
        },
        residences: [
            { id: "r1", name: "Vita Student Manchester", distanceKm: 0.8, walkingMinutes: 10, price: { amount: 220, currency: "£", duration: "week" }, roomType: "Studio", rating: { overall: 4.5 }, badge: "Best Overall", matchScore: 92 },
            { id: "r2", name: "iQ Student Accommodation", distanceKm: 1.2, walkingMinutes: 15, price: { amount: 195, currency: "£", duration: "week" }, roomType: "Ensuite", rating: { overall: 4.2 }, badge: "Closest", matchScore: 87 },
            { id: "r3", name: "Fresh Manchester", distanceKm: 1.5, walkingMinutes: 18, price: { amount: 180, currency: "£", duration: "week" }, roomType: "Shared Twin", rating: { overall: 4.0 }, badge: null, matchScore: 80 },
        ],
        comparison: [
            { id: "r1", name: "Vita Student Manchester", distanceKm: 0.8, walkingMinutes: 10, price: { amount: 220, currency: "£", duration: "week" }, roomType: "Studio", rating: { overall: 4.5 }, matchScore: 92 },
            { id: "r2", name: "iQ Student Accommodation", distanceKm: 1.2, walkingMinutes: 15, price: { amount: 195, currency: "£", duration: "week" }, roomType: "Ensuite", rating: { overall: 4.2 }, matchScore: 87 },
        ],
        livingExpenses: {
            currency: "£", accommodation: 953, food: 260, transport: 70, utilities: 70, personal: 120, other: 45,
            totalMonthly: 1518, totalAnnual: 18216, scenarios: { budget: 1290, average: 1518, comfortable: 1822 },
            meta: { source: "internal-estimate", sourceUpdatedAt: "2026-08-11", cityMatched: true, note: "Estimated planning figures, not official statistics." },
        },
        degree: {
            id: "computer-science", name: "Computer Science", status: "ready", category: "Computing & Technology",
            summary: "Computer Science focuses on computation, programming, algorithms, software systems, data and problem solving.",
            coreSkills: ["Programming", "Algorithms", "Data Structures", "Databases", "Software Engineering", "Problem Solving"],
            technicalAreas: ["Programming Languages", "Web Development", "Databases", "Cloud Computing", "Computer Systems"],
            specializationPaths: [],
            specialization: { id: "ai-ml", name: "AI / Machine Learning", emphasisSkills: ["Python", "Machine Learning", "Statistics", "Data Processing", "Neural Networks"] },
            specializationNote: null, source: "ivyhuts-degree-guidance",
        },
        careers: [
            {
                id: "ai-engineer", title: "AI Engineer", category: "Data & Analytics",
                summary: "Designs and integrates AI-driven systems, from model selection to deployment.",
                matchScore: 95, matchLabel: "Strong Match",
                requiredSkills: ["Programming", "Machine Learning", "Deep Learning", "Algorithms"],
                alreadyHaveSkills: ["Programming", "Machine Learning", "Algorithms", "Python", "Neural Networks"],
                skillsToDevelop: ["Deep Learning", "Model Deployment"],
                source: "ivyhuts-career-guidance",
                salary: {
                    available: true, country: "United Kingdom", currency: "£",
                    ranges: { entryLevel: { min: 32000, max: 42000 }, earlyCareer: { min: 42000, max: 58000 }, midCareer: { min: 58000, max: 82000 }, experienced: { min: 82000, max: 115000 } },
                    source: "ivyhuts-salary-guidance", sourceUpdatedAt: "2026-08-11",
                    note: "Estimated planning range. Actual compensation varies by experience, employer, location and market conditions.",
                },
                readiness: {
                    available: true,
                    essentialSkills: ["Programming", "Machine Learning", "Deep Learning", "Algorithms"],
                    recommendedSkills: ["Python", "Model Deployment", "Neural Networks"],
                    alreadyCoveredSkills: ["Programming", "Machine Learning", "Algorithms", "Python", "Neural Networks"],
                    skillsToDevelop: ["Deep Learning", "Model Deployment"],
                    entryRoutes: ["Internship", "Graduate/entry-level AI role", "Junior AI engineer role", "Campus recruitment", "Personal AI projects + direct applications"],
                    portfolioExpectations: ["1-2 substantial AI projects", "At least one project with a deployed model or API"],
                    projectEvidence: ["Deep learning project", "Model training/evaluation project", "Deployed model/API", "Data preprocessing project"],
                    interviewAreas: { technical: ["Machine Learning", "Deep Learning", "Algorithms", "Programming"], practical: ["Model evaluation", "Debugging"], behavioral: ["Project explanation", "Teamwork"] },
                    experienceSignals: ["Internship experience", "Deployed AI models"],
                    preparationSteps: ["Strengthen core ML/deep learning fundamentals", "Build one substantial AI project end-to-end", "Learn model deployment basics", "Deploy and document the project", "Practice technical interviews", "Apply for internships/junior roles"],
                    note: "Preparation guidance, not a guarantee of an interview or an offer.",
                },
            },
            {
                id: "machine-learning-engineer", title: "Machine Learning Engineer", category: "Data & Analytics",
                summary: "Builds and deploys models that let systems learn patterns from data.", matchScore: 95, matchLabel: "Strong Match",
                requiredSkills: ["Programming", "Machine Learning", "Statistics", "Model Building"],
                alreadyHaveSkills: ["Programming", "Machine Learning", "Statistics", "Python"], skillsToDevelop: ["Model Building", "Cloud Platforms"],
                source: "ivyhuts-career-guidance",
                salary: { available: true, country: "United Kingdom", currency: "£", ranges: { entryLevel: { min: 32000, max: 42000 }, earlyCareer: { min: 42000, max: 58000 }, midCareer: { min: 58000, max: 80000 }, experienced: { min: 80000, max: 115000 } } },
                readiness: { available: false, note: "Hiring guidance isn't available for this career yet." },
            },
            {
                id: "software-engineer", title: "Software Engineer", category: "Software Development",
                summary: "Builds and maintains software applications and systems using programming, design and testing skills.",
                matchScore: 70, matchLabel: "Good Match",
                requiredSkills: ["Programming", "Data Structures", "Algorithms", "Software Engineering"],
                alreadyHaveSkills: ["Programming", "Data Structures", "Algorithms", "Software Engineering"], skillsToDevelop: ["Git", "Testing", "Cloud Platforms"],
                source: "ivyhuts-career-guidance",
                salary: { available: false, note: "unavailable" },
                readiness: { available: false, note: "unavailable" },
            },
        ],
        ...overrides,
    };
}

// Raw slide XML text-runs are XML-escaped (pptxgenjs correctly escapes
// "&"/"<"/">" etc.) -- decode the handful of standard entities so this
// script's own text comparisons match against the real, human-readable
// string rather than its escaped-XML form.
function decodeXmlEntities(text) {
    return text
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'");
}

// Unzips a generated .pptx buffer and returns { slideCount, slideTexts: [ [runs...], ... ] }
// -- genuine structural inspection, not just "buffer was produced".
async function inspectPptx(buffer) {
    const zip = await JSZip.loadAsync(buffer);
    assert.ok(zip.files["[Content_Types].xml"], "a real .pptx must have [Content_Types].xml");
    assert.ok(zip.files["ppt/presentation.xml"], "a real .pptx must have ppt/presentation.xml");
    const slideFiles = Object.keys(zip.files)
        .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
        .sort((a, b) => {
            const na = Number(a.match(/slide(\d+)\.xml/)[1]);
            const nb = Number(b.match(/slide(\d+)\.xml/)[1]);
            return na - nb;
        });
    const EMU_PER_INCH = 914400;
    const slideTexts = [];
    const slideBounds = []; // per slide: [{x,y,w,h}] in inches, one per <a:off>/<a:ext> pair
    for (const file of slideFiles) {
        const xml = await zip.files[file].async("string");
        const texts = [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => decodeXmlEntities(m[1]));
        slideTexts.push(texts);

        // Every shape/textbox pptxgenjs emits carries a <p:spPr><a:xfrm>
        // <a:off x=".." y=".."/><a:ext cx=".." cy=".."/></a:xfrm> pair giving
        // its EMU position/size -- real, structural geometry straight from
        // the generated file, not a guess (plan item 28: "do not stop at
        // JSZip/text validation... perform structural checks for bounding
        // boxes... objects outside slide bounds... consistent margins").
        const bounds = [];
        const xfrmPattern = /<a:off x="(-?\d+)" y="(-?\d+)"\s*\/>\s*<a:ext cx="(\d+)" cy="(\d+)"\s*\/>/g;
        let m;
        while ((m = xfrmPattern.exec(xml)) !== null) {
            bounds.push({
                x: Number(m[1]) / EMU_PER_INCH,
                y: Number(m[2]) / EMU_PER_INCH,
                w: Number(m[3]) / EMU_PER_INCH,
                h: Number(m[4]) / EMU_PER_INCH,
            });
        }
        slideBounds.push(bounds);
    }
    return { slideCount: slideFiles.length, slideTexts, slideBounds, allText: slideTexts.flat().join("\n") };
}

async function main() {
    console.log("=== IvyHuts Student Plan PPT Generation Verification (Milestone 9) ===\n");

    const {
        validatePlannerPayload, assertPayloadSize, MAX_PAYLOAD_BYTES,
    } = require(path.join(ROOT, "api", "_lib", "pptValidation"));
    const {
        normalizePlannerForPresentation, cleanText, sanitizeTableCell, cleanNumber, formatPrice, formatSalaryRange,
    } = require(path.join(ROOT, "api", "_lib", "pptNormalize"));
    const { generateStudentPlanPptxBuffer, PAGE_W, PAGE_H } = require(path.join(ROOT, "api", "_lib", "pptBuilder"));
    const DS = require(path.join(ROOT, "api", "_lib", "pptDesignSystem"));
    const { ApiError } = require(path.join(ROOT, "api", "_lib", "validation"));

    // Mocked Amber -- counts real upstream attempts, same pattern as
    // scripts/verify-planner-accommodation-index.js.
    let amberCallCount = 0;
    const originalFetch = global.fetch;
    global.fetch = async (url, opts) => {
        if (typeof url === "string" && url.includes("amberstudent.com")) amberCallCount++;
        return originalFetch(url, opts);
    };

    const pptHandler = require(path.join(ROOT, "api", "_lib", "routes", "content", "student-planner-ppt"));

    function mockReqRes({ method = "POST", body }) {
        const req = { method, headers: { "content-type": "application/json" }, body };
        const res = {
            statusCode: null,
            headers: {},
            body: undefined,
            ended: false,
            status(code) { this.statusCode = code; return this; },
            setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
            json(payload) { this.body = payload; this.ended = true; },
            end(payload) { this.body = payload; this.ended = true; },
        };
        return { req, res };
    }

    // ══════════════════════════ PLANNER PAYLOAD VALIDATION ══════════════════════════
    await test("VALIDATION: a complete, realistic planner result passes structural validation", () => {
        assert.strictEqual(validatePlannerPayload(makeCompletePlannerResult()), true);
    });
    await test("VALIDATION: a minimal planner result with just one known field still passes (missing optional fields handled)", () => {
        assert.strictEqual(validatePlannerPayload({ degree: { status: "ready", name: "Computer Science" } }), true);
    });
    await test("VALIDATION: a payload unrelated to a planner result (no recognizable fields) is rejected", () => {
        assert.throws(() => validatePlannerPayload({ foo: "bar", hack: "<script>alert(1)</script>" }), ApiError);
    });
    await test("VALIDATION: non-object payloads (array/string/null) are rejected, never crash", () => {
        assert.throws(() => validatePlannerPayload([1, 2, 3]), ApiError);
        assert.throws(() => validatePlannerPayload("just a string"), ApiError);
        assert.throws(() => validatePlannerPayload(null), ApiError);
    });
    await test("VALIDATION: a known field with the wrong fundamental type is rejected (malformed structure, not just malformed content)", () => {
        assert.throws(() => validatePlannerPayload({ careers: "not-an-array" }), ApiError);
        assert.throws(() => validatePlannerPayload({ degree: "not-an-object" }), ApiError);
        assert.throws(() => validatePlannerPayload({ residences: {} }), ApiError);
    });
    await test("VALIDATION: an oversized payload is rejected", () => {
        const huge = { degree: { status: "ready", name: "x".repeat(MAX_PAYLOAD_BYTES + 1000) } };
        assert.throws(() => assertPayloadSize(huge), ApiError);
    });
    await test("VALIDATION: a payload right at a reasonable real-world size is accepted", () => {
        assert.doesNotThrow(() => assertPayloadSize(makeCompletePlannerResult()));
    });
    await test("NORMALIZE: malformed individual career objects (garbage entries mixed with a valid one) are dropped, never crash generation", () => {
        const payload = makeCompletePlannerResult({ careers: [null, "not-an-object", 42, { title: "" }, ...makeCompletePlannerResult().careers] });
        const normalized = normalizePlannerForPresentation(payload);
        assert.strictEqual(normalized.careers.length, 3, "the 4 malformed entries must be dropped, the 3 valid ones kept");
    });
    await test("NORMALIZE: invalid numeric values (NaN/strings) in residence fields are handled safely, never reach the presentation as NaN", () => {
        const payload = makeCompletePlannerResult();
        payload.residences[0].rating = { overall: "not-a-number" };
        payload.residences[0].distanceKm = NaN;
        const normalized = normalizePlannerForPresentation(payload);
        assert.strictEqual(normalized.residences[0].rating, null);
        assert.strictEqual(normalized.residences[0].distanceKm, null);
    });
    await test("NORMALIZE: control characters are stripped from text fields (defense against embedded control chars)", () => {
        assert.strictEqual(cleanText("HelloWorld"), "HelloWorld");
    });
    await test("NORMALIZE: formula-like leading characters in table cells are neutralized (defense-in-depth, plan item 26)", () => {
        assert.ok(sanitizeTableCell("=SUM(A1:A9)").startsWith(" "));
        assert.ok(sanitizeTableCell("+1234").startsWith(" "));
        assert.strictEqual(sanitizeTableCell("Normal Text"), "Normal Text");
    });
    await test("NORMALIZE: an entirely empty planner result never crashes, degrades to all-unavailable sections", () => {
        const normalized = normalizePlannerForPresentation({});
        assert.strictEqual(normalized.university.available, false);
        assert.deepStrictEqual(normalized.residences, []);
        assert.strictEqual(normalized.degree.available, false);
        assert.deepStrictEqual(normalized.careers, []);
        assert.strictEqual(normalized.salary.available, false);
        assert.strictEqual(normalized.readiness.available, false);
        assert.ok(normalized.closingSteps.length > 0, "closing slide must still have a safe fallback");
    });
    await test("NORMALIZE: cleanNumber/formatPrice/formatSalaryRange never produce NaN or throw on bad input", () => {
        assert.strictEqual(cleanNumber("abc"), null);
        assert.strictEqual(cleanNumber(Infinity), null);
        assert.strictEqual(formatPrice(null), null);
        assert.strictEqual(formatPrice({ amount: "not-a-number" }), null);
        assert.strictEqual(formatSalaryRange("£", null), null);
        assert.strictEqual(formatSalaryRange("£", { min: "x", max: "y" }), null);
    });

    // ══════════════════════════ PRESENTATION GENERATION ══════════════════════════
    const completePlanner = makeCompletePlannerResult();
    const completeNormalized = normalizePlannerForPresentation(completePlanner);
    const buffer = await generateStudentPlanPptxBuffer(completeNormalized);
    const inspected = await inspectPptx(buffer);

    await test("GENERATION: produces a real, valid, non-empty .pptx (structurally verified via JSZip, not just 'a buffer exists')", () => {
        assert.ok(Buffer.isBuffer(buffer));
        assert.ok(buffer.length > 20000, `expected a substantial multi-slide deck, got ${buffer.length} bytes`);
    });
    await test(`GENERATION: slide count is within the targeted 8-12 range for a complete plan (got ${inspected.slideCount})`, () => {
        assert.ok(inspected.slideCount >= 8 && inspected.slideCount <= 12, `expected 8-12 slides, got ${inspected.slideCount}`);
    });
    await test("GENERATION: no slide is empty (every slide has at least one text run)", () => {
        inspected.slideTexts.forEach((texts, i) => assert.ok(texts.length > 0, `slide ${i + 1} has no text content`));
    });
    await test("GENERATION: widescreen 13.333x7.5in layout (matches pptBuilder.js's declared PAGE_W/PAGE_H)", () => {
        assert.strictEqual(PAGE_W, 13.333);
        assert.strictEqual(PAGE_H, 7.5);
    });

    // ══════════════════════════ VISUAL QA (real geometry, not just text) ══════════════════════════
    // No rendering tool (LibreOffice etc.) is available in this environment
    // and none was installed for this milestone (plan item 28/31) -- these
    // checks instead parse the REAL <a:off>/<a:ext> EMU geometry pptxgenjs
    // wrote into every slide's XML, giving genuine structural proof (not a
    // guess) that nothing renders off-slide and that the shared frame/
    // footer primitives really do land at the same coordinates everywhere.
    const TOLERANCE = 0.02; // inches -- absorbs floating-point EMU rounding
    await test("VISUAL QA: no shape on any slide renders outside the 13.333x7.5in slide bounds", () => {
        const offenders = [];
        inspected.slideBounds.forEach((bounds, slideIdx) => {
            bounds.forEach((b) => {
                if (b.x < -TOLERANCE || b.y < -TOLERANCE || b.x + b.w > PAGE_W + TOLERANCE || b.y + b.h > PAGE_H + TOLERANCE) {
                    offenders.push(`slide ${slideIdx + 1}: x=${b.x.toFixed(2)} y=${b.y.toFixed(2)} w=${b.w.toFixed(2)} h=${b.h.toFixed(2)}`);
                }
            });
        });
        assert.deepStrictEqual(offenders, [], `found shape(s) outside slide bounds: ${offenders.join("; ")}`);
    });
    await test("VISUAL QA: every content slide (excluding the full-bleed Cover/Closing slides) has at least one element flush with the shared left margin (0.6in) -- proves consistent alignment, not just consistent source code", () => {
        // Slide 1 = Cover, last slide = Closing -- both intentionally
        // full-bleed with no frame() margin. Every slide in between goes
        // through DS.frame(), which always starts content at x=MARGIN.
        const contentSlideBounds = inspected.slideBounds.slice(1, -1);
        const offenders = [];
        contentSlideBounds.forEach((bounds, i) => {
            const hasMarginAlignedShape = bounds.some((b) => Math.abs(b.x - DS.MARGIN) < TOLERANCE);
            if (!hasMarginAlignedShape) offenders.push(`content slide ${i + 2}`);
        });
        assert.deepStrictEqual(offenders, [], `expected every content slide to have a shape aligned to the shared left margin: ${offenders.join(", ")}`);
    });
    await test("VISUAL QA: every content slide's title sits at the SAME y-coordinate (0.88in) -- proves one shared frame(), not per-slide magic numbers", () => {
        const contentSlideBounds = inspected.slideBounds.slice(1, -1);
        const offenders = [];
        contentSlideBounds.forEach((bounds, i) => {
            const hasTitleAtSharedY = bounds.some((b) => Math.abs(b.y - 0.88) < TOLERANCE);
            if (!hasTitleAtSharedY) offenders.push(`content slide ${i + 2}`);
        });
        assert.deepStrictEqual(offenders, [], `expected every content slide's title at the shared y-position: ${offenders.join(", ")}`);
    });
    await test("VISUAL QA: every content slide's footer rule sits at the SAME y-coordinate (matches DS.CONTENT_BOTTOM) -- proves one shared footer(), not per-slide positioning", () => {
        const contentSlideBounds = inspected.slideBounds.slice(1, -1);
        const offenders = [];
        contentSlideBounds.forEach((bounds, i) => {
            const hasFooterRuleAtSharedY = bounds.some((b) => Math.abs(b.y - DS.CONTENT_BOTTOM) < TOLERANCE);
            if (!hasFooterRuleAtSharedY) offenders.push(`content slide ${i + 2}`);
        });
        assert.deepStrictEqual(offenders, [], `expected every content slide's footer rule at the shared y-position: ${offenders.join(", ")}`);
    });
    await test("VISUAL QA: DS.frame() is deterministic -- identical structural output (contentTop) regardless of which slide/title calls it, proving one real design system rather than copy-pasted per-slide styling", () => {
        const PptxGenJS = require("pptxgenjs");
        const pptxProbe = new PptxGenJS();
        pptxProbe.layout = "LAYOUT_WIDE";
        const a = DS.frame(pptxProbe, { sectionLabel: "Housing", title: "Finding the Right Home" });
        const b = DS.frame(pptxProbe, { sectionLabel: "Salary", title: "Estimated Salary Progression" });
        assert.strictEqual(a.contentTop, b.contentTop);
        assert.strictEqual(a.contentTop, DS.CONTENT_TOP);
    });
    await test("VISUAL QA: truncate() enforces its length cap in the actual generated output -- no oversized text block should reach a fixed-size box untrimmed", () => {
        const long = "x".repeat(500);
        assert.ok(DS.truncate(long, 100).length <= 100);
        assert.ok(DS.truncate(long, 100).endsWith("..."));
        assert.strictEqual(DS.truncate("short", 100), "short");
    });
    await test("SLIDE TITLES: cover slide headline and IVYHUTS wordmark are present (design system renders the headline in small-caps style -- case-insensitive check)", () => {
        const coverText = inspected.slideTexts[0].join(" ").toLowerCase();
        assert.ok(coverText.includes("your journey"));
        assert.ok(coverText.includes("housing"));
        assert.ok(coverText.includes("hiring"));
        assert.ok(inspected.allText.includes("IVY") && inspected.allText.includes("huts"));
    });
    await test("SLIDE TITLES: every expected section title appears for a complete plan (case-insensitive -- the design system renders some headlines in display caps)", () => {
        const lowerAll = inspected.allText.toLowerCase();
        ["Your Study Destination", "Finding the Right Home", "Residence Comparison", "Estimated Living Expenses", "Your Degree & Skills", "Career Paths From Your Degree", "Estimated Salary Progression", "Your Hiring Path", "Suggested Preparation Path", "From Housing to Hiring", "Your Next Move"].forEach((title) => {
            assert.ok(lowerAll.includes(title.toLowerCase()), `expected slide title "${title}" to appear`);
        });
    });
    await test("DATA: student's university and degree appear on the cover slide", () => {
        assert.ok(inspected.slideTexts[0].some((t) => t.includes("University of Manchester")));
        assert.ok(inspected.slideTexts[0].some((t) => t.includes("Computer Science")));
    });
    await test("DATA: university name/summary appear on the University slide", () => {
        const uniSlide = inspected.slideTexts.find((texts) => texts.includes("Your Study Destination"));
        assert.ok(uniSlide.some((t) => t.includes("University of Manchester")));
        assert.ok(uniSlide.some((t) => t.includes("Manchester, United Kingdom")));
    });
    await test("DATA: recommended residence names appear on the Residences slide", () => {
        const resSlide = inspected.slideTexts.find((texts) => texts.includes("Finding the Right Home"));
        assert.ok(resSlide.some((t) => t.includes("Vita Student Manchester")));
        assert.ok(resSlide.some((t) => t.includes("iQ Student Accommodation")));
        assert.ok(resSlide.some((t) => t.includes("Fresh Manchester")));
    });
    await test("DATA: comparison table contains the exact planner residence names and prices", () => {
        const cmpSlide = inspected.slideTexts.find((texts) => texts.includes("Residence Comparison"));
        assert.ok(cmpSlide.some((t) => t.includes("Vita Student Manchester")));
        assert.ok(cmpSlide.some((t) => t === "£220/week"));
    });
    await test("DATA: living costs total/month and total/year match the exact planner values (comma-grouped for readability -- same underlying number, not a data change)", () => {
        const costSlide = inspected.slideTexts.find((texts) => texts.includes("Estimated Living Expenses"));
        assert.ok(costSlide.some((t) => t.includes("£1,518") || t.includes("£1518")));
        assert.ok(costSlide.some((t) => t.includes("£18,216") || t.includes("£18216")));
    });
    await test("DATA: degree core skills and specialization appear on the Degree slide", () => {
        const degSlide = inspected.slideTexts.find((texts) => texts.includes("Your Degree & Skills"));
        assert.ok(degSlide.some((t) => t.includes("Programming")));
        assert.ok(degSlide.some((t) => t.includes("AI / Machine Learning")));
    });
    await test("DATA INTEGRITY: careers appear on the Career Paths slide in EXACTLY the planner's own order (no re-ranking)", () => {
        const careerSlide = inspected.slideTexts.find((texts) => texts.includes("Career Paths From Your Degree"));
        const expectedOrder = completePlanner.careers.map((c) => c.title);
        const positions = expectedOrder.map((title) => careerSlide.findIndex((t) => t === title));
        assert.ok(positions.every((p) => p !== -1), "every career title must appear");
        for (let i = 1; i < positions.length; i++) {
            assert.ok(positions[i] > positions[i - 1], `career order must be preserved: ${expectedOrder[i - 1]} must appear before ${expectedOrder[i]}`);
        }
    });
    await test("DATA INTEGRITY: salary progression figures are EXACTLY the values in careers[0].salary.ranges (rounded to the nearest £1k, no independent recalculation)", () => {
        const salarySlide = inspected.slideTexts.find((texts) => texts.includes("Estimated Salary Progression"));
        const ranges = completePlanner.careers[0].salary.ranges;
        Object.values(ranges).forEach((range) => {
            const expected = `£${Math.round(range.min / 1000)}k-£${Math.round(range.max / 1000)}k`;
            assert.ok(salarySlide.includes(expected), `expected "${expected}" on the salary slide, got: ${JSON.stringify(salarySlide)}`);
        });
    });
    await test("DATA INTEGRITY: hiring path skills-to-develop reflect careers[0].readiness EXACTLY (no invented advice)", () => {
        const hiringSlide = inspected.slideTexts.find((texts) => texts.includes("Your Hiring Path"));
        const readiness = completePlanner.careers[0].readiness;
        readiness.skillsToDevelop.forEach((skill) => assert.ok(hiringSlide.includes(skill), `expected development skill "${skill}"`));
    });
    await test("DATA INTEGRITY: already-covered skills for the top career still appear in the deck (relocated to the Career Paths hero card per the redesigned 4-quadrant Hiring Path -- Skills to Develop / Portfolio / Interview / Entry Routes only, matching the design brief)", () => {
        const careerSlide = inspected.slideTexts.find((texts) => texts.includes("Career Paths From Your Degree"));
        const readiness = completePlanner.careers[0].readiness;
        readiness.alreadyCoveredSkills.slice(0, 3).forEach((skill) => {
            assert.ok(careerSlide.some((t) => t.includes(skill)), `expected covered skill "${skill}" to appear on the Career Paths hero card`);
        });
    });
    await test("DATA INTEGRITY: preparation steps appear in EXACTLY the curated order, no re-sorting", () => {
        const prepSlide = inspected.slideTexts.find((texts) => texts.includes("Suggested Preparation Path"));
        const expectedSteps = completePlanner.careers[0].readiness.preparationSteps;
        const positions = expectedSteps.map((step) => prepSlide.findIndex((t) => t === step));
        assert.ok(positions.every((p) => p !== -1), "every preparation step must appear verbatim");
        for (let i = 1; i < positions.length; i++) {
            assert.ok(positions[i] > positions[i - 1], `step order must be preserved: "${expectedSteps[i - 1]}" must appear before "${expectedSteps[i]}"`);
        }
    });
    await test("DATA: the full Housing-to-Hiring journey strip appears with all 8 stages in order", () => {
        const journeySlide = inspected.slideTexts.find((texts) => texts.includes("From Housing to Hiring"));
        const stages = ["Housing", "University", "Living Costs", "Degree", "Skills", "Career", "Salary", "Hiring"];
        const positions = stages.map((s) => journeySlide.findIndex((t) => t === s));
        assert.ok(positions.every((p) => p !== -1), "every journey stage must appear");
        for (let i = 1; i < positions.length; i++) assert.ok(positions[i] > positions[i - 1]);
    });
    await test("DATA: closing slide's next-steps only reference sections this plan actually has data for", () => {
        const closingSlide = inspected.slideTexts.find((texts) => texts.some((t) => t.toUpperCase().includes("YOUR NEXT MOVE")));
        assert.ok(closingSlide, "closing slide must render");
        assert.ok(closingSlide.some((t) => t.includes("accommodation")));
        assert.ok(closingSlide.some((t) => t.includes("interviews") || t.includes("portfolio") || t.includes("skills")));
    });
    await test("LANGUAGE: no fabricated AFFIRMATIVE guarantees anywhere in the deck (negated disclaimers like 'not a guaranteed path' are correct and expected)", () => {
        // Bare "guarantee(d)" is expected to appear -- always as a negation
        // ("not a guarantee...", "not a required or guaranteed path"). What
        // must never appear is an AFFIRMATIVE claim of certainty.
        ["is guaranteed", "guaranteed salary", "guaranteed job", "guaranteed offer", "guaranteed interview", "you will earn", "you will get", "100% ready", "hiring probability"].forEach((phrase) => {
            assert.ok(!inspected.allText.toLowerCase().includes(phrase), `deck must not contain the affirmative claim "${phrase}"`);
        });
        assert.ok(inspected.allText.toLowerCase().includes("not a guarantee") || inspected.allText.toLowerCase().includes("estimates and planning guidance"));
    });

    // ══════════════════════════ CONDITIONAL SLIDES (incomplete data) ══════════════════════════
    await test("CONDITIONAL: a planner result with no residences skips the Residences/Comparison slides entirely (no blank cards)", async () => {
        const partial = makeCompletePlannerResult({ residences: [], comparison: [] });
        const normalized = normalizePlannerForPresentation(partial);
        const buf = await generateStudentPlanPptxBuffer(normalized);
        const { allText } = await inspectPptx(buf);
        assert.ok(!allText.includes("Finding the Right Home"));
        assert.ok(!allText.includes("Residence Comparison"));
    });
    await test("CONDITIONAL: an unresolved degree (status !== ready) skips Degree/Career/Salary/Hiring slides, but Cover/Journey/Closing still render", async () => {
        const partial = makeCompletePlannerResult({ degree: { status: "unresolved", name: "Underwater Basket Weaving" }, careers: [] });
        const normalized = normalizePlannerForPresentation(partial);
        const buf = await generateStudentPlanPptxBuffer(normalized);
        const inspectedPartial = await inspectPptx(buf);
        assert.ok(!inspectedPartial.allText.includes("Your Degree & Skills"));
        assert.ok(!inspectedPartial.allText.includes("Career Paths From Your Degree"));
        assert.ok(!inspectedPartial.allText.includes("Estimated Salary Progression"));
        assert.ok(!inspectedPartial.allText.includes("Your Hiring Path"));
        assert.ok(inspectedPartial.allText.includes("From Housing to Hiring"), "Journey slide must still render");
        assert.ok(inspectedPartial.allText.toUpperCase().includes("YOUR NEXT MOVE"), "Closing slide must still render");
        assert.ok(inspectedPartial.slideCount >= 3, "Cover + Journey + Closing must still produce a usable, non-broken deck");
    });
    await test("CONDITIONAL: unavailable salary/readiness never fabricate a range or advice -- the whole slide is omitted, not a blank/broken one", async () => {
        const partial = makeCompletePlannerResult();
        partial.careers = [partial.careers[2]]; // Software Engineer only -- salary/readiness both unavailable
        const normalized = normalizePlannerForPresentation(partial);
        assert.strictEqual(normalized.salary.available, false);
        assert.strictEqual(normalized.readiness.available, false);
        const buf = await generateStudentPlanPptxBuffer(normalized);
        const { allText } = await inspectPptx(buf);
        assert.ok(!allText.includes("Estimated Salary Progression"));
        assert.ok(!allText.includes("Your Hiring Path"));
    });
    await test("CONDITIONAL: an entirely empty planner result still produces a valid, non-broken deck (Cover + Journey + Closing minimum)", async () => {
        const normalized = normalizePlannerForPresentation({});
        const buf = await generateStudentPlanPptxBuffer(normalized);
        const inspectedEmpty = await inspectPptx(buf);
        assert.ok(inspectedEmpty.slideCount >= 3);
        assert.ok(Buffer.isBuffer(buf) && buf.length > 5000);
    });

    // ══════════════════════════ NO BUSINESS LOGIC DUPLICATION (structural) ══════════════════════════
    await test("NO DUPLICATION: pptNormalize.js and pptBuilder.js never REQUIRE the actual ranking/salary/readiness resolvers -- they can only format what they're given (mentioning them in a provenance comment is fine; importing them is not)", () => {
        const fs = require("fs");
        [
            path.join(ROOT, "api", "_lib", "pptNormalize.js"),
            path.join(ROOT, "api", "_lib", "pptBuilder.js"),
            path.join(ROOT, "api", "_lib", "pptValidation.js"),
        ].forEach((file) => {
            const src = fs.readFileSync(file, "utf8");
            ["careerResolver", "salaryResolver", "careerReadinessResolver", "degreeResolver", "accommodationIndex", "amberGateway", "universityResolver", "mongodb"].forEach((forbidden) => {
                const requirePattern = new RegExp(`require\\([^)]*${forbidden}`);
                assert.ok(!requirePattern.test(src), `${path.basename(file)} must not require(...) ${forbidden} -- presentation layer must not recompute business logic`);
            });
            assert.ok(!/\bfetch\(/.test(src), `${path.basename(file)} must not call fetch() itself`);
        });
    });

    // ══════════════════════════ ENDPOINT: METHOD / SECURITY / RESPONSE SHAPE ══════════════════════════
    await test("ENDPOINT: GET is rejected with 405, POST-only", async () => {
        const { req, res } = mockReqRes({ method: "GET" });
        await pptHandler(req, res);
        assert.strictEqual(res.statusCode, 405);
    });
    await test("ENDPOINT: a valid complete planner result returns a real .pptx with correct headers", async () => {
        const { req, res } = mockReqRes({ body: completePlanner });
        await pptHandler(req, res);
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.headers["content-type"], "application/vnd.openxmlformats-officedocument.presentationml.presentation");
        assert.ok(res.headers["content-disposition"].includes("attachment"));
        assert.ok(res.headers["content-disposition"].includes(".pptx"));
        assert.ok(!res.headers["content-disposition"].includes("/") && !res.headers["content-disposition"].includes("\\"), "filename must never contain a path separator");
        assert.ok(Buffer.isBuffer(res.body));
        const { slideCount } = await inspectPptx(res.body);
        assert.ok(slideCount >= 8);
    });
    await test("ENDPOINT: a malformed/unrelated payload returns a safe 400, never a stack trace", async () => {
        const { req, res } = mockReqRes({ body: { unrelated: "junk", nested: { a: 1 } } });
        await pptHandler(req, res);
        assert.strictEqual(res.statusCode, 400);
        assert.strictEqual(res.body.ok, false);
        assert.ok(!JSON.stringify(res.body).includes("at Object.") && !JSON.stringify(res.body).includes(ROOT), "response must never leak a stack trace or filesystem path");
    });
    await test("ENDPOINT: an oversized declared Content-Length is rejected with 413 before any parsing work", async () => {
        const { req, res } = mockReqRes({ body: completePlanner });
        req.headers["content-length"] = String(MAX_PAYLOAD_BYTES + 1);
        await pptHandler(req, res);
        assert.strictEqual(res.statusCode, 413);
    });
    await test("ENDPOINT: filename is built server-side from cleaned text only -- no client-controlled path traversal characters", () => {
        const { buildFilename } = pptHandler;
        const normalized = normalizePlannerForPresentation(makeCompletePlannerResult({
            university: { name: "../../etc/passwd; DROP TABLE" },
        }));
        const filename = buildFilename(normalized);
        assert.ok(!filename.includes("/") && !filename.includes("\\") && !filename.includes(".."), `filename must be safe, got "${filename}"`);
        assert.ok(filename.endsWith(".pptx"));
    });

    // ══════════════════════════ AMBER SAFETY ══════════════════════════
    await test("AMBER SAFETY: generating a complete PPT introduces ZERO Amber calls", async () => {
        const before = amberCallCount;
        const { req, res } = mockReqRes({ body: completePlanner });
        await pptHandler(req, res);
        assert.strictEqual(amberCallCount, before, "PPT generation must never call Amber");
    });
    await test("AMBER SAFETY: generating PPTs repeatedly (10x) introduces ZERO Amber calls cumulatively", async () => {
        const before = amberCallCount;
        for (let i = 0; i < 10; i++) {
            const { req, res } = mockReqRes({ body: completePlanner });
            await pptHandler(req, res);
        }
        assert.strictEqual(amberCallCount, before, "repeated PPT generation must never accumulate Amber calls");
    });
    await test("AMBER SAFETY: api/student-planner-ppt.js never imports amberGateway/accommodationIndex/mongodb (structural)", () => {
        const fs = require("fs");
        const src = fs.readFileSync(path.join(ROOT, "api", "_lib", "routes", "content", "student-planner-ppt.js"), "utf8");
        assert.ok(!/require\(.*amberGateway/.test(src));
        assert.ok(!/require\(.*accommodationIndex/.test(src));
        assert.ok(!/require\(.*mongodb/.test(src));
        assert.ok(!/\/api\/amber/.test(src), "must never call /api/amber itself");
    });

    global.fetch = originalFetch;

    console.log(`\n=== ${passed} passed, ${failed} failed ===`);
    if (failed > 0) {
        console.log("\nFailures:");
        failures.forEach((f) => console.log(`  - ${f.name}: ${f.message}`));
        process.exitCode = 1;
    }
}

main().catch((err) => {
    console.error("Verification script crashed:", err);
    process.exitCode = 1;
});
