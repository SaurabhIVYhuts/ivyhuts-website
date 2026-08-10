// Milestone 3 — fire-and-forget POST to /api/enquiries (MongoDB), fired
// alongside the existing Google Sheets + api/enquire.js (email) flow in
// each enquiry form. See docs/marketing-data-architecture.md §12.12/§13 for
// how the three destinations coexist.
//
// Deliberately never awaited by callers and never throws: a temporary
// MongoDB outage here must not delay or fail the Sheets/email submission
// that already ran, and must never flip an otherwise-successful form
// submission to an error state. Callers should call this fire-and-forget,
// exactly like the existing fetch("/api/enquire") calls, and keep showing
// their success screen regardless of this call's outcome.
//
// Identity is never sent from here — the backend derives userId from the
// session cookie (same-origin fetch sends it automatically) or treats the
// visitor as anonymous; see api/_lib/businessAuth.js.
export function submitEnquiryToMongo(payload, tag) {
  try {
    fetch("/api/enquiries", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then((res) => res.json().catch(() => ({})).then((resBody) => ({ ok: res.ok, resBody })))
      .then(({ ok, resBody }) => {
        if (ok) {
          console.log(`[${tag}] Enquiry recorded in MongoDB (id: ${resBody?.data?.id || "unknown"})`);
        } else {
          console.error(`[${tag}] MongoDB enquiry capture failed:`, resBody?.error?.message || "unknown error");
        }
      })
      .catch((err) => console.error(`[${tag}] /api/enquiries request failed:`, err.message));
  } catch (_) {}
}
