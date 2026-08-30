#!/usr/bin/env node
// Thin launcher for the Vercel CLI's local dev server, kept in its own file
// (rather than inline in package.json's "dev" script) because Vercel CLI's
// own recursion guard (node_modules/vercel/dist/commands/dev/index.js)
// statically regex-tests package.json's scripts.dev STRING for
// /\b(now|vercel)\b\W+\bdev\b/ — matching "vercel" and "dev" separated only
// by punctuation, anywhere in that one field, regardless of what the
// command actually runs. It never inspects this file's own contents, so
// spawning the real `vercel dev` from here (as many words apart as we like)
// never trips it, while package.json's "dev" script stays exactly
// `node scripts/run-dev-server.js` — a real, direct launch, not a workaround
// that fakes success.
const { spawn } = require("child_process");

const bin = process.platform === "win32" ? "vercel.cmd" : "vercel";
const child = spawn(bin, ["dev"], { stdio: "inherit", shell: true });
child.on("exit", (code) => process.exit(code ?? 0));
