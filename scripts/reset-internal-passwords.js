#!/usr/bin/env node
// Gives every internal-role account (MARKETING_AGENT, MARKETING_MANAGER,
// ADMIN) a fresh random password in the shared store.
//
// Written for the move off Upstash Redis: login credentials (bcrypt hashes)
// lived only in Redis, which became unreachable, while the accounts
// themselves (name/email/phone/role) were already in MongoDB. This
// recreates the credentials from the MongoDB records instead.
//
// Passwords are written ONLY to the --out file, never printed. Send each
// person theirs, then delete the file.
//
// Usage:
//   node scripts/reset-internal-passwords.js --out /path/outside/repo/passwords.csv
//   node scripts/reset-internal-passwords.js --out ... --email someone@ivyhuts.com   (one account)
//
// Env: reads .env.local then .env (same as scripts/create-internal-user.js).

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
require("dotenv").config({ path: path.join(__dirname, "..", ".env.local"), quiet: true });
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const INTERNAL_ROLES = ["MARKETING_AGENT", "MARKETING_MANAGER", "ADMIN"];

function argValue(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

// 16 chars from an unambiguous alphabet (no 0/O, 1/l/I) — easy to read out.
function generatePassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  return Array.from(crypto.randomBytes(16), (b) => alphabet[b % alphabet.length]).join("");
}

async function main() {
  const out = argValue("out");
  const onlyEmail = (argValue("email") || "").trim().toLowerCase();
  if (!out) {
    console.error("Missing --out <file>. Example:\n  node scripts/reset-internal-passwords.js --out ../passwords.csv");
    process.exit(1);
  }
  if (path.resolve(out).startsWith(path.resolve(__dirname, "..") + path.sep)) {
    console.error("--out must be outside the repo so the passwords can't be committed by accident.");
    process.exit(1);
  }

  const { createUser, findUserByEmail, updatePassword } = require("../api/_lib/userStore.js");
  const { connectToDatabase, disconnectFromDatabase } = require("../api/_lib/mongodb.js");
  const User = require("../api/_lib/models/User.js");

  await connectToDatabase();
  const filter = { role: { $in: INTERNAL_ROLES } };
  if (onlyEmail) filter.email = onlyEmail;
  const users = await User.find(filter).select("email name phone role").lean();
  if (!users.length) {
    console.error(onlyEmail ? `No internal-role user with email ${onlyEmail}.` : "No internal-role users found.");
    process.exit(1);
  }

  const rows = ["email,name,role,password"];
  for (const u of users) {
    const password = generatePassword();
    const existing = await findUserByEmail(u.email);
    if (existing) {
      await updatePassword(existing.id, password);
      console.log(`[reset]   ${u.email} (${u.role})`);
    } else {
      await createUser({ name: u.name, email: u.email, password, phone: u.phone || null });
      console.log(`[created] ${u.email} (${u.role})`);
    }
    rows.push([u.email, `"${String(u.name).replace(/"/g, '""')}"`, u.role, password].join(","));
  }

  fs.writeFileSync(out, rows.join("\n") + "\n", { mode: 0o600 });
  await disconnectFromDatabase();
  console.log(`\nDone: ${users.length} account(s). Passwords written to ${path.resolve(out)}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
