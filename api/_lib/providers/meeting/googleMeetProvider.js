// Real Google Meet provider — Milestone 23.14.
//
// Creates an actual Google Calendar event with a real Google Meet
// conference attached (the standard, correct way to obtain a genuine
// meet.google.com link via API — there is no separate "just create a Meet
// link" endpoint; Meet links are always minted as part of a Calendar
// event's conferenceData).
//
// TWO SUPPORTED MODES, because domain-wide delegation needs a Super Admin
// and not every deployment can get one:
//
//   1. DELEGATED (preferred). Set GOOGLE_WORKSPACE_IMPERSONATE_SUBJECT and
//      authorise the service account's client id for the
//      calendar.events scope under Workspace Admin → Domain-wide
//      delegation. The service account acts AS that real Workspace user,
//      so Meet links mint reliably and events land on their calendar.
//
//   2. SHARED CALENDAR (fallback, no Super Admin needed). Leave the
//      subject unset, create a normal Google Calendar, share it with the
//      service account's own email granting "Make changes to events", and
//      point GOOGLE_CALENDAR_ID at that calendar's id. The service account
//      acts as ITSELF. Calendar events work; a Meet link is NOT guaranteed
//      — Google only mints conferenceData when the acting identity has a
//      Meet-enabled Workspace licence, which a bare service account does
//      not. createMeeting reports that honestly (status OK, meetingUrl
//      null) rather than failing the whole call, so the event is still
//      tracked and reschedule/cancel keep working.
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

// Credentials plus EITHER an impersonation subject (delegated mode) or an
// explicitly-configured calendar id (shared-calendar mode). "primary" is
// not enough on its own — for a non-impersonating service account that
// means its own empty, unshareable calendar, which would silently create
// events nobody can see.
function isMeetProviderConfigured() {
    const hasCredentials = Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY);
    const hasTarget = Boolean(IMPERSONATE_SUBJECT || process.env.GOOGLE_CALENDAR_ID);
    return hasCredentials && hasTarget;
}

// Returns { status: "OK", provider: "google_meet", providerMeetingId, meetingUrl }
// or { status: "NOT_CONFIGURED" | "ERROR", reason, provider: null, providerMeetingId: null, meetingUrl: null }.
// Never throws — a Meet-creation failure must never block the underlying
// Meeting record from being created (see the route that calls this).
async function createMeeting({ scheduledAt, durationMinutes = 30, summary, leadId, attendees = [] }) {
    if (!isMeetProviderConfigured()) {
        return createNotConfiguredMeetingProvider(
            "Google Calendar is not configured. Set GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY, plus either GOOGLE_WORKSPACE_IMPERSONATE_SUBJECT (domain-wide delegation) or GOOGLE_CALENDAR_ID (a calendar shared with the service account)."
        ).createMeeting();
    }

    try {
        const client = getGoogleAuthClient({ scopes: [CALENDAR_SCOPE] });
        const start = new Date(scheduledAt);
        const end = new Date(start.getTime() + durationMinutes * 60_000);
        const requestId = `ivyhuts-meeting-${leadId}-${Date.now()}`;

        // CRM plan item 3 — when the student's (and agent's) email is
        // known, add them as attendees and ask Google to email the
        // invite + Meet link itself (sendUpdates=all). No attendee list
        // → behave exactly as before (no invite, just a link on the
        // record).
        // De-duplicated case-insensitively — the same person can arrive from
        // more than one source (e.g. the assigned agent who is also on
        // MEETING_ALWAYS_INVITE), and Google rejects a duplicate attendee.
        const seen = new Set();
        const cleanAttendees = (Array.isArray(attendees) ? attendees : [])
            .map((email) => (typeof email === "string" ? email.trim() : ""))
            .filter((email) => /.+@.+\..+/.test(email))
            .filter((email) => {
                const key = email.toLowerCase();
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            })
            .map((email) => ({ email }));
        const sendUpdates = cleanAttendees.length > 0 ? "all" : "none";

        const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events?conferenceDataVersion=1&sendUpdates=${sendUpdates}`;
        const response = await client.request({
            url,
            method: "POST",
            data: {
                summary: summary || "IVYHUTS accommodation consultation",
                start: { dateTime: start.toISOString() },
                end: { dateTime: end.toISOString() },
                ...(cleanAttendees.length > 0 ? { attendees: cleanAttendees } : {}),
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
            // The event WAS created — don't throw that away. Expected in
            // shared-calendar mode, where the acting service account has no
            // Meet licence. Reported honestly: the calendar event is
            // tracked (so reschedule/cancel still work) and meetingUrl stays
            // null rather than being fabricated.
            console.warn("[googleMeetProvider] Calendar event created but Google returned no Meet link (expected without domain-wide delegation).");
            return {
                status: "OK",
                provider: "google_meet",
                providerMeetingId: event.id || null,
                meetingUrl: null,
                reason: "Calendar event created, but no Meet link — the acting identity has no Meet licence. Use domain-wide delegation for automatic Meet links.",
            };
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
