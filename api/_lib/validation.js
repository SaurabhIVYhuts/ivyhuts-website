// Shared request validation/parsing + error handling for the Milestone 2
// business API. Every endpoint under api/customers, api/leads, api/enquiries
// funnels its errors through `withErrorHandling` so client-facing responses
// stay consistent and never leak internals (stack traces, connection
// strings, raw Mongo driver error text).
const mongoose = require("mongoose");
const { sendError } = require("./apiResponse");
const { RedisUnavailableError } = require("./sharedStore");
const { MongoNotConfiguredError } = require("./mongodb");

// Thrown deliberately by handler code for expected, client-facing failures
// (bad input, not found, forbidden) — always safe to show `message` as-is.
class ApiError extends Error {
    constructor(status, code, message) {
        super(message);
        this.name = "ApiError";
        this.status = status;
        this.code = code;
    }
}

function badRequest(code, message) {
    return new ApiError(400, code, message);
}
function notFound(message = "Resource not found.") {
    return new ApiError(404, "NOT_FOUND", message);
}
function forbidden(message = "You do not have permission to perform this action.") {
    return new ApiError(403, "FORBIDDEN", message);
}

// Wraps a Vercel-style async (req, res) handler so any thrown error becomes
// a well-formed, safe JSON response instead of an unhandled rejection or a
// leaked stack trace. Every new business endpoint's module.exports is
// `withErrorHandling(async (req, res) => { ... })`.
function withErrorHandling(handler) {
    return async (req, res) => {
        try {
            await handler(req, res);
        } catch (err) {
            if (err instanceof ApiError) {
                sendError(res, err.status, err.code, err.message);
                return;
            }
            if (err instanceof RedisUnavailableError) {
                console.error("[business-api] Redis unavailable:", err.message);
                sendError(res, 503, "SERVICE_UNAVAILABLE", "Authentication is temporarily unavailable.");
                return;
            }
            if (err instanceof MongoNotConfiguredError || err.name === "MongoNotConfiguredError") {
                console.error("[business-api] MongoDB not configured:", err.message);
                sendError(res, 503, "SERVICE_UNAVAILABLE", "This feature is temporarily unavailable.");
                return;
            }
            if (err.name === "ValidationError") {
                // Mongoose schema validation error — err.message lists which
                // paths failed and why, safe to surface (no internals).
                sendError(res, 400, "VALIDATION_ERROR", err.message);
                return;
            }
            if (err.name === "CastError") {
                sendError(res, 400, "INVALID_ID", "One of the provided identifiers is not a valid id.");
                return;
            }
            if (err.code === 11000) {
                sendError(res, 409, "DUPLICATE", "A record with this value already exists.");
                return;
            }
            // Unexpected — log full detail server-side only, never to the client.
            console.error("[business-api] Unexpected error:", err);
            sendError(res, 500, "INTERNAL_ERROR", "Something went wrong. Please try again.");
        }
    };
}

function isValidObjectId(value) {
    return typeof value === "string" && mongoose.Types.ObjectId.isValid(value) && String(new mongoose.Types.ObjectId(value)) === value;
}

function requireObjectId(value, label = "id") {
    if (!isValidObjectId(value)) {
        throw badRequest("INVALID_ID", `${label} is not a valid id.`);
    }
    return value;
}

// Caps page size so a client can never force an unbounded collection load
// (see Milestone 2 spec §16/§18). Defaults match the spec exactly.
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

function parsePagination(query) {
    let page = parseInt(query.page, 10);
    let limit = parseInt(query.limit, 10);
    if (!Number.isFinite(page) || page < 1) page = 1;
    if (!Number.isFinite(limit) || limit < 1) limit = DEFAULT_LIMIT;
    if (limit > MAX_LIMIT) limit = MAX_LIMIT;
    return { page, limit, skip: (page - 1) * limit };
}

function buildPaginationMeta({ page, limit }, total) {
    return { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) };
}

// Escapes user-supplied search text before it's used inside a RegExp — a
// $regex built from unescaped input is both a correctness bug (special
// chars like `(` `.` `*` behave as regex syntax, not literal text) and,
// for pathological patterns, a ReDoS risk. This is the ONLY place raw
// client text is allowed to reach a Mongo query at all in this API — every
// other filter below is validated against an explicit whitelist of values.
function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseEnumParam(value, allowed, label) {
    if (value === undefined || value === null || value === "") return undefined;
    if (!allowed.includes(value)) {
        throw badRequest("INVALID_ENUM", `${label} must be one of: ${allowed.join(", ")}.`);
    }
    return value;
}

function parseDate(value, label) {
    if (value === undefined || value === null || value === "") return undefined;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        throw badRequest("INVALID_DATE", `${label} is not a valid date.`);
    }
    return date;
}

function parseNumberParam(value, label) {
    if (value === undefined || value === null || value === "") return undefined;
    const num = Number(value);
    if (!Number.isFinite(num)) {
        throw badRequest("INVALID_NUMBER", `${label} must be a number.`);
    }
    return num;
}

// Applies a `createdFrom`/`createdTo` range onto `filter.createdAt` — the
// one shared date-range pattern every list endpoint in this milestone uses.
function applyCreatedAtRange(filter, query) {
    const from = parseDate(query.createdFrom, "createdFrom");
    const to = parseDate(query.createdTo, "createdTo");
    if (from || to) {
        filter.createdAt = {};
        if (from) filter.createdAt.$gte = from;
        if (to) filter.createdAt.$lte = to;
    }
}

// Parses the request body defensively the same way every existing handler
// in this repo already does (api/enquire.js, api/auth/*) — Vercel usually
// pre-parses JSON bodies, but this stays safe if it arrives as a raw string.
function parseJsonBody(req) {
    let body = req.body;
    if (!body || typeof body === "string") {
        try {
            body = JSON.parse(body || "{}");
        } catch {
            throw badRequest("INVALID_JSON", "Request body is not valid JSON.");
        }
    }
    return body || {};
}

module.exports = {
    ApiError,
    badRequest,
    notFound,
    forbidden,
    withErrorHandling,
    isValidObjectId,
    requireObjectId,
    parsePagination,
    buildPaginationMeta,
    escapeRegex,
    parseEnumParam,
    parseDate,
    parseNumberParam,
    applyCreatedAtRange,
    parseJsonBody,
    DEFAULT_LIMIT,
    MAX_LIMIT,
};
