// Reusable email service — the only place in this deployment that talks to
// FormSubmit (https://formsubmit.co). Config comes from environment
// variables only (never hardcoded).
//
// Unlike the rest of the enquiry pipeline (which is fire-and-forget and must
// never break the form's success screen), THIS module fails loudly: it
// throws on missing config or a failed send, with a full log trail at every
// step. The caller (api/enquire.js) is what decides how to turn that into an
// HTTP response — this module's job is just to never lie about whether the
// email actually went out.
//
// FormSubmit needs no API key — it's a plain POST to
// https://formsubmit.co/ajax/{recipient}. The recipient in the URL is the
// "primary" address; the free tier's `_cc` field fans out to the rest of
// ENQUIRY_NOTIFY_EMAILS. NOTE: the first time any address is used with
// FormSubmit, they email that address a one-time activation link — until
// it's clicked, sends to it silently fail (FormSubmit still returns success
// from the API), so every address in ENQUIRY_NOTIFY_EMAILS must be
// activated once before notifications actually arrive there.
const FORMSUBMIT_ENDPOINT = "https://formsubmit.co/ajax/";

// FormSubmit rejects AJAX requests that arrive with no Referer header (it's
// how it tells a real webpage submission apart from a bare script/file://
// request) and ties an activated address to the domain that first triggered
// activation — so this MUST be the production site's own URL, not a generic
// placeholder. Override via env if the site is ever served from elsewhere.
const SITE_URL = process.env.SITE_URL || "https://ivyhuts.com/";

// `fields`: ordered [label, value] pairs. Resolves with { sent: true } on
// real success. Throws on ANY failure (no recipients configured, FormSubmit
// HTTP/API error) — it never silently returns a false "sent: false" the
// caller might miss.
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
    const [primary, ...cc] = recipients;
    console.log(`[mailer] Recipients: primary=${primary}${cc.length ? ` cc=${cc.join(", ")}` : ""}`);

    const payload = {
        _subject: "New IVYHUTS Property Enquiry",
        _template: "table",
        _captcha: "false",
    };
    if (cc.length > 0) payload._cc = cc.join(",");
    for (const [label, value] of fields) {
        payload[label] = value ?? "";
    }

    console.log("[mailer] Sending via FormSubmit...");
    let response;
    try {
        response = await fetch(`${FORMSUBMIT_ENDPOINT}${encodeURIComponent(primary)}`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
                Referer: SITE_URL,
                Origin: SITE_URL.replace(/\/$/, ""),
            },
            body: JSON.stringify(payload),
        });
    } catch (err) {
        console.error("[mailer] FormSubmit request FAILED:", err.message);
        console.error(err.stack);
        throw err;
    }

    let result = null;
    try {
        result = await response.json();
    } catch {
        // FormSubmit returns non-JSON on some error paths — fall through to
        // the !response.ok check below with result left null.
    }

    if (!response.ok || (result && result.success === "false")) {
        const message = (result && (result.message || result.error)) || `FormSubmit returned HTTP ${response.status}`;
        console.error("[mailer] FormSubmit send FAILED:", message);
        throw new Error(message);
    }

    console.log(`[mailer] Email sent successfully — response=${JSON.stringify(result)}`);
    return { sent: true };
}

module.exports = { sendEnquiryEmail };
