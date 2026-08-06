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

function log(...args) {
    if (process.env.NODE_ENV !== "production") console.log("[Amber Gateway]", ...args);
}

let warnedFallback = false;
function warnFallbackOnce() {
    if (warnedFallback) return;
    warnedFallback = true;
    console.warn(
        "[Amber Gateway] UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN not set — " +
        "falling back to a per-instance in-memory store. This works for local dev " +
        "but does NOT coordinate across multiple deployed serverless instances."
    );
}

async function redisCommand(...args) {
    const url = `${UPSTASH_URL}/${args.map(encodeURIComponent).join("/")}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } });
    if (!res.ok) throw new Error(`Upstash command failed: ${res.status}`);
    const json = await res.json();
    return json.result;
}

// POST form (command as a JSON body array) — used for EVAL, where the Lua
// script body contains characters (quotes, newlines) that don't survive
// being encoded as URL path segments.
async function redisCommandPost(commandArray) {
    const res = await fetch(UPSTASH_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify(commandArray),
    });
    if (!res.ok) throw new Error(`Upstash command failed: ${res.status}`);
    const json = await res.json();
    return json.result;
}

// ── In-memory fallback state (single instance / local dev only) ──
const memValues = new Map(); // key -> { value, expiresAt }
const memRequestLog = []; // timestamps for the rolling budget
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
        await redisCommand("SET", key, JSON.stringify(value), "EX", String(Math.max(1, Math.ceil(ttlSeconds))));
        return;
    }
    warnFallbackOnce();
    memValues.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
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

async function tryReserveSlot(windowMs, maxCount) {
    const now = Date.now();
    if (REDIS_AVAILABLE) {
        const member = `${now}-${Math.random().toString(36).slice(2, 8)}`;
        const result = await redisCommandPost(["EVAL", RESERVE_SLOT_SCRIPT, "1", "amber:requests", String(now), String(windowMs), String(maxCount), member]);
        return result === 1;
    }
    warnFallbackOnce();
    const cutoff = now - windowMs;
    while (memRequestLog.length && memRequestLog[0] < cutoff) memRequestLog.shift();
    if (memRequestLog.length >= maxCount) return false;
    memRequestLog.push(now);
    return true;
}

// Read-only view of current usage, for logging only — never used to decide
// whether a request is allowed (that's tryReserveSlot's job, atomically).
async function peekRecentRequestCount(windowMs) {
    const cutoff = Date.now() - windowMs;
    if (REDIS_AVAILABLE) {
        const count = await redisCommand("ZCOUNT", "amber:requests", String(cutoff), "+inf");
        return Number(count) || 0;
    }
    return memRequestLog.filter((t) => t >= cutoff).length;
}

// Distributed lock (cache-stampede protection): only the caller that
// successfully "creates" the lock key proceeds to refresh Amber data; every
// other concurrent caller for the same cache key backs off instead of also
// hitting Amber. Redis: SET key value NX PX <ttl> is the standard atomic
// acquire-if-absent pattern.
async function acquireLock(key, ttlMs) {
    if (REDIS_AVAILABLE) {
        const result = await redisCommand("SET", key, "1", "NX", "PX", String(ttlMs));
        return result === "OK";
    }
    warnFallbackOnce();
    const now = Date.now();
    const existing = memLocks.get(key);
    if (existing && now < existing) return false;
    memLocks.set(key, now + ttlMs);
    return true;
}

async function releaseLock(key) {
    if (REDIS_AVAILABLE) {
        await redisCommand("DEL", key).catch(() => {});
        return;
    }
    memLocks.delete(key);
}

module.exports = {
    REDIS_AVAILABLE,
    sharedGet,
    sharedSet,
    tryReserveSlot,
    peekRecentRequestCount,
    acquireLock,
    releaseLock,
    log,
};