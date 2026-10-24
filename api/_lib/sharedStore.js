// Shared key/value + rolling-counter + lock primitives used to coordinate
// Amber usage across every serverless invocation and every user.
//
// Backed by MongoDB (the same database as everything else, via
// api/_lib/mongodb.js) in a single `kvstore` collection. This replaced the
// earlier Upstash Redis backend, whose fixed plan kept hitting its limit and
// taking the whole app down with it (login included). The exported API is
// unchanged, so no caller had to change.
//
// Document shapes in `kvstore` (all keyed by _id = the store key):
//   values: { _id, j: "<json>" }  or  { _id, z: <gzipped json> } (large values)
//   slots:  { _id, t: [timestamps] }   (reserveSlot's rolling window)
//   locks:  { _id, tok: "<token>" }
// Every document may carry `exp` (a Date). A TTL index deletes expired
// documents, but MongoDB only sweeps once a minute, so every read also
// checks `exp` itself — an expired-but-not-yet-swept document is treated
// as absent everywhere below.
//
// Opt-in: the MongoDB backend is used only when SHARED_STORE=mongo (and
// MONGODB_URI is set). Merely having MONGODB_URI is not enough on purpose —
// local dev and the verify scripts set it for other reasons, and must never
// write sessions, locks or Amber budget entries into the production store.
// Otherwise everything falls back to a plain in-process Map, which is NOT
// shared across serverless instances; a deployed Vercel environment refuses
// that fallback outright (warnFallbackOnce).
const zlib = require("zlib");
const mongoose = require("mongoose");
const { connectToDatabase } = require("./mongodb");

const STORE_AVAILABLE = process.env.SHARED_STORE === "mongo" && Boolean(process.env.MONGODB_URI);
const COLLECTION = "kvstore";

// Deliberately unconditional (not gated on NODE_ENV — Vercel sets
// NODE_ENV=production for Preview too, which would hide this trail exactly
// where it's needed). Call sites log only non-sensitive structured fields.
function log(...args) {
    console.log("[Amber Gateway]", ...args);
}

// A deployed environment must NEVER silently fall back to per-instance
// memory for the Amber budget/lock/cache: every concurrently-running
// instance would independently enforce the full budget against its own
// empty state, multiplying real Amber traffic.
let warnedFallback = false;
function warnFallbackOnce() {
    if (["production", "preview"].includes(process.env.VERCEL_ENV)) {
        throw new StoreUnavailableError(new Error("SHARED_STORE=mongo / MONGODB_URI are not configured in a deployed Vercel environment"));
    }
    if (warnedFallback) return;
    warnedFallback = true;
    console.warn(
        "[Amber Gateway] SHARED_STORE=mongo not set — falling back to a per-instance " +
        "in-memory store. This works for local dev but does NOT coordinate " +
        "across multiple deployed serverless instances."
    );
}

// Thrown when the store IS configured but MongoDB fails or times out at
// request time. Must NOT fall back to memory (same multiplication problem
// as above) — callers that can treat this as "temporarily unavailable"
// (fetchAmber, advanceCrawl, the auth routes) catch it and fail closed.
class StoreUnavailableError extends Error {
    constructor(cause) {
        super(`Shared store is configured but temporarily unreachable: ${cause?.message || cause}`);
        this.name = "StoreUnavailableError";
        this.cause = cause;
    }
}

// Bounds a single store operation (not the initial connect, which has its
// own serverSelectionTimeoutMS) so a slow database fails fast into the
// callers' degraded paths instead of eating their upstream Amber deadline.
const STORE_TIMEOUT_MS = Number(process.env.STORE_TIMEOUT_MS) || 3000;

// Large values (Amber listing pages ~5MB, the crawl state ~1.6MB) are
// gzipped: 4.5-7x smaller, which keeps us well inside Atlas's data-transfer
// allowance. Small values (sessions, users, counters) stay plain JSON.
const COMPRESS_MIN_BYTES = 64 * 1024;

const DUPLICATE_KEY = 11000;

let indexPromise = null;
async function getCollection() {
    await connectToDatabase();
    const col = mongoose.connection.db.collection(COLLECTION);
    if (!indexPromise) {
        indexPromise = col.createIndex({ exp: 1 }, { expireAfterSeconds: 0 }).catch((err) => {
            indexPromise = null; // retry on the next call rather than never
            throw err;
        });
    }
    await indexPromise;
    return col;
}

// Runs `fn(collection)` with a timeout, converting any failure into
// StoreUnavailableError. `fn` handles expected errors (duplicate key) itself.
async function withStore(fn) {
    let timeoutId;
    try {
        const col = await getCollection();
        return await Promise.race([
            fn(col),
            new Promise((_, reject) => {
                timeoutId = setTimeout(() => reject(new Error(`MongoDB did not respond within ${STORE_TIMEOUT_MS}ms`)), STORE_TIMEOUT_MS);
            }),
        ]);
    } catch (err) {
        throw err instanceof StoreUnavailableError ? err : new StoreUnavailableError(err);
    } finally {
        clearTimeout(timeoutId);
    }
}

function notExpired(now = new Date()) {
    return { $or: [{ exp: null }, { exp: { $gt: now } }] };
}

function expiryFromSeconds(ttlSeconds) {
    return ttlSeconds ? new Date(Date.now() + Math.max(1, Math.ceil(ttlSeconds)) * 1000) : null;
}

// Stored as a JSON string (not a native BSON object) so the round trip is
// byte-for-byte what JSON.stringify/parse gives — Amber payloads can carry
// field names MongoDB treats specially, and callers rely on exact values.
function encodeValue(value) {
    const json = JSON.stringify(value);
    if (json === undefined) return { j: null };
    if (Buffer.byteLength(json) < COMPRESS_MIN_BYTES) return { j: json };
    return { z: zlib.gzipSync(json) };
}

function decodeValue(doc) {
    if (doc.z) return JSON.parse(zlib.gunzipSync(doc.z.buffer ?? doc.z).toString("utf8"));
    return doc.j != null ? JSON.parse(doc.j) : undefined;
}

// ── In-memory fallback state (single instance / local dev only) ──
const memValues = new Map(); // key -> { value, expiresAt }
const memRequestLogs = new Map(); // key -> timestamps[], one rolling window per reserveSlot key
const memLocks = new Map(); // key -> expiresAt

function pruneMemValues() {
    const now = Date.now();
    for (const [k, v] of memValues) if (v.expiresAt && now >= v.expiresAt) memValues.delete(k);
}

async function sharedGet(key) {
    if (STORE_AVAILABLE) {
        const doc = await withStore((col) => col.findOne({ _id: key, ...notExpired() }));
        return doc ? decodeValue(doc) : undefined;
    }
    warnFallbackOnce();
    pruneMemValues();
    const entry = memValues.get(key);
    return entry ? entry.value : undefined;
}

// No TTL: a permanent record (e.g. the auth user store), not a cache entry.
async function sharedSet(key, value, ttlSeconds) {
    if (STORE_AVAILABLE) {
        await withStore((col) => col.replaceOne({ _id: key }, { ...encodeValue(value), exp: expiryFromSeconds(ttlSeconds) }, { upsert: true }));
        return;
    }
    warnFallbackOnce();
    memValues.set(key, { value, expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null });
}

// Atomic "set only if absent" — the building block for uniqueness
// constraints (e.g. reserving an email address at signup). The unique _id
// makes insertOne the atomic step; an expired-but-unswept document is taken
// over with a conditional replace, which also only one caller can win.
// Returns true if this call created the key. No TTL.
async function sharedSetNX(key, value) {
    if (STORE_AVAILABLE) {
        return withStore(async (col) => {
            const doc = { _id: key, ...encodeValue(value), exp: null };
            try {
                await col.insertOne(doc);
                return true;
            } catch (err) {
                if (err.code !== DUPLICATE_KEY) throw err;
            }
            const res = await col.replaceOne({ _id: key, exp: { $lte: new Date() } }, doc);
            return res.modifiedCount === 1;
        });
    }
    warnFallbackOnce();
    pruneMemValues();
    if (memValues.has(key)) return false;
    memValues.set(key, { value, expiresAt: null });
    return true;
}

async function sharedDelete(key) {
    if (STORE_AVAILABLE) {
        await withStore((col) => col.deleteOne({ _id: key }));
        return;
    }
    memValues.delete(key);
}

// Rolling-window request budget, reserved ATOMICALLY (check-and-record as one
// indivisible step). A two-step check-then-record lets concurrent requests
// all read the same pre-record count and all pass — the TOCTOU race that
// once let 10 simultaneous requests through a 6/minute budget.
//
// MongoDB applies an update to a single document atomically, so the whole
// prune -> count -> conditionally-append runs as one pipeline update on the
// key's document. Two first-ever upserts racing on the same _id can collide
// on the unique index; the loser simply retries against the now-existing doc.
async function reserveSlot(key, windowMs, maxCount) {
    const now = Date.now();
    if (STORE_AVAILABLE) {
        const pipeline = [
            { $set: { t: { $filter: { input: { $ifNull: ["$t", []] }, cond: { $gt: ["$$this", now - windowMs] } } } } },
            { $set: { granted: { $lt: [{ $size: "$t" }, maxCount] } } },
            { $set: { t: { $cond: ["$granted", { $concatArrays: ["$t", [now]] }, "$t"] }, exp: new Date(now + windowMs + 60000) } },
        ];
        return withStore(async (col) => {
            for (let attempt = 0; ; attempt++) {
                try {
                    const doc = await col.findOneAndUpdate({ _id: key }, pipeline, { upsert: true, returnDocument: "after" });
                    return Boolean(doc?.granted);
                } catch (err) {
                    if (err.code !== DUPLICATE_KEY || attempt >= 2) throw err;
                }
            }
        });
    }
    warnFallbackOnce();
    const cutoff = now - windowMs;
    let log = memRequestLogs.get(key);
    if (!log) {
        log = [];
        memRequestLogs.set(key, log);
    }
    while (log.length && log[0] < cutoff) log.shift();
    if (log.length >= maxCount) return false;
    log.push(now);
    return true;
}

// Amber's own budget check — a thin call into reserveSlot with Amber's fixed
// key so amberGateway.js needs no changes.
async function tryReserveSlot(windowMs, maxCount) {
    return reserveSlot("amber:requests", windowMs, maxCount);
}

// Read-only view of current usage, for logging only — never used to decide
// whether a request is allowed (that's tryReserveSlot's job, atomically).
async function peekRecentRequestCount(windowMs) {
    const cutoff = Date.now() - windowMs;
    if (STORE_AVAILABLE) {
        const doc = await withStore((col) => col.findOne({ _id: "amber:requests" }, { projection: { t: 1 } }));
        return (doc?.t || []).filter((t) => t >= cutoff).length;
    }
    const log = memRequestLogs.get("amber:requests") || [];
    return log.filter((t) => t >= cutoff).length;
}

// Distributed lock (cache-stampede protection): only the caller that
// creates the lock document proceeds; every other concurrent caller backs
// off. An expired lock is taken over with a conditional update — once one
// caller has bumped `exp` into the future, nobody else's filter matches.
//
// The lock value is a random per-acquisition token so releaseLock only ever
// deletes the caller's OWN lock — never a newer holder's lock that was
// granted after this one's TTL ran out mid-request.
async function acquireLock(key, ttlMs) {
    const token = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    if (STORE_AVAILABLE) {
        return withStore(async (col) => {
            const exp = new Date(Date.now() + ttlMs);
            try {
                await col.insertOne({ _id: key, tok: token, exp });
                return token;
            } catch (err) {
                if (err.code !== DUPLICATE_KEY) throw err;
            }
            const res = await col.updateOne({ _id: key, exp: { $lte: new Date() } }, { $set: { tok: token, exp } });
            return res.modifiedCount === 1 ? token : null;
        });
    }
    warnFallbackOnce();
    const now = Date.now();
    const existing = memLocks.get(key);
    if (existing && now < existing.expiresAt) return null;
    memLocks.set(key, { token, expiresAt: now + ttlMs });
    return token;
}

// Compare-and-delete in one atomic step: the filter only matches while the
// lock still holds this caller's token.
async function releaseLock(key, token) {
    if (STORE_AVAILABLE) {
        await withStore((col) => col.deleteOne({ _id: key, tok: token })).catch(() => {
            // Best-effort: if this fails, the lock simply expires on its own
            // TTL. Never let a release failure surface as a request failure.
        });
        return;
    }
    const existing = memLocks.get(key);
    if (existing && existing.token === token) memLocks.delete(key);
}

module.exports = {
    STORE_AVAILABLE,
    // Old names kept so existing callers (and their `instanceof` checks)
    // work unchanged — these are the same values as the new names.
    REDIS_AVAILABLE: STORE_AVAILABLE,
    StoreUnavailableError,
    RedisUnavailableError: StoreUnavailableError,
    sharedGet,
    sharedSet,
    sharedSetNX,
    sharedDelete,
    tryReserveSlot,
    reserveSlot,
    peekRecentRequestCount,
    acquireLock,
    releaseLock,
    log,
};
