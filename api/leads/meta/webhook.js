// GET/POST /api/leads/meta/webhook — Milestone 23.10 (internal contract
// foundation, per Milestone 23.9's audit). This repository has NO live
// Meta/Facebook App today — no App Secret, no Page access token, no
// verified webhook subscription (confirmed by inspection). This file is
// therefore the CORRECT, production-shaped contract for when one exists,
// never a claim that Meta is live. Every failure mode below fails CLOSED:
// if the required secret/token isn't configured, this endpoint refuses to
// process anything rather than silently accepting unverified data.
//
// GET  — Meta's webhook verification handshake: echoes back
//        `hub.challenge` only if `hub.verify_token` matches
//        META_WEBHOOK_VERIFY_TOKEN exactly. This is what Meta calls once,
//        when a developer configures the webhook URL in the App dashboard.
// POST — the actual lead delivery. Verifies `X-Hub-Signature-256` (HMAC-
//        SHA256 over the RAW request body, using META_APP_SECRET) before
//        trusting anything in the payload — the same signature scheme
//        every Meta webhook product (WhatsApp, Messenger, Lead Ads) uses.
//        `bodyParser: false` below is required for this: the signature is
//        computed over the exact bytes Meta sent, and a framework that
//        re-serializes JSON before we see it would silently break
//        verification (whitespace/key-order differences change the hash).
//
// Payload shape assumed (Meta's real, documented Lead Ads webhook
// structure — https://developers.facebook.com/docs/graph-api/webhooks/reference/page/#leadgen —
// not invented for this repo):
//   { entry: [ { changes: [ { field: "leadgen", value: {
//       leadgen_id, form_id, ad_id, campaign_id, page_id, created_time,
//       field_data: [ { name, values: [string] } ]
//   } } ] } ] }
// Only these fields are read. Anything else Meta might include is ignored,
// never guessed at.
const crypto = require("crypto");
const { connectToDatabase } = require("../../_lib/mongodb");
const Lead = require("../../_lib/models/Lead");
const { recordEvent } = require("../../_lib/events");

const MAX_BODY_BYTES = 200_000; // a batch of lead entries is small text/JSON; generous but bounded against an abusive caller.

function readRawBody(req) {
    return new Promise((resolve, reject) => {
        let total = 0;
        const chunks = [];
        req.on("data", (chunk) => {
            total += chunk.length;
            if (total > MAX_BODY_BYTES) {
                reject(Object.assign(new Error("payload_too_large"), { statusCode: 413 }));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);
    });
}

// Constant-time signature comparison — a plain `===` on attacker-influenced
// strings is a timing side channel (same reasoning as every HMAC-verifying
// webhook handler); mismatched lengths are rejected before ever reaching
// timingSafeEqual, which throws on unequal-length buffers.
function verifySignature(rawBody, signatureHeader, appSecret) {
    if (typeof signatureHeader !== "string" || !signatureHeader.startsWith("sha256=")) return false;
    const expected = `sha256=${crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex")}`;
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(signatureHeader, "utf8");
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

// Meta's field_data is a flat array of {name, values:[...]} pairs whose
// `name` varies by form (a form builder, not a fixed schema) — this maps
// only the handful of common, well-documented field names Meta's own Lead
// Ads templates use. An unrecognized field name is left out entirely
// rather than guessed into the wrong bucket.
const FIELD_NAME_MAP = {
    full_name: "name",
    first_name: "firstName",
    last_name: "lastName",
    email: "email",
    phone_number: "phone",
};

function normalizeFieldData(fieldData) {
    const out = {};
    if (!Array.isArray(fieldData)) return out;
    for (const entry of fieldData) {
        if (!entry || typeof entry.name !== "string") continue;
        const key = FIELD_NAME_MAP[entry.name];
        if (!key) continue;
        const value = Array.isArray(entry.values) ? entry.values[0] : undefined;
        if (typeof value === "string" && value.trim()) out[key] = value.trim();
    }
    return out;
}

function normalizeLeadValue(value) {
    if (!value || typeof value !== "object" || typeof value.leadgen_id !== "string" || !value.leadgen_id.trim()) {
        return null; // structurally not a lead we can dedupe safely — skip, never guess an id.
    }
    const fields = normalizeFieldData(value.field_data);
    const name = fields.name || [fields.firstName, fields.lastName].filter(Boolean).join(" ") || null;

    return {
        externalLeadId: value.leadgen_id,
        contact: { name: name || null, email: fields.email || null, phone: fields.phone || null },
        sourceDetails: {
            formId: typeof value.form_id === "string" ? value.form_id : null,
            adId: typeof value.ad_id === "string" ? value.ad_id : null,
            campaignId: typeof value.campaign_id === "string" ? value.campaign_id : null,
            pageId: typeof value.page_id === "string" ? value.page_id : null,
        },
    };
}

// Extracts every leadgen change out of Meta's nested entry/changes envelope.
// Malformed/unexpected shapes are skipped per-entry rather than failing the
// whole batch — one bad entry must never block the other real ones.
function extractLeadgenValues(payload) {
    const values = [];
    if (!payload || !Array.isArray(payload.entry)) return values;
    for (const entry of payload.entry) {
        if (!entry || !Array.isArray(entry.changes)) continue;
        for (const change of entry.changes) {
            if (change && change.field === "leadgen" && change.value) values.push(change.value);
        }
    }
    return values;
}

// Dedup + create. Preserves existing Lead data on a duplicate delivery
// (Meta redelivers on any non-2xx response, and webhooks are not
// guaranteed exactly-once) — a repeat delivery of an already-known
// externalLeadId is a no-op success, never a second Lead and never an
// overwrite of whatever an agent may have already edited on the first one.
async function upsertLeadFromMeta(normalized) {
    const existing = await Lead.findOne({ externalLeadId: normalized.externalLeadId });
    if (existing) return { lead: existing, created: false };

    const lead = await Lead.create({
        externalLeadId: normalized.externalLeadId,
        contact: normalized.contact,
        source: "facebook_lead_ads",
        sourceDetails: normalized.sourceDetails,
        status: "new",
        firstContactAt: new Date(),
        lastContactAt: new Date(),
    });
    await recordEvent({
        userId: null,
        event: "LEAD_CREATED",
        properties: { leadId: String(lead._id), source: "facebook_lead_ads" },
    });
    return { lead, created: true };
}

async function handleGet(req, res) {
    const verifyToken = process.env.META_WEBHOOK_VERIFY_TOKEN;
    if (!verifyToken) {
        // Fail closed — an unconfigured verify token must never be treated
        // as "accept anything" (Milestone 23.9/23.10: "remain safe when
        // Meta credentials are absent").
        res.status(503).json({ ok: false, error: "not_configured", message: "Meta webhook verification is not configured." });
        return;
    }
    const { "hub.mode": mode, "hub.verify_token": token, "hub.challenge": challenge } = req.query || {};
    if (mode !== "subscribe" || token !== verifyToken || typeof challenge !== "string") {
        res.status(403).json({ ok: false, error: "verification_failed" });
        return;
    }
    res.setHeader("Content-Type", "text/plain");
    res.status(200).end(challenge);
}

async function handlePost(req, res) {
    const appSecret = process.env.META_APP_SECRET;
    if (!appSecret) {
        res.status(503).json({ ok: false, error: "not_configured", message: "Meta webhook signature verification is not configured." });
        return;
    }

    let rawBody;
    try {
        rawBody = await readRawBody(req);
    } catch (err) {
        res.status(err.statusCode || 400).json({ ok: false, error: "invalid_body" });
        return;
    }

    const signatureHeader = req.headers["x-hub-signature-256"];
    if (!verifySignature(rawBody, signatureHeader, appSecret)) {
        res.status(401).json({ ok: false, error: "invalid_signature" });
        return;
    }

    let payload;
    try {
        payload = JSON.parse(rawBody.toString("utf8") || "{}");
    } catch {
        res.status(400).json({ ok: false, error: "invalid_json" });
        return;
    }

    await connectToDatabase();

    const values = extractLeadgenValues(payload);
    const results = [];
    for (const value of values) {
        const normalized = normalizeLeadValue(value);
        if (!normalized) continue; // structurally unusable — skip, never fabricate an id.
        const { lead, created } = await upsertLeadFromMeta(normalized);
        results.push({ leadId: String(lead._id), created });
    }

    // Always 200 once signature-verified and processed — Meta redelivers
    // on non-2xx, and per-lead dedup already makes redelivery safe, so
    // there's no benefit to a partial-failure status here.
    res.status(200).json({ ok: true, processed: results.length, results });
}

async function handler(req, res) {
    if (req.method === "GET") return handleGet(req, res);
    if (req.method === "POST") return handlePost(req, res);
    res.status(405).json({ ok: false, error: "method_not_allowed" });
}

// Vercel: read the raw, unparsed body ourselves — required for byte-exact
// HMAC verification (see this file's header comment).
handler.config = { api: { bodyParser: false } };

// Exposed for scripts/verify-meta-webhook.js's pure unit tests.
handler.verifySignature = verifySignature;
handler.normalizeLeadValue = normalizeLeadValue;
handler.extractLeadgenValues = extractLeadgenValues;
handler.upsertLeadFromMeta = upsertLeadFromMeta;
handler.readRawBody = readRawBody;

module.exports = handler;
