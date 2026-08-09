#!/usr/bin/env node
// Focused verification for Milestone 4 (Wishlist & Behavioral Intelligence):
// api/wishlist/index.js, api/wishlist/[propertyId].js, api/events/index.js,
// and the Wishlist model changes behind them. Same style as
// scripts/verify-business-api.js / scripts/verify-enquiry-capture.js: a
// standalone Node script exercising the real handler functions against the
// real test database, not Jest.
//
// REDIS: forced into in-memory fallback for this run (mirrors the other
// verify-* scripts) — the throwaway test accounts created here have no
// business touching the real Upstash instance.
//
// MONGODB: uses the real MONGODB_URI from .env.local, guarded by the same
// "database name must contain 'test'" check as the other verify-* scripts.
"use strict";

const assert = require("assert");
const path = require("path");
const ROOT = path.join(__dirname, "..");

require("dotenv").config({ path: path.join(ROOT, ".env.local") });
require("dotenv").config({ path: path.join(ROOT, ".env") });
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  PASS  ${name}`);
    } catch (err) {
        failed++;
        failures.push({ name, message: err.message });
        console.log(`  FAIL  ${name}\n        ${err.message}`);
    }
}

function mockReq({ method = "GET", body, cookie, query = {} } = {}) {
    return {
        method,
        body,
        query: { ...query },
        headers: cookie ? { cookie } : {},
        socket: { remoteAddress: "127.0.0.1" },
    };
}
function mockRes() {
    const res = { statusCode: 200, headers: {}, body: undefined };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (body) => { res.body = JSON.parse(JSON.stringify(body)); return res; };
    res.setHeader = (key, value) => { res.headers[key] = value; return res; };
    return res;
}

function getDbNameFromUri(uri) {
    const match = /\/([^/?]+)(\?|$)/.exec(uri.replace(/^mongodb(\+srv)?:\/\//, "mongodb://").split("@").pop());
    return match ? match[1] : "";
}

async function main() {
    console.log("=== IvyHuts Wishlist & Behavioral Event Verification (Milestone 4) ===");
    console.log("Redis: forced in-memory fallback for this run.\n");

    const MONGODB_URI = process.env.MONGODB_URI;
    if (!MONGODB_URI) {
        console.log("MONGODB_URI is not set — live DB verification cannot run.");
        process.exitCode = 1;
        return;
    }
    const dbName = getDbNameFromUri(MONGODB_URI);
    const looksLikeTestDb = /test/i.test(dbName);
    if (!looksLikeTestDb && process.env.ALLOW_MONGODB_LIVE_TEST !== "true") {
        console.log(`MONGODB_URI points at database "${dbName}", which doesn't look like a test database.`);
        console.log("Refusing to run. Point MONGODB_URI at a database whose name contains \"test\", or set ALLOW_MONGODB_LIVE_TEST=true.");
        process.exitCode = 1;
        return;
    }

    const { connectToDatabase, disconnectFromDatabase } = require(path.join(ROOT, "api", "_lib", "mongodb"));
    const userStore = require(path.join(ROOT, "api", "_lib", "userStore"));
    const session = require(path.join(ROOT, "api", "_lib", "session"));
    const { resolveMongoUser } = require(path.join(ROOT, "api", "_lib", "businessAuth"));
    const User = require(path.join(ROOT, "api", "_lib", "models", "User"));
    const Wishlist = require(path.join(ROOT, "api", "_lib", "models", "Wishlist"));
    const UserEvent = require(path.join(ROOT, "api", "_lib", "models", "UserEvent"));
    const wishlistIndex = require(path.join(ROOT, "api", "wishlist", "index.js"));
    const wishlistItem = require(path.join(ROOT, "api", "wishlist", "[propertyId].js"));
    const eventsIndex = require(path.join(ROOT, "api", "events", "index.js"));

    await connectToDatabase();
    console.log("MongoDB connection established for live verification.\n");

    const runId = `m4-verify-${Date.now()}`;
    const createdUserIds = [];

    async function createActor(tag) {
        const email = `${runId}-${tag}@example.test`;
        const redisUser = await userStore.createUser({ name: `Test ${tag}`, email, password: "TestPassword123!", phone: "9876543210" });
        const sessionId = await session.createSession(redisUser.id);
        const mongoUser = await resolveMongoUser(redisUser);
        createdUserIds.push(mongoUser._id);
        return { redisUser, mongoUser, cookie: `${session.COOKIE_NAME}=${sessionId}` };
    }

    const userA = await createActor("user-a");
    const userB = await createActor("user-b");

    const propertyOne = { propertyId: `${runId}-prop-1`, slug: "prop-1", propertyName: "Test Studios", city: "London", image: "https://example.test/img1.jpg", price: { amount: 250, currency: "£" } };
    const propertyTwo = { propertyId: `${runId}-prop-2`, slug: "prop-2", propertyName: "Test Halls", city: "Manchester", image: null, price: null };

    // ══════════════════════════ AUTHENTICATION ══════════════════════════
    await test("AUTH: GET /api/wishlist with no session -> 401", async () => {
        const res = mockRes();
        await wishlistIndex(mockReq({ method: "GET" }), res);
        assert.strictEqual(res.statusCode, 401);
    });
    await test("AUTH: POST /api/wishlist with no session -> 401", async () => {
        const res = mockRes();
        await wishlistIndex(mockReq({ method: "POST", body: propertyOne }), res);
        assert.strictEqual(res.statusCode, 401);
    });
    await test("AUTH: DELETE /api/wishlist/:propertyId with no session -> 401", async () => {
        const res = mockRes();
        await wishlistItem(mockReq({ method: "DELETE", query: { propertyId: propertyOne.propertyId } }), res);
        assert.strictEqual(res.statusCode, 401);
    });
    await test("AUTH: authenticated GET /api/wishlist -> 200 with empty items initially", async () => {
        const res = mockRes();
        await wishlistIndex(mockReq({ method: "GET", cookie: userA.cookie }), res);
        assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
        assert.deepStrictEqual(res.body.data.items, []);
    });

    // ══════════════════════════ ADD ══════════════════════════
    await test("ADD: POST /api/wishlist adds a property -> 201, item present", async () => {
        const res = mockRes();
        await wishlistIndex(mockReq({ method: "POST", cookie: userA.cookie, body: propertyOne }), res);
        assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
        assert.strictEqual(res.body.data.items.length, 1);
        assert.strictEqual(res.body.data.items[0].propertyId, propertyOne.propertyId);
        assert.strictEqual(res.body.data.items[0].city, "London");
        assert.strictEqual(res.body.data.items[0].price.amount, 250);
    });
    await test("ADD: property snapshot persists in MongoDB with slug/image/price", async () => {
        const doc = await Wishlist.findOne({ userId: userA.mongoUser._id });
        assert.ok(doc, "wishlist document should exist");
        const item = doc.items.find((i) => i.propertyId === propertyOne.propertyId);
        assert.ok(item);
        assert.strictEqual(item.slug, "prop-1");
        assert.strictEqual(item.image, propertyOne.image);
        assert.strictEqual(item.price.currency, "£");
    });
    await test("ADD: invalid (empty) propertyId -> 400, no item inserted", async () => {
        const res = mockRes();
        await wishlistIndex(mockReq({ method: "POST", cookie: userA.cookie, body: { propertyId: "" } }), res);
        assert.strictEqual(res.statusCode, 400);
    });

    // ══════════════════════════ DUPLICATE ══════════════════════════
    await test("DUPLICATE: adding the same property twice results in exactly one item, 200 not 201", async () => {
        const res = mockRes();
        await wishlistIndex(mockReq({ method: "POST", cookie: userA.cookie, body: propertyOne }), res);
        assert.strictEqual(res.statusCode, 200, "a duplicate add should be idempotent (200), not a fresh 201");
        assert.strictEqual(res.body.data.items.filter((i) => i.propertyId === propertyOne.propertyId).length, 1);
        const doc = await Wishlist.findOne({ userId: userA.mongoUser._id });
        assert.strictEqual(doc.items.filter((i) => i.propertyId === propertyOne.propertyId).length, 1);
    });
    await test("DUPLICATE: exactly one WISHLIST_ADDED event was recorded for the duplicate add (not two)", async () => {
        const count = await UserEvent.countDocuments({ userId: userA.mongoUser._id, event: "WISHLIST_ADDED", "properties.propertyId": propertyOne.propertyId });
        assert.strictEqual(count, 1, `expected exactly 1 WISHLIST_ADDED event, found ${count}`);
    });

    // ══════════════════════════ SECOND ITEM + GET :propertyId ══════════════════════════
    await test("ADD: a second, different property is added alongside the first", async () => {
        const res = mockRes();
        await wishlistIndex(mockReq({ method: "POST", cookie: userA.cookie, body: propertyTwo }), res);
        assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
        assert.strictEqual(res.body.data.items.length, 2);
    });
    await test("GET /api/wishlist/:propertyId reports wishlisted:true for a saved property", async () => {
        const res = mockRes();
        await wishlistItem(mockReq({ method: "GET", cookie: userA.cookie, query: { propertyId: propertyOne.propertyId } }), res);
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.body.data.wishlisted, true);
    });
    await test("GET /api/wishlist/:propertyId reports wishlisted:false for a property never saved", async () => {
        const res = mockRes();
        await wishlistItem(mockReq({ method: "GET", cookie: userA.cookie, query: { propertyId: "never-saved-property" } }), res);
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.body.data.wishlisted, false);
    });

    // ══════════════════════════ REMOVE ══════════════════════════
    await test("REMOVE: DELETE /api/wishlist/:propertyId removes the item", async () => {
        const res = mockRes();
        await wishlistItem(mockReq({ method: "DELETE", cookie: userA.cookie, query: { propertyId: propertyTwo.propertyId } }), res);
        assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
        assert.strictEqual(res.body.data.removed, true);
        const doc = await Wishlist.findOne({ userId: userA.mongoUser._id });
        assert.ok(!doc.items.some((i) => i.propertyId === propertyTwo.propertyId));
    });
    await test("REMOVE: a WISHLIST_REMOVED event was recorded", async () => {
        const evt = await UserEvent.findOne({ userId: userA.mongoUser._id, event: "WISHLIST_REMOVED", "properties.propertyId": propertyTwo.propertyId });
        assert.ok(evt, "expected a WISHLIST_REMOVED event");
    });
    await test("REMOVE: removing an already-absent property is safe (200, removed:false, no corruption)", async () => {
        const res = mockRes();
        await wishlistItem(mockReq({ method: "DELETE", cookie: userA.cookie, query: { propertyId: propertyTwo.propertyId } }), res);
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.body.data.removed, false);
        const doc = await Wishlist.findOne({ userId: userA.mongoUser._id });
        assert.strictEqual(doc.items.length, 1, "wishlist should still just have the one remaining item, not be corrupted");
    });
    await test("REMOVE: no extra WISHLIST_REMOVED event recorded for the already-absent removal", async () => {
        const count = await UserEvent.countDocuments({ userId: userA.mongoUser._id, event: "WISHLIST_REMOVED", "properties.propertyId": propertyTwo.propertyId });
        assert.strictEqual(count, 1, "a no-op removal must not record a second event");
    });

    // ══════════════════════════ CROSS-USER SECURITY ══════════════════════════
    await test("SECURITY: User B's own (empty) wishlist is separate from User A's", async () => {
        const res = mockRes();
        await wishlistIndex(mockReq({ method: "GET", cookie: userB.cookie }), res);
        assert.strictEqual(res.statusCode, 200);
        assert.deepStrictEqual(res.body.data.items, [], "User B must never see User A's wishlist items");
    });
    await test("SECURITY: User B adding the same propertyId as User A does not affect User A's wishlist", async () => {
        const res = mockRes();
        await wishlistIndex(mockReq({ method: "POST", cookie: userB.cookie, body: propertyOne }), res);
        assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
        const aDoc = await Wishlist.findOne({ userId: userA.mongoUser._id });
        assert.strictEqual(aDoc.items.filter((i) => i.propertyId === propertyOne.propertyId).length, 1, "User A's copy must be untouched by User B's add");
    });
    await test("SECURITY: User B's DELETE never removes User A's item (no :userId parameter exists in this API at all)", async () => {
        const res = mockRes();
        await wishlistItem(mockReq({ method: "DELETE", cookie: userB.cookie, query: { propertyId: propertyOne.propertyId } }), res);
        assert.strictEqual(res.statusCode, 200);
        const aDoc = await Wishlist.findOne({ userId: userA.mongoUser._id });
        assert.ok(aDoc.items.some((i) => i.propertyId === propertyOne.propertyId), "User A's item must still be present after User B deleted their own copy");
    });
    await test("SECURITY: a spoofed body.userId is never honored (identity always from session)", async () => {
        const res = mockRes();
        await wishlistIndex(mockReq({
            method: "POST",
            cookie: userA.cookie,
            body: { ...propertyTwo, userId: String(userB.mongoUser._id) },
        }), res);
        assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
        const bDoc = await Wishlist.findOne({ userId: userB.mongoUser._id });
        assert.ok(!bDoc.items.some((i) => i.propertyId === propertyTwo.propertyId), "the spoofed userId must not cause the item to land in User B's wishlist");
        const aDoc = await Wishlist.findOne({ userId: userA.mongoUser._id });
        assert.ok(aDoc.items.some((i) => i.propertyId === propertyTwo.propertyId), "the item must land in the caller's own (User A's) wishlist");
    });

    // ══════════════════════════ EVENTS: PROPERTY_VIEWED / CITY_SEARCHED ══════════════════════════
    await test("EVENTS: POST /api/events PROPERTY_VIEWED (authenticated) records an event", async () => {
        const res = mockRes();
        await eventsIndex(mockReq({
            method: "POST",
            cookie: userA.cookie,
            body: { event: "PROPERTY_VIEWED", properties: { propertyId: propertyOne.propertyId, propertySlug: propertyOne.slug, city: propertyOne.city, source: "property-detail" } },
        }), res);
        assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
        assert.strictEqual(res.body.data.recorded, true);
        const evt = await UserEvent.findOne({ userId: userA.mongoUser._id, event: "PROPERTY_VIEWED", "properties.propertyId": propertyOne.propertyId });
        assert.ok(evt);
    });
    await test("EVENTS: a second PROPERTY_VIEWED for the same user+property within the dedup window is skipped", async () => {
        const res = mockRes();
        await eventsIndex(mockReq({
            method: "POST",
            cookie: userA.cookie,
            body: { event: "PROPERTY_VIEWED", properties: { propertyId: propertyOne.propertyId, city: propertyOne.city } },
        }), res);
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.body.data.recorded, false);
        assert.strictEqual(res.body.data.reason, "deduped");
        const count = await UserEvent.countDocuments({ userId: userA.mongoUser._id, event: "PROPERTY_VIEWED", "properties.propertyId": propertyOne.propertyId });
        assert.strictEqual(count, 1, "the deduped repeat view must not have created a second event");
    });
    await test("EVENTS: CITY_SEARCHED (authenticated) records an event", async () => {
        const res = mockRes();
        await eventsIndex(mockReq({
            method: "POST",
            cookie: userA.cookie,
            body: { event: "CITY_SEARCHED", properties: { city: "London", source: "listings-page" } },
        }), res);
        assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
        const evt = await UserEvent.findOne({ userId: userA.mongoUser._id, event: "CITY_SEARCHED", "properties.city": "London" });
        assert.ok(evt);
    });
    await test("EVENTS: an anonymous request is accepted (200) but records nothing", async () => {
        const before = await UserEvent.countDocuments({});
        const res = mockRes();
        await eventsIndex(mockReq({ method: "POST", body: { event: "PROPERTY_VIEWED", properties: { propertyId: "anon-prop", city: "Berlin" } } }), res);
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.body.data.recorded, false);
        assert.strictEqual(res.body.data.reason, "anonymous");
        const after = await UserEvent.countDocuments({});
        assert.strictEqual(after, before, "an anonymous event call must not insert any UserEvent document");
    });
    await test("EVENTS: an unlisted event name is rejected with 400 (no arbitrary event injection)", async () => {
        const res = mockRes();
        await eventsIndex(mockReq({ method: "POST", cookie: userA.cookie, body: { event: "SOMETHING_MADE_UP", properties: {} } }), res);
        assert.strictEqual(res.statusCode, 400);
    });
    await test("EVENTS: WISHLIST_ADDED/REMOVED cannot be forged through /api/events (not in the whitelist)", async () => {
        const res = mockRes();
        await eventsIndex(mockReq({ method: "POST", cookie: userA.cookie, body: { event: "WISHLIST_ADDED", properties: { propertyId: "forged" } } }), res);
        assert.strictEqual(res.statusCode, 400);
    });

    // ══════════════════════════ INDEXES ══════════════════════════
    await test("INDEXES: Wishlist.userId unique index exists in MongoDB", async () => {
        const indexes = await Wishlist.collection.indexes();
        const idx = indexes.find((i) => i.key && i.key.userId === 1);
        assert.ok(idx, "expected a userId index on Wishlist");
        assert.ok(idx.unique, "the userId index must be unique");
    });
    await test("INDEXES: Wishlist['items.propertyId'] index exists in MongoDB", async () => {
        const indexes = await Wishlist.collection.indexes();
        const idx = indexes.find((i) => i.key && i.key["items.propertyId"] === 1);
        assert.ok(idx, "expected a declared index on items.propertyId");
    });
    await test("INDEXES: UserEvent userId+timestamp and event+timestamp indexes exist", async () => {
        const indexes = await UserEvent.collection.indexes();
        const userIdx = indexes.find((i) => i.key && i.key.userId === 1 && i.key.timestamp === -1);
        const eventIdx = indexes.find((i) => i.key && i.key.event === 1 && i.key.timestamp === -1);
        assert.ok(userIdx, "expected a userId+timestamp index on UserEvent");
        assert.ok(eventIdx, "expected an event+timestamp index on UserEvent");
    });

    // ══════════════════════════ CLEANUP ══════════════════════════
    console.log("\nCleaning up test records...");
    await UserEvent.deleteMany({ userId: { $in: createdUserIds } });
    await Wishlist.deleteMany({ userId: { $in: createdUserIds } });
    await User.deleteMany({ _id: { $in: createdUserIds } });

    const remaining = {
        users: await User.countDocuments({ _id: { $in: createdUserIds } }),
        wishlists: await Wishlist.countDocuments({ userId: { $in: createdUserIds } }),
        events: await UserEvent.countDocuments({ userId: { $in: createdUserIds } }),
    };
    await test("CLEANUP: all test documents removed (verified by re-query)", async () => {
        assert.deepStrictEqual(remaining, { users: 0, wishlists: 0, events: 0 }, `residual test data found: ${JSON.stringify(remaining)}`);
    });
    console.log(`Cleanup complete. Created during this run: ${createdUserIds.length} users (all removed, along with their wishlists/events).`);

    await disconnectFromDatabase();

    console.log(`\n=== ${passed} passed, ${failed} failed ===`);
    if (failed > 0) {
        console.log("\nFailures:");
        failures.forEach((f) => console.log(`  - ${f.name}: ${f.message}`));
        process.exitCode = 1;
    }
}

main().catch((err) => {
    console.error("Verification script crashed:", err);
    process.exitCode = 1;
});
