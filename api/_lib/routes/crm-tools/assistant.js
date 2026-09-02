// POST /api/assistant — "Ivy Assistant", a read-only conversational agent
// for logged-in CRM sales staff (Phase 1).
//
// Contract:
//   Body:   { messages: Array<{ role: "user"|"assistant", content: string }> }
//           The FULL transcript, client-supplied every call. Conversation
//           state is stateless server-side — nothing is persisted between
//           turns except the AssistantLog audit record.
//   Auth:   requireCustomerIdentity (any authenticated CRM user — no role
//           gate here; individual lead tools apply their own role/visibility
//           checks). The resolved mongoUser is the "actor" passed to every
//           tool.
//   Output: Server-Sent Events. One JSON object per `data:` line:
//             { type: "text", delta }
//             { type: "tool_call", id, name, args }
//             { type: "tool_result", id, ok, summary }   // short summary, NOT the payload
//             { type: "done" }
//             { type: "error", message }
//
// Backed by Groq (https://api.groq.com/openai/v1), an OpenAI-compatible
// chat-completions endpoint, via the shared api/_lib/groqClient.js. Mirrors
// api/_lib/universityAI.js's availability pattern: if GROQ_API_KEY is unset
// we return 503 WITHOUT constructing the client. Rate/cost budgets reuse
// sharedStore.reserveSlot / shared KV, the same primitives universityAI.js
// uses, under their own key namespace.
//
// GROQ_API_KEY is the only LLM credential in this repo (see groqClient.js).
"use strict";

const { requireCustomerIdentity } = require("../../businessAuth");
const { withCors } = require("../../cors");
const { getGroqClient } = require("../../groqClient");
const { reserveSlot, sharedGet, sharedSet } = require("../../sharedStore");
const { TOOLS, runTool, summarizeToolResult } = require("../../assistantTools");
const AssistantLog = require("../../models/AssistantLog");

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const MODEL = process.env.ASSISTANT_MODEL || "openai/gpt-oss-120b";
const MAX_TURNS_PER_MINUTE = Number(process.env.ASSISTANT_MAX_TURNS_PER_MINUTE) || 20;
const DAILY_TOKEN_BUDGET = Number(process.env.ASSISTANT_DAILY_TOKEN_BUDGET) || 200_000;

const MAX_ITERATIONS = 8; // hard cap on model round-trips per request
const MAX_MESSAGES = 30;
const MAX_CONTENT_CHARS = 8000;
const MAX_TOKENS_PER_TURN = 1024;
const TOOL_RESULT_CHAR_CAP = 16_000; // per tool_result message handed back to the model
const TOKEN_KEY_TTL_SECONDS = 60 * 60 * 48;

// assistantTools exposes TOOLS as { name, description, input_schema }
// (the Anthropic shape). Groq's OpenAI-compatible API wants the "function"
// tool shape — this is a pure rename, the JSON Schema is passed through
// verbatim as `parameters`.
const OPENAI_TOOLS = TOOLS.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.input_schema },
}));

function todayKey() {
    return new Date().toISOString().slice(0, 10);
}

function buildSystemPrompt(actor) {
    const today = new Date().toISOString().slice(0, 10);
    const name = actor.name || "Unknown user";
    const role = actor.role || "UNKNOWN";
    return [
        "You are Ivy Assistant, an internal tool for IvyHuts sales staff working student-accommodation leads.",
        `You are assisting ${name} (role: ${role}, user id: ${actor._id}). Today's date is ${today}.`,
        "",
        "Rules:",
        "- This version is READ-ONLY. You can look things up but cannot create, edit, assign, delete, send, or schedule anything. If asked to change something, explain that you can only read data in this version.",
        "- Never invent lead details, prices, or availability. Call a tool to get real data, or say you don't know.",
        "- If it is ambiguous which lead the user means, ask a short clarifying question instead of guessing.",
        "- Keep answers concise. Use markdown tables when presenting lists of leads, properties, meetings, etc.",
        "- Refer to a lead as /leads/{id} so the CRM can turn it into a link.",
        "- When a tool result gives a property (or anything) a `url`, render it as a real markdown link on its name — [Name](url) — using the url verbatim. Never print a bare URL or a path in square brackets.",
        "- If a tool reports no access or not found, tell the user plainly — do not speculate about the lead's contents.",
    ].join("\n");
}

function sanitizeMessages(messages) {
    return messages.map((m) => ({ role: m.role, content: m.content }));
}

module.exports = async (req, res) => {
    // ── pre-stream guards (plain JSON responses, real status codes) ──
    // CORS first — the CRM app calls this cross-site (different registrable
    // domain, credentialed fetch), so an unanswered OPTIONS preflight would
    // block the real POST before any of the checks below run. Same
    // first-line pattern as every other CRM-facing route (staff.js,
    // work-queue.js, properties-search.js).
    if (withCors(req, res)) return; // preflight handled

    if (req.method !== "POST") {
        res.status(405).json({ error: "Method not allowed" });
        return;
    }
    if (!GROQ_API_KEY) {
        res.status(503).json({ error: "Assistant is not configured." });
        return;
    }

    let body;
    try {
        body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    } catch {
        res.status(400).json({ error: "Request body is not valid JSON." });
        return;
    }

    const messages = body.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
        res.status(400).json({ error: "messages must be a non-empty array." });
        return;
    }
    if (messages.length > MAX_MESSAGES) {
        res.status(400).json({ error: `Too many messages (max ${MAX_MESSAGES}).` });
        return;
    }
    for (const m of messages) {
        if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string") {
            res.status(400).json({ error: "Each message needs role 'user' or 'assistant' and string content." });
            return;
        }
        if (m.content.length > MAX_CONTENT_CHARS) {
            res.status(400).json({ error: `A message exceeds the ${MAX_CONTENT_CHARS}-character limit.` });
            return;
        }
    }

    let identity;
    try {
        identity = await requireCustomerIdentity(req, res);
    } catch (err) {
        // requireAuth already handles the 401 / Redis-503 cases and returns
        // null; reaching here means the Mongo identity bridge itself is
        // unavailable (MONGODB_URI unset / unreachable). Respond like the
        // other business routes' withErrorHandling would, before any stream.
        console.error("[assistant] identity resolution failed:", err.message);
        res.status(503).json({ error: "This feature is temporarily unavailable." });
        return;
    }
    if (!identity) return; // 401 / 503 already sent by requireAuth
    const actor = identity.mongoUser;
    const actorId = String(actor._id);

    // ── rate limit: turns per minute (per user) ──
    let turnAllowed = true;
    try {
        turnAllowed = await reserveSlot(`assistant:turns:${actorId}`, 60_000, MAX_TURNS_PER_MINUTE);
    } catch (err) {
        // The limiter itself being unavailable must not hard-block the
        // feature — log and fail open, same spirit as universityAI.js
        // treating a budget-check failure as non-fatal.
        console.error("[assistant] turn rate-limit check failed for", actorId, err.message);
        turnAllowed = true;
    }
    if (!turnAllowed) {
        // One AssistantLog per (authenticated) request — including the ones
        // we turn away for rate. Best-effort, never blocks the response.
        AssistantLog.create({
            userId: actor._id,
            createdAt: new Date(),
            messageCount: messages.length,
            outcome: "rate_limited",
        }).catch((err) => console.error("[assistant] failed to write rate_limited AssistantLog for", actorId, err.message));
        res.status(429).json({ error: "You're sending messages too quickly. Wait a moment." });
        return;
    }

    // ── start the SSE stream ──
    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
    });
    if (typeof res.flushHeaders === "function") res.flushHeaders();

    let closed = false;
    const send = (obj) => {
        if (closed) return;
        try {
            res.write(`data: ${JSON.stringify(obj)}\n\n`);
        } catch {
            closed = true;
        }
    };
    req.on("close", () => {
        closed = true;
    });

    const logDoc = {
        userId: actor._id,
        createdAt: new Date(),
        messageCount: messages.length,
        toolCalls: [],
        iterations: 0,
        tokensIn: 0,
        tokensOut: 0,
        outcome: "ok",
        errorMessage: null,
    };

    try {
        // ── daily token budget: checked at the START of the request ──
        const tokenKey = `assistant:tokens:${actorId}:${todayKey()}`;
        let tokenTally = 0;
        try {
            tokenTally = Number(await sharedGet(tokenKey)) || 0;
        } catch (err) {
            console.error("[assistant] token budget read failed for", actorId, err.message);
            tokenTally = 0;
        }
        if (tokenTally >= DAILY_TOKEN_BUDGET) {
            logDoc.outcome = "cap";
            send({ type: "error", message: "You've hit today's assistant limit." });
            send({ type: "done" });
            return;
        }

        const client = getGroqClient();
        // Groq (OpenAI-compatible) takes the system prompt as the first
        // message, not a top-level param.
        const convo = [{ role: "system", content: buildSystemPrompt(actor) }, ...sanitizeMessages(messages)];
        let producedFinalText = false;

        for (let i = 0; i < MAX_ITERATIONS; i++) {
            logDoc.iterations = i + 1;

            let assistantText = "";
            const toolCallAcc = []; // one slot per streamed tool_call `.index`
            let finishReason = null;
            let usage = null;

            try {
                const stream = await client.chat.completions.create({
                    model: MODEL,
                    max_tokens: MAX_TOKENS_PER_TURN,
                    messages: convo,
                    tools: OPENAI_TOOLS,
                    tool_choice: "auto",
                    stream: true,
                    stream_options: { include_usage: true },
                });

                for await (const chunk of stream) {
                    const choice = chunk.choices && chunk.choices[0];
                    if (choice) {
                        const delta = choice.delta || {};
                        if (delta.content) {
                            producedFinalText = true;
                            assistantText += delta.content;
                            send({ type: "text", delta: delta.content });
                        }
                        if (delta.tool_calls) {
                            for (const tc of delta.tool_calls) {
                                const idx = typeof tc.index === "number" ? tc.index : 0;
                                if (!toolCallAcc[idx]) toolCallAcc[idx] = { id: null, name: "", arguments: "" };
                                const slot = toolCallAcc[idx];
                                if (tc.id) slot.id = tc.id;
                                if (tc.function) {
                                    if (tc.function.name) slot.name += tc.function.name;
                                    if (tc.function.arguments) slot.arguments += tc.function.arguments;
                                }
                            }
                        }
                        if (choice.finish_reason) finishReason = choice.finish_reason;
                    }
                    // The final chunk (include_usage) carries totals and an
                    // empty choices array.
                    if (chunk.usage) usage = chunk.usage;
                }
            } catch (err) {
                // A Groq 429 (free-tier rpm/daily) lands here too and is
                // surfaced like any other model error.
                console.error("[assistant] model call failed for", actorId, err.message);
                logDoc.outcome = "error";
                logDoc.errorMessage = err.message;
                send({ type: "error", message: "The assistant hit an error. Please try again." });
                break;
            }

            const usedIn = (usage && usage.prompt_tokens) || 0;
            const usedOut = (usage && usage.completion_tokens) || 0;
            logDoc.tokensIn += usedIn;
            logDoc.tokensOut += usedOut;
            tokenTally += usedIn + usedOut;
            try {
                await sharedSet(tokenKey, tokenTally, TOKEN_KEY_TTL_SECONDS);
            } catch (err) {
                console.error("[assistant] token budget write failed for", actorId, err.message);
            }

            const toolCalls = toolCallAcc.filter(Boolean);
            if (finishReason !== "tool_calls" || toolCalls.length === 0) {
                // Model produced its final answer (text already streamed).
                break;
            }

            // Record the assistant turn that requested the tools, exactly as
            // the OpenAI/Groq message format expects it echoed back.
            convo.push({
                role: "assistant",
                content: assistantText || "",
                tool_calls: toolCalls.map((c) => ({
                    id: c.id,
                    type: "function",
                    function: { name: c.name, arguments: c.arguments || "{}" },
                })),
            });

            for (const c of toolCalls) {
                let args;
                try {
                    args = c.arguments ? JSON.parse(c.arguments) : {};
                } catch {
                    console.error("[assistant] tool", c.name, "failed for", actorId, "invalid arguments JSON");
                    logDoc.toolCalls.push({ name: c.name, args: null, ok: false });
                    send({ type: "tool_result", id: c.id, ok: false, summary: "That lookup failed." });
                    convo.push({ role: "tool", tool_call_id: c.id, content: "invalid arguments" });
                    continue;
                }
                send({ type: "tool_call", id: c.id, name: c.name, args });
                try {
                    const result = await runTool(c.name, actor, args);
                    logDoc.toolCalls.push({ name: c.name, args, ok: true });
                    send({ type: "tool_result", id: c.id, ok: true, summary: summarizeToolResult(c.name, result) });
                    convo.push({
                        role: "tool",
                        tool_call_id: c.id,
                        content: JSON.stringify(result).slice(0, TOOL_RESULT_CHAR_CAP),
                    });
                } catch (err) {
                    console.error("[assistant] tool", c.name, "failed for", actorId, err.message);
                    logDoc.toolCalls.push({ name: c.name, args, ok: false });
                    send({ type: "tool_result", id: c.id, ok: false, summary: "That lookup failed." });
                    convo.push({
                        role: "tool",
                        tool_call_id: c.id,
                        content: "The tool failed to run. Do not retry it more than once.",
                    });
                }
            }

            if (i === MAX_ITERATIONS - 1) {
                logDoc.outcome = "cap";
                send({ type: "error", message: "I couldn't finish that — try narrowing the question." });
            }
        }

        if (logDoc.outcome === "ok" && !producedFinalText) {
            // Loop ended cleanly but the model never emitted any answer text.
            send({ type: "text", delta: "I wasn't able to produce an answer for that." });
        }
        send({ type: "done" });
    } catch (err) {
        console.error("[assistant] unexpected error for", actorId, err.message);
        logDoc.outcome = "error";
        logDoc.errorMessage = err.message;
        send({ type: "error", message: "The assistant hit an error. Please try again." });
        send({ type: "done" });
    } finally {
        try {
            res.end();
        } catch {
            /* already closed */
        }
        try {
            await AssistantLog.create(logDoc);
        } catch (err) {
            console.error("[assistant] failed to write AssistantLog for", actorId, err.message);
        }
    }
};
