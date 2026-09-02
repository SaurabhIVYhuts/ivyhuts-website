// AI-assisted university QUERY INTERPRETATION ONLY — the AI escalation tier
// of the University Housing discovery pipeline (see
// api/_lib/universityResolveService.js for the full escalation order this
// sits inside: Tier 1 curated -> Tier 2 Mongo -> local fuzzy match -> HERE,
// and only if all of those failed).
//
// ── What this module is allowed to do ──
// Interpret a free-text search query (spelling, abbreviation, alias) into a
// clean candidate institution NAME plus a few hints. Nothing more.
//
// ── What this module is NEVER allowed to do ──
// - Return, guess, or influence latitude/longitude. There is no coordinate
//   field anywhere in this module's request or response.
// - Call, know about, or reference Amber (its upstream hostname), Amber
//   credentials, or any accommodation data. This module has no imports from
//   amberGateway.js/accommodationIndex.js and never will.
// - Be treated as authoritative. Every candidate this module returns is
//   independently re-verified against Nominatim (a trusted geocoding
//   provider) by universityDiscovery.js before anything is ever stored or
//   shown to a user — see resolveViaAI() in universityResolveService.js.
// - Run unconditionally. This is an ESCALATION, called only after Tier 1,
//   Tier 2, and local fuzzy matching have all failed to resolve a query.
//
// ── Availability / graceful degradation ──
// If GROQ_API_KEY is unset, this module returns null immediately (no LLM
// client is even constructed) — University Housing search remains fully
// usable via Nominatim-only discovery. If the AI's OWN Redis-backed rate
// budget (key "university:ai:requests", completely separate from Amber's own
// request-budget key/namespace) is exhausted, or the Groq API call itself
// fails for any reason (network, 429, 5xx, malformed JSON), this module
// returns null rather than throwing — the caller falls back to non-AI
// discovery, never breaking the page.
"use strict";

const { reserveSlot, log } = require("./sharedStore");
const { getGroqClient } = require("./groqClient");

// GROQ_API_KEY (the repo's only LLM credential) is read live per-call in
// interpretUniversityQuery, not captured here — so a test can toggle it
// after require() and a deploy can add the key without a restart.
const AI_MODEL = process.env.UNIVERSITY_AI_MODEL || "openai/gpt-oss-20b"; // small, fast Groq model — this is a short classification call, not a reasoning task
const AI_MAX_REQUESTS_PER_MINUTE = Number(process.env.UNIVERSITY_AI_MAX_REQUESTS_PER_MINUTE) || 8;
const AI_RATE_KEY = "university:ai:requests"; // deliberately its own namespace — see header comment
const AI_TIMEOUT_MS = 8000;

const CANDIDATE_SCHEMA = {
    type: "object",
    properties: {
        // The AI's best guess at the institution's real, searchable name —
        // e.g. "Univesity of Manchster" -> "University of Manchester". This
        // is a NAME to hand to a geocoder, never a coordinate.
        candidateName: { type: "string" },
        aliases: { type: "array", items: { type: "string" }, maxItems: 6 },
        countryHint: { anyOf: [{ type: "string" }, { type: "null" }] },
        cityHint: { anyOf: [{ type: "string" }, { type: "null" }] },
        confidence: { type: "string", enum: ["high", "medium", "low"] },
        // Lets the AI itself flag "this doesn't look like a real
        // university/school at all" (random text, a street address, a
        // company name) so the orchestrator can short-circuit to
        // not_found without even spending a Nominatim call.
        isLikelyRealInstitution: { type: "boolean" },
    },
    required: ["candidateName", "aliases", "countryHint", "cityHint", "confidence", "isLikelyRealInstitution"],
    additionalProperties: false,
};

const SYSTEM_PROMPT = `You interpret a student's search text for a university or school name. You are NOT a geography or mapping tool — you never know or state coordinates, and you are not authoritative about whether the institution exists. Your only job: propose the cleanest, most likely real institution NAME the query refers to (correcting obvious misspellings/abbreviations), plus a short list of alternative names/aliases, and hint at the city/country ONLY if the query itself makes it reasonably clear (never invent a location). If the query is gibberish, a street address, a company, or otherwise clearly not an educational institution, set isLikelyRealInstitution to false and still return your best-effort candidateName. Never fabricate a specific campus, city, or country you are not reasonably confident about — leave cityHint/countryHint null instead of guessing.`;

// Returns { candidateName, aliases, countryHint, cityHint, confidence,
// isLikelyRealInstitution } or null (unavailable / budget exhausted / call
// failed / response didn't parse). Never throws.
async function interpretUniversityQuery(query) {
    const trimmed = String(query || "").trim();
    if (!trimmed) return null;

    if (!process.env.GROQ_API_KEY) {
        return null; // feature not configured — graceful no-op, not an error
    }

    const allowed = await reserveSlot(AI_RATE_KEY, 60_000, AI_MAX_REQUESTS_PER_MINUTE).catch((err) => {
        // Redis unreachable for the AI budget specifically must not throw —
        // this is a "nice to have" escalation tier, unlike Amber's budget
        // check which fails closed. Treat as exhausted for this call.
        log("university-ai budget check failed, skipping AI escalation:", err.message);
        return false;
    });
    if (!allowed) {
        log("university-ai budget exhausted — skipping AI escalation, falling back to non-AI discovery");
        return null;
    }

    try {
        const response = await getGroqClient().chat.completions.create(
            {
                model: AI_MODEL,
                max_tokens: 400,
                temperature: 0,
                response_format: { type: "json_object" },
                messages: [
                    {
                        role: "system",
                        content:
                            SYSTEM_PROMPT +
                            "\n\nRespond ONLY with a JSON object matching this shape: " +
                            JSON.stringify(CANDIDATE_SCHEMA),
                    },
                    { role: "user", content: `Search query: ${trimmed.slice(0, 200)}` },
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
            log("university-ai returned unparseable JSON — falling back to non-AI discovery");
            return null;
        }

        if (!parsed || typeof parsed.candidateName !== "string" || !parsed.candidateName.trim()) return null;

        return {
            candidateName: parsed.candidateName.trim().slice(0, 200),
            aliases: Array.isArray(parsed.aliases) ? parsed.aliases.filter((a) => typeof a === "string").slice(0, 6) : [],
            countryHint: typeof parsed.countryHint === "string" ? parsed.countryHint.trim().slice(0, 100) || null : null,
            cityHint: typeof parsed.cityHint === "string" ? parsed.cityHint.trim().slice(0, 100) || null : null,
            confidence: ["high", "medium", "low"].includes(parsed.confidence) ? parsed.confidence : "low",
            isLikelyRealInstitution: Boolean(parsed.isLikelyRealInstitution),
        };
    } catch (err) {
        // Network error, 4xx/5xx, timeout — every case degrades to null,
        // never propagates. AI is an optional escalation, never a hard
        // dependency of University Housing search.
        log("university-ai call failed, falling back to non-AI discovery:", err.message);
        return null;
    }
}

// CANDIDATE_SCHEMA is exported so a structural test can assert the response
// shape itself has no coordinate/accommodation-shaped field, without
// grepping this file's prose (which legitimately, correctly, has to explain
// that boundary in comments and in SYSTEM_PROMPT — a plain text search for
// words like "coordinate" would trip on that explanation itself).
module.exports = { interpretUniversityQuery, AI_MODEL, AI_MAX_REQUESTS_PER_MINUTE, AI_RATE_KEY, CANDIDATE_SCHEMA };
