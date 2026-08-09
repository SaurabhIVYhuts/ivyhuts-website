// Redis-backed user store for our own authentication system — completely
// separate from Amber. Uses the same Upstash Redis instance as the Amber
// cache (api/_lib/sharedStore.js) but under its own key namespace
// (user:{id}, email:{normalizedEmail}) so it can never collide with or be
// affected by Amber's "amber:*" cache/lock/budget keys.
//
// Passwords are never stored or logged in plaintext — only a bcrypt hash.
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { sharedGet, sharedSet, sharedSetNX, sharedDelete } = require("./sharedStore");

// Cost 10 is bcrypt's common default and keeps hashing well under Vercel's
// serverless cold-start/duration budget; raise via env if a security review
// later calls for it, without a code change.
const BCRYPT_COST = Number(process.env.AUTH_BCRYPT_COST) || 10;

// Fixed dummy hash compared against on login when no user is found, so a
// login attempt for a non-existent email takes roughly the same time as one
// for a real email with a wrong password — avoids leaking account existence
// via response timing. Value itself is irrelevant (never a real password).
const DUMMY_PASSWORD_HASH = bcrypt.hashSync("ivyhuts-timing-safety-dummy", BCRYPT_COST);

class EmailAlreadyExistsError extends Error {
    constructor() {
        super("An account with this email already exists");
        this.name = "EmailAlreadyExistsError";
    }
}

function normalizeEmail(email) {
    return String(email || "").trim().toLowerCase();
}

function userKey(userId) {
    return `user:${userId}`;
}

function emailKey(normalizedEmail) {
    return `email:${normalizedEmail}`;
}

async function hashPassword(password) {
    return bcrypt.hash(password, BCRYPT_COST);
}

async function verifyPassword(password, passwordHash) {
    return bcrypt.compare(password, passwordHash);
}

// Creates a user with an atomically-enforced unique email: the email key is
// reserved via sharedSetNX (Redis SET NX) BEFORE the user record is written,
// so two simultaneous signups for the same address can never both succeed —
// only the first SET NX wins; the second sees the key already exists and
// throws EmailAlreadyExistsError without ever writing a user record.
async function createUser({ name, email, password, phone }) {
    const normalizedEmail = normalizeEmail(email);
    const userId = crypto.randomUUID();

    const reserved = await sharedSetNX(emailKey(normalizedEmail), userId);
    if (!reserved) {
        throw new EmailAlreadyExistsError();
    }

    const passwordHash = await hashPassword(password);
    const user = {
        id: userId,
        email: normalizedEmail,
        passwordHash,
        name,
        phone: phone || null,
        createdAt: Date.now(),
        lastLogin: null,
    };

    try {
        await sharedSet(userKey(userId), user);
    } catch (err) {
        // Roll back the email reservation best-effort so a failed write
        // doesn't permanently lock this address out of signing up again. If
        // the rollback itself fails, the reservation is orphaned (rare) —
        // logged for manual cleanup rather than silently swallowed.
        await sharedDelete(emailKey(normalizedEmail)).catch(() => {
            console.error(`[userStore] Failed to roll back orphaned email reservation for a failed signup (userId=${userId})`);
        });
        throw err;
    }

    return user;
}

async function findUserByEmail(email) {
    const normalizedEmail = normalizeEmail(email);
    const userId = await sharedGet(emailKey(normalizedEmail));
    if (!userId) return null;
    return sharedGet(userKey(userId));
}

async function findUserById(userId) {
    if (!userId) return null;
    return sharedGet(userKey(userId));
}

async function updateLastLogin(userId) {
    const user = await findUserById(userId);
    if (!user) return null;
    user.lastLogin = Date.now();
    await sharedSet(userKey(userId), user);
    return user;
}

// Strips passwordHash (and anything else internal) before a user record is
// ever allowed near an HTTP response.
function toSafeUser(user) {
    if (!user) return null;
    return { id: user.id, name: user.name, email: user.email, phone: user.phone };
}

module.exports = {
    normalizeEmail,
    createUser,
    findUserByEmail,
    findUserById,
    updateLastLogin,
    hashPassword,
    verifyPassword,
    toSafeUser,
    EmailAlreadyExistsError,
    DUMMY_PASSWORD_HASH,
};
