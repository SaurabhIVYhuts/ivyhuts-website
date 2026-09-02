// AI-assisted requirement extraction from a meeting transcript — Milestone
// 23.14. Same pattern as api/_lib/universityAI.js (shared Groq client via
// api/_lib/groqClient.js, GROQ_API_KEY guard, its own Redis rate budget,
// JSON-object output, never throws) — reused deliberately rather than
// building a second AI-calling convention.
//
// ── What this module is allowed to do ──
// Read a real, agent-pasted transcript and extract ONLY values explicitly
// stated in it, shaped to match Discovery's own field set exactly (see
// api/_lib/models/Discovery.js) so a confirmed extraction maps 1:1 onto a
// PUT /api/leads/:id/discovery body.
//
// ── What this module is NEVER allowed to do ──
// - Guess. Every field the transcript doesn't clearly support stays null —
//   enforced by the prompt AND by the response schema requiring every key
//   to be present (explicitly null, never omitted).
// - Write to Discovery, or anywhere else, directly. This module only
//   RETURNS a suggestion; api/leads/[id]/meetings/[meetingId]/extract-
//   requirements.js stores it on the Meeting document
//   (extractedRequirements) — Discovery is only ever written by an agent's
//   own explicit PUT to the existing endpoint.
// - Run unconditionally or automatically. Called only from an explicit
//   agent action (a "Extract Requirements" button), never a background job
//   or a side effect of any other request.
//
// ── Availability / graceful degradation ──
// If GROQ_API_KEY is unset, extractRequirementsFromTranscript() returns null
// immediately (and isTranscriptExtractionConfigured() returns false). If the
// rate budget is exhausted or the API call fails for any reason, it also
// returns null — the caller (the extract-requirements route) turns a null
// into a 503, never a fabricated result.
"use strict";

const { reserveSlot, log } = require("./sharedStore");
const { getGroqClient } = require("./groqClient");

// GROQ_API_KEY (the repo's only LLM credential) is read live per-call, not
// captured here — so a test can toggle it after require() and a deploy can
// add the key without a restart.
const AI_MODEL = process.env.TRANSCRIPT_EXTRACTION_MODEL || "openai/gpt-oss-20b"; // structured extraction, not open-ended reasoning — same tier choice as universityAI.js
const AI_MAX_REQUESTS_PER_MINUTE = Number(process.env.TRANSCRIPT_EXTRACTION_MAX_REQUESTS_PER_MINUTE) || 6;
const AI_RATE_KEY = "transcript:extraction:requests"; // its own namespace, independent of university:ai:requests and amber:requests
const AI_TIMEOUT_MS = 15_000; // a transcript is longer input than a university-name query — more generous than universityAI.js's 8s

const EXTRACTION_SCHEMA = {
    type: "object",
    properties: {
        university: { anyOf: [{ type: "string" }, { type: "null" }] },
        course: { anyOf: [{ type: "string" }, { type: "null" }] },
        intake: { anyOf: [{ type: "string" }, { type: "null" }] },
        budgetMin: { anyOf: [{ type: "number" }, { type: "null" }] },
        budgetMax: { anyOf: [{ type: "number" }, { type: "null" }] },
        currency: { anyOf: [{ type: "string" }, { type: "null" }] },
        moveInDate: { anyOf: [{ type: "string" }, { type: "null" }] },
        stayDurationMonths: { anyOf: [{ type: "number" }, { type: "null" }] },
        preferredLocation: { anyOf: [{ type: "string" }, { type: "null" }] },
        roomPreference: { anyOf: [{ type: "string" }, { type: "null" }] },
        sharing: { anyOf: [{ type: "number" }, { type: "null" }] },
        distancePreference: { anyOf: [{ type: "string" }, { type: "null" }] },
        priorities: { type: "array", items: { type: "string", enum: ["budget", "distance", "travel_convenience", "amenities", "location", "property_quality", "other"] } },
        notes: { anyOf: [{ type: "string" }, { type: "null" }] },
    },
    required: ["university", "course", "intake", "budgetMin", "budgetMax", "currency", "moveInDate", "stayDurationMonths", "preferredLocation", "roomPreference", "sharing", "distancePreference", "priorities", "notes"],
    additionalProperties: false,
};

const SYSTEM_PROMPT = `You extract student accommodation requirements from a real meeting transcript between an IVYHUTS agent and a prospective student. You are extracting ONLY what is explicitly stated or unambiguously implied in THIS transcript — never general knowledge, never a typical/average value, never a guess. Every field you are not confident is actually supported by the transcript text must be null. Do not invent a specific university, course, budget figure, or date that was not actually said. "notes" is a short (2-3 sentence) neutral summary of anything else relevant the student said (preferences, constraints, concerns) that doesn't fit the other fields — omit it (null) if there is nothing extra worth surfacing. "priorities" may only contain values from the given enum, and only ones the transcript actually supports — an empty array is correct and expected if none are clearly stated.`;

// Returns the extracted fields object (matching EXTRACTION_SCHEMA, every
// key present) or null (unavailable / budget exhausted / call failed /
// response didn't parse). Never throws.
async function extractRequirementsFromTranscript(transcriptText) {
    const trimmed = String(transcriptText || "").trim();
    if (!trimmed) return null;

    if (!process.env.GROQ_API_KEY) {
        return null; // feature not configured — graceful no-op, not an error
    }

    const allowed = await reserveSlot(AI_RATE_KEY, 60_000, AI_MAX_REQUESTS_PER_MINUTE).catch((err) => {
        log("transcript-extraction budget check failed, skipping:", err.message);
        return false;
    });
    if (!allowed) {
        log("transcript-extraction budget exhausted — skipping this run");
        return null;
    }

    try {
        const response = await getGroqClient().chat.completions.create(
            {
                model: AI_MODEL,
                max_tokens: 800,
                temperature: 0,
                response_format: { type: "json_object" },
                messages: [
                    {
                        role: "system",
                        content:
                            SYSTEM_PROMPT +
                            "\n\nRespond ONLY with a JSON object matching this shape: " +
                            JSON.stringify(EXTRACTION_SCHEMA),
                    },
                    { role: "user", content: `Transcript:\n${trimmed.slice(0, 20_000)}` },
                ],
            },
            { timeout: AI_TIMEOUT_MS }
        );

        const text = response.choices && response.choices[0] && response.choices[0].message && response.choices[0].message.content;
        if (!text) return null;

        let parsed;
        try {
            parsed = JSON.parse(text);
        } catch {
            log("transcript-extraction returned unparseable JSON");
            return null;
        }
        if (!parsed || typeof parsed !== "object") return null;

        // Defensive re-shaping — never trust the model's output shape blindly,
        // even with a requested schema (same discipline as universityAI.js).
        return {
            university: typeof parsed.university === "string" ? parsed.university.trim().slice(0, 200) || null : null,
            course: typeof parsed.course === "string" ? parsed.course.trim().slice(0, 200) || null : null,
            intake: typeof parsed.intake === "string" ? parsed.intake.trim().slice(0, 100) || null : null,
            budgetMin: typeof parsed.budgetMin === "number" && Number.isFinite(parsed.budgetMin) ? parsed.budgetMin : null,
            budgetMax: typeof parsed.budgetMax === "number" && Number.isFinite(parsed.budgetMax) ? parsed.budgetMax : null,
            currency: typeof parsed.currency === "string" ? parsed.currency.trim().toUpperCase().slice(0, 10) || null : null,
            moveInDate: typeof parsed.moveInDate === "string" ? parsed.moveInDate.trim().slice(0, 50) || null : null,
            stayDurationMonths: typeof parsed.stayDurationMonths === "number" && Number.isFinite(parsed.stayDurationMonths) ? parsed.stayDurationMonths : null,
            preferredLocation: typeof parsed.preferredLocation === "string" ? parsed.preferredLocation.trim().slice(0, 200) || null : null,
            roomPreference: typeof parsed.roomPreference === "string" ? parsed.roomPreference.trim().slice(0, 200) || null : null,
            sharing: typeof parsed.sharing === "number" && Number.isFinite(parsed.sharing) ? parsed.sharing : null,
            distancePreference: typeof parsed.distancePreference === "string" ? parsed.distancePreference.trim().slice(0, 200) || null : null,
            priorities: Array.isArray(parsed.priorities)
                ? parsed.priorities.filter((p) => ["budget", "distance", "travel_convenience", "amenities", "location", "property_quality", "other"].includes(p)).slice(0, 7)
                : [],
            notes: typeof parsed.notes === "string" ? parsed.notes.trim().slice(0, 1000) || null : null,
        };
    } catch (err) {
        log("transcript-extraction call failed:", err.message);
        return null;
    }
}

function isTranscriptExtractionConfigured() {
    return Boolean(process.env.GROQ_API_KEY);
}

module.exports = { extractRequirementsFromTranscript, isTranscriptExtractionConfigured, AI_MODEL, AI_MAX_REQUESTS_PER_MINUTE, AI_RATE_KEY, EXTRACTION_SCHEMA };
