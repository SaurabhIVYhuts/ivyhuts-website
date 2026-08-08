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

module.exports = { sendEnquiryEmail };
