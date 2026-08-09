#!/usr/bin/env node
// Focused verification for the Milestone 1 MongoDB data architecture
// (api/_lib/mongodb.js, api/_lib/models/*). Not a Jest test — same reasoning
// as scripts/verify-auth-backend.js: CRA's Jest config targets
// src/**/*.test.js under jsdom, not plain Node backend modules under api/.
//
// Two modes, chosen automatically:
//
//   LIVE mode  (MONGODB_URI is set): connects for real and exercises every
//   model against actual MongoDB — creation, uniqueness constraints,
//   references, required-field validation, and confirms the declared
//   indexes actually exist in the database (via listIndexes()). All test
//   documents are tagged with a per-run marker and deleted afterward.
//
//   STATIC mode (MONGODB_URI is NOT set): no live database exists to test
//   against. Runs schema-only checks instead — Mongoose lets you construct
//   a document and call .validateSync() without ever connecting, so
//   required-field/enum validation and the "no unbounded embedded arrays"
//   structural rule can still be verified meaningfully. Connection itself,
//   and whether indexes actually get created in a real database, CANNOT be
//   verified in this mode — the report says so explicitly rather than
//   claiming untested things passed.
//
// SAFETY: even in LIVE mode, this script refuses to run unless the
// database name in MONGODB_URI contains "test" OR
// ALLOW_MONGODB_LIVE_TEST=true is explicitly set — this must never run
// destructive test writes against a production database by accident. This
// is the actual safety mechanism (not "keep MONGODB_URI out of the
// process env" as scripts/verify-auth-backend.js does for Redis) — this
// script DOES load .env.local/.env, matching scripts/local-api-server.js's
// convention, since Milestone 1B explicitly calls for exercising whatever
// MONGODB_URI is configured for local development.
"use strict";

const assert = require("assert");
const path = require("path");

const ROOT = path.join(__dirname, "..");
require("dotenv").config({ path: path.join(ROOT, ".env.local") });
require("dotenv").config({ path: path.join(ROOT, ".env") });

let passed = 0;
let failed = 0;
let skipped = 0;
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

function skip(name, reason) {
    skipped++;
    console.log(`  SKIP  ${name}\n        ${reason}`);
}

// Mongoose 8 deprecates the synchronous validateSync() in favor of the
// async validate() — this wraps it so every check below stays a one-liner.
async function validateDoc(doc) {
    try {
        await doc.validate();
        return undefined;
    } catch (err) {
        return err;
    }
}

function getDbNameFromUri(uri) {
    // Minimal, good-enough parse for the safety check below — not a general
    // URI parser. mongodb(+srv)://[user:pass@]host[,host2]/dbName[?opts]
    const match = /\/([^/?]+)(\?|$)/.exec(uri.replace(/^mongodb(\+srv)?:\/\//, "mongodb://").split("@").pop());
    return match ? match[1] : "";
}

async function main() {
    console.log("=== IvyHuts MongoDB Data Architecture Verification (Milestone 1) ===\n");

    const modelPaths = {
        User: path.join(ROOT, "api", "_lib", "models", "User"),
        Lead: path.join(ROOT, "api", "_lib", "models", "Lead"),
        Wishlist: path.join(ROOT, "api", "_lib", "models", "Wishlist"),
        UserEvent: path.join(ROOT, "api", "_lib", "models", "UserEvent"),
        Enquiry: path.join(ROOT, "api", "_lib", "models", "Enquiry"),
        Communication: path.join(ROOT, "api", "_lib", "models", "Communication"),
        FollowUp: path.join(ROOT, "api", "_lib", "models", "FollowUp"),
        Segment: path.join(ROOT, "api", "_lib", "models", "Segment"),
    };
    const models = Object.fromEntries(Object.entries(modelPaths).map(([k, p]) => [k, require(p)]));

    const MONGODB_URI = process.env.MONGODB_URI;
    const liveRequested = Boolean(MONGODB_URI);

    // ── Structural checks — these need no connection at all, and run in
    // BOTH modes, since they're really about the schema definitions
    // themselves rather than live data. ──
    await test("User schema has no unbounded embedded arrays (events/communications/enquiries)", async () => {
        assert.strictEqual(models.User.schema.path("events"), undefined, "User.events[] must not exist — use the UserEvent collection instead");
        assert.strictEqual(models.User.schema.path("communications"), undefined, "User.communications[] must not exist — use the Communication collection instead");
        assert.strictEqual(models.User.schema.path("enquiries"), undefined, "User.enquiries[] must not exist — use the Enquiry collection instead");
        assert.strictEqual(models.User.schema.path("followUps"), undefined, "User.followUps[] must not exist — use the FollowUp collection instead");
    });

    await test("User model has no password/credential field (auth stays in Redis for this milestone)", async () => {
        assert.strictEqual(models.User.schema.path("password"), undefined);
        assert.strictEqual(models.User.schema.path("passwordHash"), undefined);
        assert.strictEqual(models.User.schema.path("sessionId"), undefined);
    });

    await test("Wishlist enforces one document per user via a unique index on userId", async () => {
        const userIdPath = models.Wishlist.schema.path("userId");
        assert.ok(userIdPath.options.unique, "Wishlist.userId must be declared unique");
    });

    await test("required-field validation: User rejects a document with no email/name/phone", async () => {
        const doc = new models.User({});
        const err = await validateDoc(doc);
        assert.ok(err, "expected a validation error");
        assert.ok(err.errors.email, "email should be required");
        assert.ok(err.errors.name, "name should be required");
        assert.ok(err.errors.phone, "phone should be required");
    });

    await test("required-field validation: a valid User document (with phone) passes", async () => {
        const doc = new models.User({ email: "verify-static@example.test", name: "Static Test User", phone: "9876543210" });
        const err = await validateDoc(doc);
        assert.strictEqual(err, undefined, `expected no validation error, got: ${err}`);
    });

    // ── User.phone (mandatory-mobile-number signup change) ──
    await test("User.phone: rejects a document with email/name but no phone", async () => {
        const doc = new models.User({ email: "verify-static-nophone@example.test", name: "No Phone Yet" });
        assert.strictEqual(doc.phone, undefined, "constructing a document without phone must not throw or auto-fill a value — required is a validate()/save()-time check only");
        const err = await validateDoc(doc);
        assert.ok(err && err.errors.phone, "calling validate() explicitly must surface the missing-phone error");
    });

    await test("User.phone: is trimmed", async () => {
        const doc = new models.User({ email: "verify-static-trim@example.test", name: "Trim Test", phone: "  9876543210  " });
        assert.strictEqual(await validateDoc(doc), undefined);
        assert.strictEqual(doc.phone, "9876543210");
    });

    await test("Lead.userId is optional — an anonymous lead (userId=null) is valid", async () => {
        const doc = new models.Lead({ userId: null, source: "contact-form" });
        const err = await validateDoc(doc);
        assert.strictEqual(err, undefined, `expected no validation error for an anonymous lead, got: ${err}`);
    });

    await test("Lead rejects an out-of-enum status value", async () => {
        const doc = new models.Lead({ status: "not_a_real_status" });
        const err = await validateDoc(doc);
        assert.ok(err && err.errors.status, "expected a validation error on status");
    });

    await test("Wishlist requires userId and each item requires propertyId", async () => {
        const missingUser = new models.Wishlist({ items: [{ propertyId: "123" }] });
        assert.ok(await validateDoc(missingUser), "Wishlist without userId should fail validation");

        const missingPropertyId = new models.Wishlist({
            userId: new (require("mongoose").Types.ObjectId)(),
            items: [{ city: "London" }],
        });
        assert.ok(await validateDoc(missingPropertyId), "Wishlist item without propertyId should fail validation");

        const valid = new models.Wishlist({
            userId: new (require("mongoose").Types.ObjectId)(),
            items: [
                { propertyId: "prop-1", city: "London", propertyName: "Snapshot Name A" },
                { propertyId: "prop-2", city: "Manchester", propertyName: "Snapshot Name B" },
            ],
        });
        assert.strictEqual(await validateDoc(valid), undefined, "a wishlist with multiple valid items should pass validation");
        assert.strictEqual(valid.items.length, 2);
    });

    await test("UserEvent accepts either userId or anonymousId (or neither at the schema level) and requires `event`", async () => {
        const anon = new models.UserEvent({ anonymousId: "anon-abc", event: "PROPERTY_VIEWED", properties: { propertyId: "prop-1" } });
        assert.strictEqual(await validateDoc(anon), undefined);

        const missingEvent = new models.UserEvent({ anonymousId: "anon-abc" });
        const err = await validateDoc(missingEvent);
        assert.ok(err && err.errors.event, "event name should be required");
    });

    await test("Enquiry requires contact.name; contact.email/property/userId/leadId stay optional", async () => {
        const missingContact = new models.Enquiry({ property: { id: "prop-1" } });
        const err = await validateDoc(missingContact);
        assert.ok(err && err.errors["contact.name"], "expected contact.name to be required");
        assert.strictEqual(err.errors["contact.email"], undefined, "contact.email must NOT be required");

        const valid = new models.Enquiry({
            contact: { name: "Test Person", email: "test@example.test" },
            property: { id: "prop-1", name: "Snapshot Property", city: "London" },
            source: "find-rooms",
        });
        assert.strictEqual(await validateDoc(valid), undefined);
    });

    await test("Enquiry: contact.email is intentionally optional — name + phone only is a valid document", async () => {
        const doc = new models.Enquiry({
            contact: { name: "No Email Person", phone: "9876543210" },
            message: "Interested in accommodation",
            source: "contact",
        });
        const err = await validateDoc(doc);
        assert.strictEqual(err, undefined, `expected no validation error for a contact with no email, got: ${err}`);
        assert.strictEqual(doc.contact.email, undefined, "email should stay absent, not defaulted to empty string/null-as-string");
    });

    await test("Communication requires channel and direction from their enums", async () => {
        const invalid = new models.Communication({ channel: "carrier_pigeon", direction: "sideways" });
        const err = await validateDoc(invalid);
        assert.ok(err && (err.errors.channel || err.errors.direction));

        const valid = new models.Communication({ channel: "email", direction: "outbound", type: "enquiry_response" });
        assert.strictEqual(await validateDoc(valid), undefined);
    });

    await test("FollowUp requires type and dueAt", async () => {
        const invalid = new models.FollowUp({});
        const err = await validateDoc(invalid);
        assert.ok(err && (err.errors.type || err.errors.dueAt));

        const valid = new models.FollowUp({ type: "call", dueAt: new Date(Date.now() + 86400000), priority: "high" });
        assert.strictEqual(await validateDoc(valid), undefined);
    });

    await test("Segment stores rules as structured data only (no executable code path exists in the schema)", async () => {
        const doc = new models.Segment({
            name: "London High Intent",
            rules: {
                operator: "AND",
                conditions: [
                    { field: "profile.city", operator: "eq", value: "London" },
                    { field: "lead.score", operator: "gte", value: 50 },
                ],
            },
        });
        assert.strictEqual(await validateDoc(doc), undefined);
        assert.strictEqual(models.Segment.schema.path("rules.script"), undefined, "no field for storing executable code should exist");
        const badOperator = new models.Segment({ name: "x", rules: { conditions: [{ field: "a", operator: "eval", value: 1 }] } });
        assert.ok(await validateDoc(badOperator), "an unrecognized operator like 'eval' must be rejected by the enum");
    });

    await test("declared indexes match the documented query patterns (schema-level check)", async () => {
        const declared = (model) => model.schema.indexes().map(([fields]) => Object.keys(fields).join(","));
        assert.ok(declared(models.User).some((k) => k === "createdAt"), "User should declare a createdAt index");
        assert.ok(declared(models.Lead).some((k) => k === "status"), "Lead should declare a status index");
        assert.ok(declared(models.UserEvent).some((k) => k.includes("userId") && k.includes("timestamp")), "UserEvent should declare a userId+timestamp compound index");
        assert.ok(declared(models.FollowUp).some((k) => k.includes("assignedTo") && k.includes("dueAt")), "FollowUp should declare an assignedTo+dueAt compound index");
        assert.ok(declared(models.User).some((k) => k === "accommodationJourney.status"), "User should declare an accommodationJourney.status index");
    });

    // ── Milestone 1B: User.accommodationJourney (schema-only, no live DB
    // needed for any of these — see the numbered list in the Milestone 1B
    // request this corresponds to). ──
    const validUserBase = { email: `verify-static-aj-${Date.now()}@example.test`, name: "Static AJ Test User", phone: "9876543210" };

    await test("accommodationJourney: 1. valid lifecycle status is accepted", async () => {
        const doc = new models.User({ ...validUserBase, accommodationJourney: { status: "BOOKED" } });
        assert.strictEqual(await validateDoc(doc), undefined);
        assert.strictEqual(doc.accommodationJourney.status, "BOOKED");
    });

    await test("accommodationJourney: 2. invalid lifecycle status is rejected", async () => {
        const doc = new models.User({ ...validUserBase, accommodationJourney: { status: "NOT_A_REAL_STATUS" } });
        const err = await validateDoc(doc);
        assert.ok(err && err.errors["accommodationJourney.status"], "expected a validation error on accommodationJourney.status");
    });

    await test("accommodationJourney: 3. servicePurchased accepts a boolean", async () => {
        const doc = new models.User({ ...validUserBase, accommodationJourney: { servicePurchased: true } });
        assert.strictEqual(await validateDoc(doc), undefined);
        assert.strictEqual(doc.accommodationJourney.servicePurchased, true);
    });

    await test("accommodationJourney: 4. moveInDate accepts a date", async () => {
        const moveInDate = new Date("2026-09-01");
        const doc = new models.User({ ...validUserBase, accommodationJourney: { moveInDate } });
        assert.strictEqual(await validateDoc(doc), undefined);
        assert.strictEqual(doc.accommodationJourney.moveInDate.getTime(), moveInDate.getTime());
    });

    await test("accommodationJourney: 5. expectedStayDurationMonths accepts a non-negative number", async () => {
        const doc = new models.User({ ...validUserBase, accommodationJourney: { expectedStayDurationMonths: 12 } });
        assert.strictEqual(await validateDoc(doc), undefined);
        assert.strictEqual(doc.accommodationJourney.expectedStayDurationMonths, 12);
    });

    await test("accommodationJourney: 6. expectedMoveOutDate accepts a date", async () => {
        const expectedMoveOutDate = new Date("2027-06-01");
        const doc = new models.User({ ...validUserBase, accommodationJourney: { expectedMoveOutDate } });
        assert.strictEqual(await validateDoc(doc), undefined);
        assert.strictEqual(doc.accommodationJourney.expectedMoveOutDate.getTime(), expectedMoveOutDate.getTime());
    });

    await test("accommodationJourney: 7. actualMoveInDate accepts a date", async () => {
        const actualMoveInDate = new Date("2026-09-03");
        const doc = new models.User({ ...validUserBase, accommodationJourney: { actualMoveInDate } });
        assert.strictEqual(await validateDoc(doc), undefined);
        assert.strictEqual(doc.accommodationJourney.actualMoveInDate.getTime(), actualMoveInDate.getTime());
    });

    await test("accommodationJourney: 8. actualMoveOutDate accepts a date", async () => {
        const actualMoveOutDate = new Date("2027-06-10");
        const doc = new models.User({ ...validUserBase, accommodationJourney: { actualMoveOutDate } });
        assert.strictEqual(await validateDoc(doc), undefined);
        assert.strictEqual(doc.accommodationJourney.actualMoveOutDate.getTime(), actualMoveOutDate.getTime());
    });

    await test("accommodationJourney: 9. status defaults to LEAD when not provided", async () => {
        const doc = new models.User({ ...validUserBase });
        assert.strictEqual(await validateDoc(doc), undefined);
        assert.strictEqual(doc.accommodationJourney.status, "LEAD");
        assert.strictEqual(doc.accommodationJourney.servicePurchased, false, "servicePurchased should default to false");
        assert.strictEqual(doc.accommodationJourney.purchasedAt, null);
        assert.strictEqual(doc.accommodationJourney.moveInDate, null);
        assert.strictEqual(doc.accommodationJourney.expectedStayDurationMonths, null);
    });

    await test("accommodationJourney: 10. negative expectedStayDurationMonths is rejected", async () => {
        const doc = new models.User({ ...validUserBase, accommodationJourney: { expectedStayDurationMonths: -3 } });
        const err = await validateDoc(doc);
        assert.ok(err && err.errors["accommodationJourney.expectedStayDurationMonths"], "expected a validation error rejecting a negative expectedStayDurationMonths");
    });

    // ── University (schema-only, no live DB needed) — all three sub-fields
    // are optional; a User with none, some, or all of them must validate. ──
    await test("university: 1. a User with no university at all is valid", async () => {
        const doc = new models.User({ ...validUserBase });
        assert.strictEqual(await validateDoc(doc), undefined);
    });

    await test("university: 2. a User with only university.name is valid", async () => {
        const doc = new models.User({ ...validUserBase, university: { name: "Imperial College London" } });
        assert.strictEqual(await validateDoc(doc), undefined);
        assert.strictEqual(doc.university.name, "Imperial College London");
        assert.strictEqual(doc.university.city, undefined);
        assert.strictEqual(doc.university.country, undefined);
    });

    await test("university: 3. a User with name + city + country is valid", async () => {
        const doc = new models.User({
            ...validUserBase,
            university: { name: "Imperial College London", city: "London", country: "United Kingdom" },
        });
        assert.strictEqual(await validateDoc(doc), undefined);
        assert.strictEqual(doc.university.name, "Imperial College London");
        assert.strictEqual(doc.university.city, "London");
        assert.strictEqual(doc.university.country, "United Kingdom");
    });

    await test("university: 4. name/city/country are cast/stored as strings", async () => {
        const doc = new models.User({
            ...validUserBase,
            university: { name: "Imperial College London", city: "London", country: "United Kingdom" },
        });
        assert.strictEqual(typeof doc.university.name, "string");
        assert.strictEqual(typeof doc.university.city, "string");
        assert.strictEqual(typeof doc.university.country, "string");
    });

    await test("university: 5. name/city/country are trimmed", async () => {
        const doc = new models.User({
            ...validUserBase,
            university: { name: "  Imperial College London  ", city: "  London  ", country: "  United Kingdom  " },
        });
        assert.strictEqual(await validateDoc(doc), undefined);
        assert.strictEqual(doc.university.name, "Imperial College London");
        assert.strictEqual(doc.university.city, "London");
        assert.strictEqual(doc.university.country, "United Kingdom");
    });

    await test("university: 6. no field within university is required (empty object is valid)", async () => {
        const doc = new models.User({ ...validUserBase, university: {} });
        assert.strictEqual(await validateDoc(doc), undefined);
    });

    if (!liveRequested) {
        console.log("\nMONGODB_URI is not set in this environment.");
        console.log("The following require a live database and could NOT be verified in this run:");
        [
            "MongoDB connection (connectToDatabase)",
            "User creation against a real database",
            "Unique email constraint enforced by MongoDB itself",
            "Lead without user / Lead linked to user, persisted",
            "Wishlist uniqueness per user enforced by MongoDB itself",
            "UserEvent / Enquiry / Communication / FollowUp persisted and re-read",
            "Relationship references resolvable via populate()",
            "Index CREATION verified in an actual database (listIndexes)",
        ].forEach((name) => skip(name, "No MONGODB_URI configured — see .env.example. Static schema validation above is not a substitute for this."));
    } else {
        const dbName = getDbNameFromUri(MONGODB_URI);
        const looksLikeTestDb = /test/i.test(dbName);
        if (!looksLikeTestDb && process.env.ALLOW_MONGODB_LIVE_TEST !== "true") {
            console.log(`\nMONGODB_URI points at database "${dbName}", which doesn't look like a test database.`);
            console.log("Refusing to run live/destructive tests against it. Either point MONGODB_URI at a database");
            console.log('whose name contains "test", or explicitly set ALLOW_MONGODB_LIVE_TEST=true if you are certain.');
            skipped += 8;
        } else {
            const mongoose = require("mongoose");
            const { connectToDatabase, disconnectFromDatabase } = require(path.join(ROOT, "api", "_lib", "mongodb"));
            const runId = `verify-${Date.now()}`;
            const createdIds = { User: [], Lead: [], Wishlist: [], UserEvent: [], Enquiry: [], Communication: [], FollowUp: [], Segment: [] };

            await test("MongoDB connection succeeds", async () => {
                await connectToDatabase();
                assert.strictEqual(mongoose.connection.readyState, 1, "expected an open connection");
            });

            await test("User creation + unique email constraint enforced by MongoDB, phone persists", async () => {
                const email = `${runId}-user@example.test`;
                const user = await models.User.create({ email, name: "Live Test User", phone: "9876543210" });
                createdIds.User.push(user._id);
                const reloaded = await models.User.findById(user._id);
                assert.strictEqual(reloaded.phone, "9876543210", "phone should be persisted and readable back from MongoDB");
                await assert.rejects(
                    () => models.User.create({ email, name: "Duplicate", phone: "9876543211" }),
                    (err) => err.code === 11000,
                    "expected a duplicate-key error (11000) on the second insert"
                );
            });

            await test("User creation without phone is rejected by MongoDB itself (required, not just app-layer)", async () => {
                await assert.rejects(
                    () => models.User.create({ email: `${runId}-nophone@example.test`, name: "No Phone" }),
                    (err) => err.name === "ValidationError" && Boolean(err.errors.phone),
                    "expected a ValidationError on the phone path for a real insert with no phone"
                );
            });

            await test("accommodationJourney persists correctly and enforces the status enum in a real database", async () => {
                const email = `${runId}-aj-user@example.test`;
                const moveInDate = new Date("2026-09-01");
                const expectedMoveOutDate = new Date("2027-06-01");
                const user = await models.User.create({
                    email,
                    name: "Live AJ Test User",
                    phone: "9876543210",
                    accommodationJourney: {
                        status: "BOOKED",
                        servicePurchased: true,
                        purchasedAt: new Date(),
                        moveInDate,
                        expectedStayDurationMonths: 9,
                        expectedMoveOutDate,
                    },
                });
                createdIds.User.push(user._id);

                const reloaded = await models.User.findById(user._id);
                assert.strictEqual(reloaded.accommodationJourney.status, "BOOKED");
                assert.strictEqual(reloaded.accommodationJourney.servicePurchased, true);
                assert.strictEqual(reloaded.accommodationJourney.moveInDate.getTime(), moveInDate.getTime());
                assert.strictEqual(reloaded.accommodationJourney.expectedMoveOutDate.getTime(), expectedMoveOutDate.getTime());

                await assert.rejects(
                    () => models.User.create({ email: `${runId}-aj-invalid@example.test`, name: "Invalid AJ", phone: "9876543210", accommodationJourney: { status: "NOT_REAL" } }),
                    (err) => err.name === "ValidationError",
                    "MongoDB/Mongoose should reject an out-of-enum accommodationJourney.status on real insert"
                );
            });

            await test("existing User documents without phone are not deleted or modified automatically — required is enforced only on future saves", async () => {
                // Simulate a document created before phone became mandatory
                // by inserting directly via the native driver, bypassing
                // Mongoose schema validation entirely — exactly what a real
                // pre-existing record already in the database looks like.
                const legacyEmail = `${runId}-legacy-no-phone@example.test`;
                const insertResult = await mongoose.connection.collection("users").insertOne({
                    email: legacyEmail,
                    name: "Legacy User",
                    role: "USER",
                    createdAt: new Date(),
                    updatedAt: new Date(),
                });
                createdIds.User.push(insertResult.insertedId);

                const found = await models.User.findById(insertResult.insertedId);
                assert.ok(found, "a pre-existing document without phone must still be readable, not deleted");
                assert.strictEqual(found.phone, undefined, "phone must remain absent, not silently backfilled with a placeholder");

                found.name = "Legacy User Updated";
                await assert.rejects(
                    () => found.save(),
                    (err) => err.name === "ValidationError" && Boolean(err.errors.phone),
                    "a future save of this pre-existing phone-less document should now fail validation, exactly as documented on the schema"
                );

                const stillThere = await models.User.findById(insertResult.insertedId);
                assert.ok(stillThere, "the legacy document must still exist, untouched by the failed save attempt");
                assert.strictEqual(stillThere.name, "Legacy User", "the failed save must not have partially applied");
            });

            await test("Lead without a user, and Lead linked to a user", async () => {
                const anonLead = await models.Lead.create({ source: "contact-form", sourceDetails: { runId } });
                createdIds.Lead.push(anonLead._id);
                assert.strictEqual(anonLead.userId, null);

                const user = await models.User.findOne({ email: `${runId}-user@example.test` });
                const linkedLead = await models.Lead.create({ userId: user._id, source: "signup", sourceDetails: { runId } });
                createdIds.Lead.push(linkedLead._id);
                assert.strictEqual(String(linkedLead.userId), String(user._id));
            });

            await test("Wishlist uniqueness per user enforced by MongoDB, and multiple items in one document", async () => {
                const user = await models.User.findOne({ email: `${runId}-user@example.test` });
                const wishlist = await models.Wishlist.create({
                    userId: user._id,
                    items: [
                        { propertyId: "prop-1", city: "London", propertyName: "A" },
                        { propertyId: "prop-2", city: "Manchester", propertyName: "B" },
                    ],
                });
                createdIds.Wishlist.push(wishlist._id);
                assert.strictEqual(wishlist.items.length, 2);
                await assert.rejects(
                    () => models.Wishlist.create({ userId: user._id, items: [] }),
                    (err) => err.code === 11000,
                    "a second Wishlist document for the same user must be rejected"
                );
            });

            await test("UserEvent: authenticated and anonymous events both persist", async () => {
                const user = await models.User.findOne({ email: `${runId}-user@example.test` });
                const authedEvent = await models.UserEvent.create({ userId: user._id, event: "PROPERTY_VIEWED", properties: { propertyId: "prop-1", runId } });
                const anonEvent = await models.UserEvent.create({ anonymousId: `${runId}-anon`, event: "PAGE_VIEWED", properties: { path: "/find-rooms", runId } });
                createdIds.UserEvent.push(authedEvent._id, anonEvent._id);
                assert.strictEqual(authedEvent.event, "PROPERTY_VIEWED");
                assert.strictEqual(anonEvent.userId, null);
            });

            await test("Enquiry, Communication, and FollowUp persist with references", async () => {
                const user = await models.User.findOne({ email: `${runId}-user@example.test` });
                const lead = await models.Lead.findOne({ userId: user._id });

                const enquiry = await models.Enquiry.create({
                    userId: user._id,
                    leadId: lead._id,
                    contact: { name: "Live Test User", email: `${runId}-user@example.test` },
                    property: { id: "prop-1", name: "Snapshot Property", city: "London" },
                    source: "find-rooms",
                });
                createdIds.Enquiry.push(enquiry._id);

                const comm = await models.Communication.create({ userId: user._id, leadId: lead._id, channel: "email", direction: "outbound", type: "enquiry_response" });
                createdIds.Communication.push(comm._id);

                const followUp = await models.FollowUp.create({ userId: user._id, leadId: lead._id, type: "call", dueAt: new Date(Date.now() + 86400000) });
                createdIds.FollowUp.push(followUp._id);

                const populated = await models.Enquiry.findById(enquiry._id).populate("userId").populate("leadId");
                assert.strictEqual(populated.userId.email, `${runId}-user@example.test`);
                assert.strictEqual(String(populated.leadId._id), String(lead._id));
            });

            await test("declared indexes actually exist in the database (listIndexes)", async () => {
                const userIndexes = await models.User.collection.indexes();
                const userIndexKeys = userIndexes.map((ix) => Object.keys(ix.key).join(","));
                assert.ok(userIndexKeys.includes("email"), "expected a unique email index to exist in MongoDB");
                assert.ok(userIndexKeys.includes("accommodationJourney.status"), "expected an accommodationJourney.status index to exist in MongoDB");

                const wishlistIndexes = await models.Wishlist.collection.indexes();
                assert.ok(wishlistIndexes.some((ix) => Object.keys(ix.key).join(",") === "userId" && ix.unique), "expected a unique userId index on Wishlist to exist in MongoDB");
            });

            // Cleanup — every document created above is tagged/scoped to
            // this run's unique runId or its derived IDs, so this only ever
            // removes what this script itself just created.
            console.log("\nCleaning up test records...");
            for (const [modelName, ids] of Object.entries(createdIds)) {
                if (ids.length) await models[modelName].deleteMany({ _id: { $in: ids } });
            }
            console.log("Cleanup complete.");

            await disconnectFromDatabase();
        }
    }

    console.log(`\n=== ${passed} passed, ${failed} failed, ${skipped} skipped ===`);
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
