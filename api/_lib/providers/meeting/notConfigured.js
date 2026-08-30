// Shared "not configured" meeting-provider factory — Milestone 23.14.
// Directly mirrors api/_lib/providers/accommodation/notImplemented.js's
// createNotConfiguredAdapter, same reasoning: no fabricated meeting, no
// fabricated URL, no fabricated conference ID. If Google credentials
// aren't configured, meeting creation still succeeds as a plain tracked
// event (see api/leads/[id]/meetings/index.js) — this provider's absence
// just means it stays without a real video-conference link attached.
function createNotConfiguredMeetingProvider(reason) {
    return {
        provider: null,
        async createMeeting() {
            return { status: "NOT_CONFIGURED", reason, provider: null, providerMeetingId: null, meetingUrl: null };
        },
    };
}

module.exports = { createNotConfiguredMeetingProvider };
