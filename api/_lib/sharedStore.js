// Shared key/value + rolling-counter + lock primitives used to coordinate
// Amber usage across every serverless invocation and every user.
//
// Backed by Upstash Redis (REST API — no persistent TCP connection needed,
// which is what makes it usable from stateless serverless functions) when
// UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are configured.
//
// IMPORTANT — read before trusting this in production:
// Without those two environment variables, everything below falls back to a
// plain in-process Map. That fallback is NOT shared across serverless
// instances (Vercel may run your function on several concurrent instances,
// each with its own memory) and is only useful for local development or a
// single always-warm instance. It is deliberately still functional (better
// than crashing) but does NOT provide the cross-user/cross-instance
// guarantees this whole feature exists for. See the README note this file
// links back to in the final report for exactly what to configure.
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const REDIS_AVAILABLE = Boolean(UPSTASH_URL && UPSTASH_TOKEN);

// Deliberately unconditional (previously gated behind NODE_ENV !== "production",
// which suppressed every one of these lines on Vercel — Vercel sets
// NODE_ENV=production for both Preview and Production builds, not just
// Production, so that gate meant this diagnostic trail was silently absent
// exactly where it was needed most). Every call site here logs only
// non-sensitive structured fields (source/priority/cache-status/action/cache
// keys/budget counts/error messages) — never a token, secret, Authorization
// header, or full response body.
function log(...args) {
    console.log("[Amber Gateway]", ...args);
}

// Deployed Vercel environments (VERCEL_ENV is Vercel's own signal for this —
// "production"/"preview" for real deployed infrastructure, "development"
// under `vercel dev`'s local emulation, and simply absent for a plain `node`
// invocation like this repo's scripts/verify-*.js) must NEVER silently fall
// back to per-instance memory for the Amber budget/lock/cache: every
// concurrently-running instance would independently enforce the full budget
// against its own empty state, multiplying real Amber traffic — exactly the
// failure mode RedisUnavailableError elsewhere in this file already exists
// to prevent for the "configured but unreachable" case. This closes the
// other case: "not configured at all," when that's really a deployed
// environment rather than genuine local dev. (NODE_ENV=="production" was
// considered and rejected — Vercel sets it for Preview AND Production, but
// so can an ambient CI shell running this repo's local-Redis-forced verify
// script, which would then fail closed for the wrong reason; VERCEL_ENV is
// unset in that case.) Local dev and the verify scripts are unaffected.
let warnedFallback = false;
function warnFallbackOnce() {
    if (["production", "preview"].includes(process.env.VERCEL_ENV)) {
        throw new RedisUnavailableError(new Error("UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN are not configured in a deployed Vercel environment"));
    }
    if (warnedFallback) return;
    warnedFallback = true;
    console.warn(
        "[Amber Gateway] UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN not set — " +
        "falling back to a per-instance in-memory store. This works for local dev " +
        "but does NOT coordinate across multiple deployed serverless instances."
    );
}

// Thrown when Redis IS configured (env vars present — this is production, or
// at least meant to behave like it) but the Upstash REST endpoint itself
// fails or is unreachable at request time. This is deliberately NOT the same
// thing as "Redis isn't configured" (REDIS_AVAILABLE === false), which is the
// expected, accepted local-dev shape that legitimately falls back to the
// in-memory Maps below. A configured-but-unreachable Redis must NOT fall
// back the same way: every one of Vercel's concurrently-running instances
// would silently start enforcing the FULL budget/lock/cooldown independently
// against its own empty in-memory state, multiplying the effective Amber
// request rate by however many instances happen to be warm — exactly the
// failure mode this whole architecture exists to prevent. Callers that can
// safely treat this as "temporarily unavailable" (see fetchAmber in
// amberGateway.js) catch this specific error and fail closed instead.
class RedisUnavailableError extends Error {
    constructor(cause) {
        super(`Redis is configured but temporarily unreachable: ${cause?.message || cause}`);
        this.name = "RedisUnavailableError";
        this.cause = cause;
    }
}

async function redisCommand(...args) {
    const url = `${UPSTASH_URL}/${args.map(encodeURIComponent).join("/")}`;
    let res;
    try {
        res = await fetch(url, { headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } });
    } catch (err) {
        throw new RedisUnavailableError(err);
    }
    if (!res.ok) throw new RedisUnavailableError(new Error(`Upstash command failed: ${res.status}`));
    const json = await res.json();
    return json.result;
}

// POST form (command as a JSON body array) — used for EVAL, where the Lua
// script body contains characters (quotes, newlines) that don't survive
// being encoded as URL path segments.
async function redisCommandPost(commandArray) {
    let res;
    try {
        res = await fetch(UPSTASH_URL, {
            method: "POST",
            headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, "Content-Type": "application/json" },
            body: JSON.stringify(commandArray),
        });
    } catch (err) {
        throw new RedisUnavailableError(err);
    }
    if (!res.ok) throw new RedisUnavailableError(new Error(`Upstash command failed: ${res.status}`));
    const json = await res.json();
    return json.result;
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
    if (REDIS_AVAILABLE) {
        const raw = await redisCommand("GET", key);
        return raw != null ? JSON.parse(raw) : undefined;
    }
    warnFallbackOnce();
    pruneMemValues();
    const entry = memValues.get(key);
    return entry ? entry.value : undefined;
}

async function sharedSet(key, value, ttlSeconds) {
    if (REDIS_AVAILABLE) {
        if (ttlSeconds) {
            await redisCommand("SET", key, JSON.stringify(value), "EX", String(Math.max(1, Math.ceil(ttlSeconds))));
        } else {
            // No TTL: used by callers that need a permanent record (e.g. the
            // auth user store) rather than a cache entry.
            await redisCommand("SET", key, JSON.stringify(value));
        }
        return;
    }
    warnFallbackOnce();
    memValues.set(key, { value, expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null });
}

// Atomic "set only if absent" — the building block for uniqueness
// constraints (e.g. reserving an email address at signup) where a plain
// GET-then-SET from application code would race under concurrent requests.
// Returns true if this call created the key, false if it already existed
// (in which case nothing was written). No TTL: permanent until explicitly
// deleted via sharedDelete.
async function sharedSetNX(key, value) {
    if (REDIS_AVAILABLE) {
        const result = await redisCommand("SET", key, JSON.stringify(value), "NX");
        return result === "OK";
    }
    warnFallbackOnce();
    pruneMemValues();
    if (memValues.has(key)) return false;
    memValues.set(key, { value, expiresAt: null });
    return true;
}

async function sharedDelete(key) {
    if (REDIS_AVAILABLE) {
        await redisCommand("DEL", key);
        return;
    }
    memValues.delete(key);
}

// Rolling-window request budget, reserved ATOMICALLY (check-and-record as one
// indivisible step). This matters: an earlier version checked the count and
// recorded the request as two separate steps, and concurrent requests for
// *different* cache keys (which don't share a stampede lock, so nothing else
// serializes them) could all read the same pre-record count and all pass the
// check before any of them recorded — a classic TOCTOU race that let far more
// than the configured budget through under real concurrent load. Verified
// with a test simulating 10 simultaneous distinct-city requests against a
// 6/minute budget: the old two-step version let all 10 through; this version
// correctly caps it at 6.
//
// Redis: a Lua script (EVAL) that prunes, counts, and conditionally ZADDs in
// one atomic round-trip — Redis guarantees a script runs without any other
// command interleaving. In-memory fallback: a plain synchronous function
// (no `await` inside it) — Node's single-threaded event loop can't interleave
// two synchronous calls either, so it's equally atomic for a single instance.
const RESERVE_SLOT_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local maxCount = tonumber(ARGV[3])
local member = ARGV[4]
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - windowMs)
local count = redis.call('ZCARD', key)
if count >= maxCount then
  return 0
end
redis.call('ZADD', key, now, member)
redis.call('EXPIRE', key, 120)
return 1
`;

// Generalized form of the same atomic reserve-a-slot-in-a-rolling-window
// primitive, parameterized by key — lets unrelated features (e.g. auth rate
// limiting) get the same TOCTOU-safe guarantee under their own Redis key
// without sharing Amber's "amber:requests" counter or its budget.
async function reserveSlot(key, windowMs, maxCount) {
    const now = Date.now();
    if (REDIS_AVAILABLE) {
        const member = `${now}-${Math.random().toString(36).slice(2, 8)}`;
        const result = await redisCommandPost(["EVAL", RESERVE_SLOT_SCRIPT, "1", key, String(now), String(windowMs), String(maxCount), member]);
        return result === 1;
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

// Amber's own budget check — unchanged behavior/signature, now implemented
// as a thin call into reserveSlot with Amber's fixed key so this file's one
// existing caller (amberGateway.js) needs no changes at all.
async function tryReserveSlot(windowMs, maxCount) {
    return reserveSlot("amber:requests", windowMs, maxCount);
}

// Read-only view of current usage, for logging only — never used to decide
// whether a request is allowed (that's tryReserveSlot's job, atomically).
async function peekRecentRequestCount(windowMs) {
    const cutoff = Date.now() - windowMs;
    if (REDIS_AVAILABLE) {
        const count = await redisCommand("ZCOUNT", "amber:requests", String(cutoff), "+inf");
        return Number(count) || 0;
    }
    const log = memRequestLogs.get("amber:requests") || [];
    return log.filter((t) => t >= cutoff).length;
}

// Distributed lock (cache-stampede protection): only the caller that
// successfully "creates" the lock key proceeds to refresh Amber data; every
// other concurrent caller for the same cache key backs off instead of also
// hitting Amber. Redis: SET key value NX PX <ttl> is the standard atomic
// acquire-if-absent pattern.
//
// The lock value is a random per-acquisition token, not a constant — this is
// what makes releaseLock ownership-safe (see below). Returns the token on
// success (falsy on failure), and the caller must pass that same token back
// to releaseLock. Without this, if a lock TTL expired while its holder was
// still legitimately running (a slow Amber response) and a second caller
// then acquired a fresh lock for the same key, the FIRST caller's eventual
// `finally { releaseLock(key) }` would delete the SECOND caller's still-live
// lock — letting a third caller in while the second is still working, and
// defeating the one-upstream-request-per-key guarantee this exists for.
async function acquireLock(key, ttlMs) {
    const token = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    if (REDIS_AVAILABLE) {
        const result = await redisCommand("SET", key, token, "NX", "PX", String(ttlMs));
        return result === "OK" ? token : null;
    }
    warnFallbackOnce();
    const now = Date.now();
    const existing = memLocks.get(key);
    if (existing && now < existing.expiresAt) return null;
    memLocks.set(key, { token, expiresAt: now + ttlMs });
    return token;
}

// Compare-and-delete: only removes the lock if its current value still
// matches the token this caller was granted at acquire time. A plain
// unconditional DEL would happily delete a *different, newer* holder's lock
// (see acquireLock's comment) — this must be atomic (read+compare+delete as
// one step), hence the Lua script for the Redis path, the same reasoning as
// tryReserveSlot's RESERVE_SLOT_SCRIPT above.
const RELEASE_LOCK_SCRIPT = `
local key = KEYS[1]
local expectedToken = ARGV[1]
if redis.call('GET', key) == expectedToken then
  return redis.call('DEL', key)
else
  return 0
end
`;

async function releaseLock(key, token) {
    if (REDIS_AVAILABLE) {
        await redisCommandPost(["EVAL", RELEASE_LOCK_SCRIPT, "1", key, token]).catch(() => {
            // Best-effort: if this fails, the lock simply expires on its own
            // TTL instead of being released early. Never let a release failure
            // surface as a request failure — the fetch it was protecting has
            // already succeeded or failed on its own by this point.
        });
        return;
    }
    const existing = memLocks.get(key);
    if (existing && existing.token === token) memLocks.delete(key);
}

module.exports = {
    REDIS_AVAILABLE,
    RedisUnavailableError,
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
