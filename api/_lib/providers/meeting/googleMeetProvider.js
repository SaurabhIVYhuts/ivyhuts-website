// Real Google Meet provider — Milestone 23.14.
//
// Creates an actual Google Calendar event with a real Google Meet
// conference attached (the standard, correct way to obtain a genuine
// meet.google.com link via API — there is no separate "just create a Meet
// link" endpoint; Meet links are always minted as part of a Calendar
// event's conferenceData). Requires Google Workspace domain-wide
// delegation (the service account impersonates a real Workspace user via
// GOOGLE_WORKSPACE_IMPERSONATE_SUBJECT — see googleAuth.js and
// .env.example) so the event lands on a real calendar, not the service
// account's own empty one.
//
// FAILS CLOSED: confirmed by audit before writing this file that no
// Google Calendar/Meet integration existed anywhere in this codebase.
// Without the required env vars, createMeeting() returns NOT_CONFIGURED
// (see notConfigured.js) — this file is never even required unless the
// caller has already checked isGoogleConfigured(). No conference ID, no
// meeting URL, and no calendar event is ever fabricated.
"use strict";

const { getGoogleAuthClient, IMPERSONATE_SUBJECT } = require("../../googleAuth");
const { createNotConfiguredMeetingProvider } = require("./notConfigured");

const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || "primary";

function isMeetProviderConfigured() {
    return Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY && IMPERSONATE_SUBJECT);
}

// Returns { status: "OK", provider: "google_meet", providerMeetingId, meetingUrl }
// or { status: "NOT_CONFIGURED" | "ERROR", reason, provider: null, providerMeetingId: null, meetingUrl: null }.
// Never throws — a Meet-creation failure must never block the underlying
// Meeting record from being created (see the route that calls this).
async function createMeeting({ scheduledAt, durationMinutes = 30, summary, leadId }) {
    if (!isMeetProviderConfigured()) {
        return createNotConfiguredMeetingProvider(
            "Google Workspace credentials are not configured (GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY / GOOGLE_WORKSPACE_IMPERSONATE_SUBJECT)."
        ).createMeeting();
    }

    try {
        const client = getGoogleAuthClient({ scopes: [CALENDAR_SCOPE] });
        const start = new Date(scheduledAt);
        const end = new Date(start.getTime() + durationMinutes * 60_000);
        const requestId = `ivyhuts-meeting-${leadId}-${Date.now()}`;

        const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events?conferenceDataVersion=1`;
        const response = await client.request({
            url,
            method: "POST",
            data: {
                summary: summary || "IVYHUTS accommodation consultation",
                start: { dateTime: start.toISOString() },
                end: { dateTime: end.toISOString() },
                conferenceData: {
                    createRequest: {
                        requestId,
                        conferenceSolutionKey: { type: "hangoutsMeet" },
                    },
                },
            },
        });

        const event = response.data || {};
        const meetingUrl = event.hangoutLink || null;
        if (!meetingUrl) {
            return { status: "ERROR", reason: "Google Calendar accepted the event but returned no Meet link.", provider: null, providerMeetingId: null, meetingUrl: null };
        }
        return { status: "OK", provider: "google_meet", providerMeetingId: event.id || null, meetingUrl };
    } catch (err) {
        console.error("[googleMeetProvider] createMeeting failed (non-fatal — meeting record still succeeds without a real link):", err.message);
        return { status: "ERROR", reason: "Google Meet creation failed.", provider: null, providerMeetingId: null, meetingUrl: null };
    }
}

// Moves an EXISTING Calendar event's start/end to a new time — the real
// counterpart to createMeeting's event creation, used when management
// reschedules a meeting that already has a real Google Calendar event
// attached (meeting.provider === "google_meet" && meeting.providerMeetingId
// — see the caller in .../meetings/[meetingId]/index.js). Deliberately does
// NOT touch conferenceData — the existing Meet link (hangoutLink) is left
// exactly as Calendar already has it, never regenerated or fabricated.
// Returns { status: "OK", meetingUrl } | { status: "NOT_CONFIGURED" | "SKIPPED" | "ERROR", reason }.
// SKIPPED (not an error) covers the honest case where this specific meeting
// never had a real Calendar event to begin with (e.g. provider wasn't
// configured when it was first scheduled) — there is nothing to update, and
// that must never be reported as a failure.
async function updateMeetingTime({ providerMeetingId, scheduledAt, durationMinutes = 30 }) {
    if (!isMeetProviderConfigured()) {
        return { status: "NOT_CONFIGURED", reason: "Google Workspace credentials are not configured." };
    }
    if (!providerMeetingId) {
        return { status: "SKIPPED", reason: "This meeting has no associated Google Calendar event to update." };
    }

    try {
        const client = getGoogleAuthClient({ scopes: [CALENDAR_SCOPE] });
        const start = new Date(scheduledAt);
        const end = new Date(start.getTime() + durationMinutes * 60_000);
        const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events/${encodeURIComponent(providerMeetingId)}`;
        const response = await client.request({
            url,
            method: "PATCH",
            data: { start: { dateTime: start.toISOString() }, end: { dateTime: end.toISOString() } },
        });
        const event = response.data || {};
        return { status: "OK", meetingUrl: event.hangoutLink || null };
    } catch (err) {
        console.error("[googleMeetProvider] updateMeetingTime failed (non-fatal — the Meeting record's new scheduledAt still saves):", err.message);
        return { status: "ERROR", reason: "Google Calendar event update failed." };
    }
}

// Cancels an EXISTING Calendar event when management cancels a meeting that
// has a real event attached — same SKIPPED/honest-failure contract as
// updateMeetingTime above; never claims the external event was cancelled
// unless this actually ran and Google accepted it.
async function cancelMeeting({ providerMeetingId }) {
    if (!isMeetProviderConfigured()) {
        return { status: "NOT_CONFIGURED", reason: "Google Workspace credentials are not configured." };
    }
    if (!providerMeetingId) {
        return { status: "SKIPPED", reason: "This meeting has no associated Google Calendar event to cancel." };
    }

    try {
        const client = getGoogleAuthClient({ scopes: [CALENDAR_SCOPE] });
        const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events/${encodeURIComponent(providerMeetingId)}`;
        await client.request({ url, method: "DELETE" });
        return { status: "OK" };
    } catch (err) {
        // A 410 (Gone) means the event is already deleted on Google's side —
        // the honest outcome here IS cancelled, not a failure.
        if (err.status === 410 || err.code === 410) {
            return { status: "OK" };
        }
        console.error("[googleMeetProvider] cancelMeeting failed (non-fatal — the Meeting record's cancelled status still saves):", err.message);
        return { status: "ERROR", reason: "Google Calendar event cancellation failed." };
    }
}

module.exports = { isMeetProviderConfigured, createMeeting, updateMeetingTime, cancelMeeting };
