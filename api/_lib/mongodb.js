// Reusable MongoDB (Mongoose) connection for serverless functions. A warm
// Vercel serverless instance can handle many invocations over its lifetime,
// so the connection is cached on `global` and reused across them — opening
// a fresh connection per request would exhaust MongoDB's connection limit
// under real traffic. This is the standard Mongoose-on-serverless pattern.
//
// Completely independent of Amber's Redis-backed architecture
// (api/_lib/sharedStore.js, amberGateway.js) — nothing here is imported by
// or imports those files, and this module never touches Upstash or
// "amber:*" keys. It is also independent of the Redis-backed auth store
// (api/_lib/userStore.js, session.js) added in the previous milestone —
// see docs/marketing-data-architecture.md for how those two will
// eventually be reconciled.
const mongoose = require("mongoose");

const MONGODB_URI = process.env.MONGODB_URI;

class MongoNotConfiguredError extends Error {
    constructor() {
        super("MONGODB_URI is not set — MongoDB-backed features are unavailable");
        this.name = "MongoNotConfiguredError";
    }
}

// `global` (not a module-level variable) is what makes this survive
// serverless warm-start reuse and Vercel/CRA dev hot-reload re-evaluating
// this module — a plain top-level `let` would still work across warm
// invocations in practice, but caching on `global` is the documented-safe
// version of this pattern and costs nothing extra.
let cached = global.__ivyhutsMongoose;
if (!cached) {
    cached = global.__ivyhutsMongoose = { conn: null, promise: null };
}

async function connectToDatabase() {
    if (!MONGODB_URI) {
        throw new MongoNotConfiguredError();
    }
    if (cached.conn) {
        return cached.conn;
    }
    if (!cached.promise) {
        // Never log MONGODB_URI itself — it embeds the username/password.
        console.log("[mongodb] Connecting...");
        cached.promise = mongoose
            .connect(MONGODB_URI, {
                maxPoolSize: 10,
                serverSelectionTimeoutMS: 10000,
            })
            .then((mongooseInstance) => {
                console.log("[mongodb] Connected.");
                return mongooseInstance;
            })
            .catch((err) => {
                // Don't cache a rejected connection attempt — let the next
                // call retry instead of permanently failing until restart.
                cached.promise = null;
                console.error("[mongodb] Connection FAILED:", err.message);
                throw err;
            });
    }
    cached.conn = await cached.promise;
    return cached.conn;
}

async function disconnectFromDatabase() {
    if (cached.conn) {
        await mongoose.disconnect();
        cached.conn = null;
        cached.promise = null;
    }
}

module.exports = { connectToDatabase, disconnectFromDatabase, MongoNotConfiguredError };
