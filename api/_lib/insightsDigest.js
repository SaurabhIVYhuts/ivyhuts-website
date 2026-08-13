// Core logic for the 08:00 IST daily market-intelligence job. Triggered by
// api/insights/daily-digest.js (Vercel Cron, CRON_SECRET-protected) — also
// the manual-test entry point, since calling that endpoint by hand runs the
// exact same code path a real 08:00 IST run would.
//
// Pipeline: top up the existing Amber crawl (api/_lib/insightsMarket.js) ->
// build the full breakdown -> persist a snapshot (api/_lib/insightsSnapshotStore.js)
// -> compare against history -> email the report (api/_lib/mailer.js). Every
// step is wrapped so a failure downstream (email) never undoes success
// upstream (the saved snapshot), and a total Amber outage never destroys a
// previous day's data — see the module-level comments below for exactly how.
//
// A snapshot is ONLY ever written once the crawl has counted the entire
// catalog (crawlProgress.complete === true) — never a partial pass. If the
// crawl isn't done yet when this runs, nothing is saved and an alert email
// explains why; the previous day's snapshot stays the latest until a later
// run (or a manual retrigger) catches the crawl complete.
const { loadCrawlState, advanceCrawl, buildFullBreakdown } = require("./insightsMarket");
const { getInventoryStats } = require("./inventoryStats");
const { istDateString, saveSnapshot, getPreviousSnapshot, getRecentSnapshots, updateSnapshotEmailStatus } = require("./insightsSnapshotStore");
const { sendInsightsDigestEmail, sendInsightsFailureAlertEmail } = require("./mailer");

// Best-effort top-up budget — bounded well under any reasonable serverless
// maxDuration so this function can never be the reason the cron invocation
// times out. The crawl is also kept warm independently by
// api/insights/advance-crawl.js every 5 minutes, so this top-up is
// insurance, not the primary mechanism for catalog completeness.
const TOPUP_BUDGET_MS = 45_000;
const TOPUP_POLL_DELAY_MS = 3_000;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function topUpCrawl() {
    const startedAt = Date.now();
    let state = await advanceCrawl();
    while (!(state.soldOut.done && state.available.done) && Date.now() - startedAt < TOPUP_BUDGET_MS) {
        await sleep(TOPUP_POLL_DELAY_MS);
        state = await advanceCrawl();
    }
    return state;
}

function average(nums) {
    const valid = nums.filter((n) => Number.isFinite(n));
    return valid.length ? Math.round((valid.reduce((s, n) => s + n, 0) / valid.length) * 10) / 10 : null;
}

// Real average of whatever stored snapshots exist in the trailing window —
// never a fabricated 7-day figure when fewer than 7 days of history exist
// yet (sampleSize on the result makes that transparent to the caller).
function computeSevenDayAvg(docs) {
    if (!docs || docs.length === 0) return null;
    return {
        sampleSize: docs.length,
        totalInventory: average(docs.map((d) => d.totalInventory)),
        soldOutInventory: average(docs.map((d) => d.soldOutInventory)),
        soldOutPercentage: average(docs.map((d) => d.soldOutPercentage)),
        averageAskingPrice: average(docs.map((d) => d.pricing?.average)),
    };
}

async function buildComparison(date) {
    try {
        const [previous, recent] = await Promise.all([getPreviousSnapshot(date), getRecentSnapshots(date, 7)]);
        if (!previous) return null; // "Comparison unavailable" — no prior snapshot to compare against
        return { previous, sevenDayAvg: computeSevenDayAvg(recent) };
    } catch (err) {
        console.error("[insights-digest] comparison lookup failed (non-fatal):", err.message);
        return null;
    }
}

async function runDailyDigest() {
    const date = istDateString();
    const generatedAt = new Date();

    let state;
    try {
        state = await topUpCrawl();
    } catch (err) {
        // advanceCrawl() itself never throws for ordinary Amber issues (it
        // swallows and stops early) — a throw here means something more
        // fundamental (e.g. Redis unavailable). Fall back to whatever the
        // last successfully persisted crawl state was, if any.
        console.error("[insights-digest] crawl top-up failed, falling back to last persisted state:", err.message);
        state = await loadCrawlState();
    }

    const siteWide = await getInventoryStats();
    const breakdown = buildFullBreakdown(state, siteWide, {});

    // A snapshot is only ever saved once the crawl has counted every single
    // property in Amber's catalog (both the sold-out and available sides) —
    // never a partial catalog pass. Two sub-cases:
    //   - itemsCounted === 0: nothing at all has been crawled yet (first-ever
    //     run, or a total/sustained Amber outage) — treated as a real failure.
    //   - itemsCounted > 0 but not complete: the crawl is legitimately still
    //     working through the catalog (normally kept warm by
    //     api/insights/advance-crawl.js's 5-minute cadence, so this should be
    //     rare by 08:00 IST) — not an error, just not ready yet. Either way,
    //     nothing is written and any previous day's snapshot is untouched;
    //     today's dashboard/email simply has to wait for a later run.
    if (!breakdown.crawlProgress.complete) {
        const counted = breakdown.coverage.itemsCounted;
        const expected = breakdown.coverage.itemsExpected;
        const isEmpty = counted === 0;
        const reason = isEmpty
            ? "No Amber inventory data is available yet — the catalog crawl has not accumulated any results."
            : `The catalog crawl has not finished counting the full inventory yet (${counted.toLocaleString()}${
                  expected != null ? ` of ${expected.toLocaleString()}` : ""
              } items counted) — deferring today's snapshot until it completes, so no partial data ever gets recorded.`;
        console.warn(`[insights-digest] ${isEmpty ? "FAILED" : "DEFERRED"} date=${date} reason=${reason}`);
        let alertSent = false;
        let alertError = null;
        try {
            await sendInsightsFailureAlertEmail(date, reason, isEmpty ? "failed" : "skipped");
            alertSent = true;
        } catch (err) {
            alertError = err.message;
            console.error("[insights-digest] failure-alert email also failed:", err.message);
        }
        return { ok: false, date, status: isEmpty ? "failed" : "skipped", reason, alertSent, alertError, coverage: breakdown.coverage };
    }

    const payload = {
        generatedAt,
        source: "amber",
        status: "success",
        error: null,
        totalInventory: breakdown.totalInventory,
        availableInventory: breakdown.availableInventory,
        soldOutInventory: breakdown.soldOutInventory,
        soldOutPercentage: breakdown.soldOutPercentage,
        siteWide: breakdown.siteWide,
        crawlProgress: breakdown.crawlProgress,
        coverage: breakdown.coverage,
        countries: breakdown.countries,
        cities: breakdown.cities,
        postcodes: breakdown.postcodes,
        properties: breakdown.properties,
        pricing: breakdown.pricing,
        // No real booking-transaction data exists in Amber's responses today
        // (see insightsMarket.js's normalizeItem) — recorded honestly rather
        // than fabricated. The shape supports being populated later without
        // any snapshot/dashboard redesign.
        bookingLeadTime: {
            available: false,
            message: "Booking lead-time data unavailable — no booking transaction data is currently captured.",
        },
        cache: {
            crawlComplete: breakdown.crawlProgress.complete,
            itemsCounted: breakdown.coverage.itemsCounted,
            itemsExpected: breakdown.coverage.itemsExpected,
        },
        email: { sent: false, sentAt: null, error: null },
    };

    let saved;
    try {
        saved = await saveSnapshot(date, payload);
    } catch (err) {
        // Storage failure: do NOT claim success, and nothing overwrote the
        // previous day's document (the upsert never ran).
        console.error(`[insights-digest] FAILED to save snapshot date=${date}:`, err.message);
        return { ok: false, date, status: "failed", reason: "storage_failed", error: err.message };
    }

    const comparison = await buildComparison(date);

    let emailSent = false;
    let emailError = null;
    try {
        await sendInsightsDigestEmail(saved, comparison);
        emailSent = true;
        await updateSnapshotEmailStatus(date, { sent: true, sentAt: new Date(), error: null });
    } catch (err) {
        emailError = err.message;
        console.error(`[insights-digest] email send FAILED date=${date}:`, err.message);
        // The snapshot itself is already safely saved above — a mail
        // failure only ever updates the email sub-document, never the
        // snapshot data, and is surfaced on the dashboard's Cache/Data
        // Status card via this same field.
        try {
            await updateSnapshotEmailStatus(date, { sent: false, sentAt: null, error: emailError });
        } catch (inner) {
            console.error("[insights-digest] could not even record the email failure:", inner.message);
        }
    }

    console.log(`[insights-digest] date=${date} status=success emailSent=${emailSent} itemsCounted=${breakdown.coverage.itemsCounted}`);
    return { ok: true, date, status: "success", saved: true, emailSent, emailError, coverage: breakdown.coverage };
}

module.exports = { runDailyDigest };
