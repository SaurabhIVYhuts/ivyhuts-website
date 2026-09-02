// The single shared LLM client for this repo. Groq exposes an
// OpenAI-compatible chat-completions API, so we drive it with the `openai`
// SDK pointed at Groq's base URL. GROQ_API_KEY is the ONLY LLM credential
// in this codebase — every AI-calling module goes through here:
//   - api/_lib/universityAI.js            (university query interpretation)
//   - api/_lib/transcriptExtraction.js    (meeting requirement extraction)
//   - api/_lib/routes/crm-tools/assistant.js  (Ivy Assistant agent loop)
//
// Lazy singleton: requiring this module never constructs the client, so a
// module that only touches it on a cold escalation path still loads cleanly
// with no key set. Each caller keeps its OWN "GROQ_API_KEY unset -> graceful
// degrade" guard and must run it BEFORE calling getGroqClient().
"use strict";

let cachedClient = null;
function getGroqClient() {
    if (cachedClient) return cachedClient;
    // eslint-disable-next-line global-require
    const OpenAI = require("openai").default || require("openai");
    cachedClient = new OpenAI({
        apiKey: process.env.GROQ_API_KEY,
        baseURL: "https://api.groq.com/openai/v1",
    });
    return cachedClient;
}

module.exports = { getGroqClient };
