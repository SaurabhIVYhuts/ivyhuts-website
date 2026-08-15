// Reusable email service — builds the notification HTML with Mailgen and
// sends it via Resend's API. Config comes from environment variables only
// (never hardcoded).
//
// History: this originally used FormSubmit's AJAX API, which turned out to
// block server-to-server requests from cloud/datacenter IPs (like Vercel's)
// as suspected bot traffic — confirmed by reproducing the identical request
// from a residential IP (succeeded) vs. from the deployed function (403 for
// every submission). A brief SMTP+nodemailer version replaced it, but was
// itself swapped for Resend to avoid SMTP host/port/app-password setup —
// Resend needs only a single API key.
//
// Unlike the rest of the enquiry pipeline (which is fire-and-forget and must
// never break the form's success screen), THIS module fails loudly: it
// throws on missing config or a failed send, with a full log trail at every
// step. The caller (api/enquire.js) is what decides how to turn that into an
// HTTP response — this module's job is just to never lie about whether the
// email actually went out.
const Mailgen = require("mailgen");
const { Resend } = require("resend");

// Used only for the cosmetic "view this email" / copyright link Mailgen
// prints in the template footer — has no bearing on delivery.
const SITE_URL = process.env.SITE_URL || "https://www.ivyhuts.com/";

const mailGenerator = new Mailgen({
    theme: "default",
    product: { name: "IVYhuts", link: SITE_URL },
});

// `fields`: ordered [label, value] pairs. Resolves with { sent: true } on
// real success. Throws on ANY failure (no recipients configured, missing
// Resend API key, Resend API error) — it never silently returns a false
// "sent: false" the caller might miss.
async function sendEnquiryEmail(fields) {
    const recipients = String(process.env.ENQUIRY_NOTIFY_EMAILS || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    if (recipients.length === 0) {
        const message = "ENQUIRY_NOTIFY_EMAILS is not set — no recipients to notify";
        console.error(`[mailer] FAIL-FAST — ${message}`);
        throw new Error(message);
    }

    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
        const message = "RESEND_API_KEY is not set — cannot send enquiry emails";
        console.error(`[mailer] FAIL-FAST — ${message}`);
        throw new Error(message);
    }
    // Sandbox default: only deliverable to the Resend account's own verified
    // email until a real sending domain is added and verified in Resend.
    const from = process.env.RESEND_FROM || "IVYhuts <onboarding@resend.dev>";

    console.log(`[mailer] Recipients: ${recipients.join(", ")}`);

    const email = {
        body: {
            name: "IVYhuts Team",
            intro: "A new enquiry has just come in from the website.",
            table: {
                data: fields
                    .filter(([, value]) => value !== undefined)
                    .map(([label, value]) => ({ Field: label, Details: value ?? "N/A" })),
            },
            outro: "This is an automated notification — reply directly to the enquirer using the email above.",
        },
    };
    const html = mailGenerator.generate(email);
    const text = mailGenerator.generatePlaintext(email);

    const resend = new Resend(apiKey);

    console.log("[mailer] Sending via Resend...");
    let data, error;
    try {
        ({ data, error } = await resend.emails.send({
            from,
            to: recipients,
            subject: "New IVYHUTS Property Enquiry",
            html,
            text,
        }));
    } catch (err) {
        console.error("[mailer] Resend request FAILED:", err.message);
        console.error(err.stack);
        throw err;
    }

    if (error) {
        const message = error.message || JSON.stringify(error);
        console.error("[mailer] Resend send FAILED:", message);
        throw new Error(message);
    }

    console.log(`[mailer] Email sent successfully via Resend — id=${data && data.id}`);
    return { sent: true };
}

// "YYYY-MM-DD" (IST calendar day, see istDateString in
// insightsSnapshotStore.js) -> "12 August 2026". Rendered as a UTC date
// deliberately — the string is already a calendar day, not an instant, so
// this only needs to avoid the local Node process's timezone shifting which
// day it prints.
function formatDateLong(dateStr) {
    const [y, m, d] = dateStr.split("-").map(Number);
    const date = new Date(Date.UTC(y, m - 1, d));
    return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(date);
}

function formatPrice(value, currency) {
    return value == null ? "—" : `${currency || ""}${value.toLocaleString()}`;
}

function formatPct(value) {
    return value == null ? "—" : `${value.toFixed(1)}%`;
}

// Only ever describes real deltas between two stored snapshots — never a
// fabricated trend. Returns an explicit "no comparison" line when there's no
// previous snapshot yet, per the spec's "Comparison unavailable" rule.
function movementLines(snapshot, comparison) {
    if (!comparison || !comparison.previous) return ["No prior snapshot to compare against yet."];
    const prev = comparison.previous;
    const lines = [];
    if (Number.isFinite(snapshot.soldOutInventory) && Number.isFinite(prev.soldOutInventory)) {
        const delta = snapshot.soldOutInventory - prev.soldOutInventory;
        if (delta !== 0) lines.push(`${delta > 0 ? "↑" : "↓"} Sold-out inventory ${delta > 0 ? "+" : ""}${delta.toLocaleString()} vs previous day`);
    }
    const curCity = (snapshot.cities || [])[0];
    const prevCity = curCity && (prev.cities || []).find((c) => c.city === curCity.city);
    if (curCity && prevCity) {
        const delta = curCity.soldOut - prevCity.soldOut;
        if (delta !== 0) lines.push(`${delta > 0 ? "↑" : "↓"} ${curCity.city} sold-out ${delta > 0 ? "+" : ""}${delta} vs previous day`);
    }
    return lines.length ? lines : ["No material change vs previous day."];
}

// Sends the 08:00 IST daily report built by api/_lib/insightsDigest.js.
// `snapshot` is an api/_lib/models/InsightSnapshot document (lean object);
// `comparison` is `{previous, sevenDayAvg}` or null. Same fail-loud contract
// as sendEnquiryEmail above — the caller (insightsDigest.js) is responsible
// for catching this and recording the failure without losing the snapshot.
async function sendInsightsDigestEmail(snapshot, comparison) {
    const recipients = String(process.env.INSIGHTS_REPORT_RECIPIENTS || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    if (recipients.length === 0) {
        const message = "INSIGHTS_REPORT_RECIPIENTS is not set — no recipients to notify";
        console.error(`[mailer] FAIL-FAST — ${message}`);
        throw new Error(message);
    }
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
        const message = "RESEND_API_KEY is not set — cannot send insights digest email";
        console.error(`[mailer] FAIL-FAST — ${message}`);
        throw new Error(message);
    }
    const from = process.env.RESEND_FROM || "IVYhuts <onboarding@resend.dev>";

    const dateLabel = formatDateLong(snapshot.date);
    const topCountries = (snapshot.countries || []).slice(0, 5);
    const topCities = (snapshot.cities || []).slice(0, 5);
    const topPostcodes = (snapshot.postcodes || []).slice(0, 5);

    const rows = [
        { Metric: "Total Inventory", Value: snapshot.totalInventory != null ? snapshot.totalInventory.toLocaleString() : "—" },
        { Metric: "Sold Out", Value: snapshot.soldOutInventory != null ? snapshot.soldOutInventory.toLocaleString() : "—" },
        { Metric: "Sold Out %", Value: formatPct(snapshot.soldOutPercentage) },
    ];
    topCountries.forEach((c, i) =>
        rows.push({ Metric: `Top Country #${i + 1}`, Value: `${c.country} — ${c.soldOut.toLocaleString()} sold out (${formatPct(c.soldOutShare != null ? c.soldOutShare * 100 : null)})` })
    );
    topCities.forEach((c, i) => rows.push({ Metric: `Top Market #${i + 1}`, Value: `${c.city} — ${c.soldOut.toLocaleString()} sold out` }));
    // Only shown when real postcode data was actually captured — never a
    // padded/empty section (spec §3C: "Only show postcode analysis when
    // reliable postcode data exists").
    topPostcodes.forEach((p, i) => rows.push({ Metric: `Top Postcode #${i + 1}`, Value: `${p.postcode} (${p.city}) — ${p.soldOut.toLocaleString()} sold out` }));
    if (snapshot.pricing && snapshot.pricing.average != null) {
        rows.push({ Metric: "Average Asking Price (Sold-Out)", Value: formatPrice(snapshot.pricing.average, snapshot.pricing.currency) });
        rows.push({ Metric: "Median Asking Price (Sold-Out)", Value: formatPrice(snapshot.pricing.median, snapshot.pricing.currency) });
    }
    rows.push({ Metric: "Data Source", Value: "Amber" });
    rows.push({ Metric: "Cache Status", Value: snapshot.cache?.crawlComplete ? "Fresh — full catalog crawl complete" : "Partial — catalog crawl still in progress" });
    rows.push({ Metric: "Snapshot Generated", Value: `${dateLabel}, 08:00 IST` });

    const email = {
        body: {
            name: "IVYhuts Team",
            intro: [
                `IVYHUTS Daily Market Intelligence — ${dateLabel}`,
                `${snapshot.soldOutInventory != null ? snapshot.soldOutInventory.toLocaleString() : "—"} of ${
                    snapshot.totalInventory != null ? snapshot.totalInventory.toLocaleString() : "—"
                } tracked properties are sold out (${formatPct(snapshot.soldOutPercentage)}).`,
            ],
            table: { data: rows },
            outro: [`Key movements: ${movementLines(snapshot, comparison).join(" · ")}`, "This is an automated daily report — reply is not monitored."],
            action: {
                instructions: "View the full interactive dashboard:",
                button: { color: "#5E3A6B", text: "View Full Dashboard", link: `${SITE_URL.replace(/\/$/, "")}/insight` },
            },
        },
    };
    const html = mailGenerator.generate(email);
    const text = mailGenerator.generatePlaintext(email);
    const resend = new Resend(apiKey);

    console.log("[mailer] Sending insights digest via Resend...");
    let data, error;
    try {
        ({ data, error } = await resend.emails.send({
            from,
            to: recipients,
            subject: `IVYHUTS Daily Market Intelligence — ${dateLabel}`,
            html,
            text,
        }));
    } catch (err) {
        console.error("[mailer] Resend request FAILED (insights digest):", err.message);
        throw err;
    }
    if (error) {
        const message = error.message || JSON.stringify(error);
        console.error("[mailer] Resend send FAILED (insights digest):", message);
        throw new Error(message);
    }

    console.log(`[mailer] Insights digest email sent — id=${data && data.id}`);
    return { sent: true };
}

// Sent instead of the full report whenever insightsDigest.js decides NOT to
// save a snapshot today — either a real failure (crawl state completely
// empty) or a benign deferral (crawl legitimately still counting the
// catalog, so writing a snapshot now would mean recording partial data).
// `status` only changes the subject line's framing; the body always explains
// the real reason via `errorMessage`.
async function sendInsightsFailureAlertEmail(dateStr, errorMessage, status = "failed") {
    const recipients = String(process.env.INSIGHTS_REPORT_RECIPIENTS || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    if (recipients.length === 0) throw new Error("INSIGHTS_REPORT_RECIPIENTS is not set — no recipients to notify");
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) throw new Error("RESEND_API_KEY is not set — cannot send insights failure alert");
    const from = process.env.RESEND_FROM || "IVYhuts <onboarding@resend.dev>";
    const dateLabel = formatDateLong(dateStr);

    const subjectLabel = status === "skipped" ? "snapshot deferred" : "snapshot failed";
    const headline = status === "skipped" ? `Today's market-intelligence snapshot for ${dateLabel} was deferred.` : `The daily market-intelligence snapshot for ${dateLabel} could not be generated.`;

    const email = {
        body: {
            name: "IVYhuts Team",
            intro: [
                headline,
                `Reason: ${errorMessage}`,
                "The previous day's snapshot remains available on the dashboard — no existing data was lost or overwritten.",
            ],
            outro: "This is an automated alert from the /insight snapshot job.",
        },
    };
    const html = mailGenerator.generate(email);
    const text = mailGenerator.generatePlaintext(email);
    const resend = new Resend(apiKey);

    const { error } = await resend.emails.send({
        from,
        to: recipients,
        subject: `IVYHUTS Market Intelligence — ${subjectLabel} (${dateLabel})`,
        html,
        text,
    });
    if (error) throw new Error(error.message || JSON.stringify(error));
    return { sent: true };
}

module.exports = { sendEnquiryEmail, sendInsightsDigestEmail, sendInsightsFailureAlertEmail };
