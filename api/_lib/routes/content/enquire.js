// Vercel serverless function — receives enquiry-form submissions and fires
// an email notification via ./_lib/mailer.js.
//
// This endpoint's own response is honest: it returns 200/emailSent:true only
// once the email has actually been sent, and a proper error status if it
// wasn't — it never fakes success. That said, the *enquiry form itself*
// (src/pages/AccommodationFinderPage.js) calls this fire-and-forget and does
// not read the response, by original design — a mail failure here must
// never block or fail the visitor's enquiry submission, only be logged.
const { sendEnquiryEmail } = require("../../mailer");

module.exports = async (req, res) => {
    if (req.method !== "POST") {
        res.status(405).json({ error: "Method not allowed" });
        return;
    }

    console.log("[enquire] Request received");

    let body = req.body;
    if (!body || typeof body === "string") {
        try { body = JSON.parse(body || "{}"); } catch { body = {}; }
    }
    body = body || {};
    console.log("[enquire] Payload received:", JSON.stringify(body));

    const fields = [
        ["Property Name", body.propertyName || "N/A — General Enquiry"],
        ["Property ID", body.propertyId || "N/A"],
        // Room/tenancy context (audit fix) — a specific-room enquiry (see
        // src/pages/ContactPage.js) previously dropped the room, price,
        // duration and move-in/out dates entirely once it reached this, the
        // one channel whose delivery actually gates a confirmed submission
        // (see ContactPage.js's own comment on /api/enquire being "the one
        // destination whose result we actually wait for"). Staff replying
        // from this inbox had no record of which price/tenancy the student
        // was quoted — the Google Sheets and MongoDB destinations already
        // carried this data correctly, this just brings the email in line.
        ["Room Name", body.roomName],
        ["Room ID", body.roomId],
        ["Tenancy ID", body.tenancyId],
        ["Duration", body.duration],
        ["Move In", body.moveIn],
        ["Move Out", body.moveOut],
        ["Price", body.price],
        ["Student Name", body.studentName],
        ["Student Email", body.studentEmail],
        ["Phone Number", body.phoneNumber],
        ["University", body.university],
        ["Preferred City", body.preferredCity],
        ["Message", body.message],
        ["Timestamp", new Date().toLocaleString("en-GB", { timeZone: "UTC" }) + " UTC"],
        ["Website Source", body.websiteSource || "ivyhuts.com"],
    ];

    try {
        await sendEnquiryEmail(fields);
        res.status(200).json({ ok: true, emailSent: true });
    } catch (err) {
        // Never let a mail failure crash the function (no unhandled
        // exception/500 page) — but also never claim it succeeded when it
        // didn't. Full error is in the server logs for debugging.
        console.error("[enquire] Email notification FAILED:", err.message);
        res.status(502).json({
            ok: false,
            emailSent: false,
            error: "email_failed",
            message: "We received your enquiry, but the notification email could not be sent.",
        });
    }
};
