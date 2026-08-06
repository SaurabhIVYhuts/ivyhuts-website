#!/usr/bin/env node
// `npm start` orchestrator: runs the CRA dev server and the local Amber
// gateway server together (see scripts/local-api-server.js), so plain
// `npm start` works fully — including live Amber data — without needing
// `vercel dev` or a Vercel account for local development.
const { spawn } = require("child_process");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const children = [];

function run(command, args, name) {
    // Single concatenated command string (not `shell:true` + args array) —
    // avoids Node's shell-argument-escaping deprecation warning. Safe here:
    // every argument is a fixed literal from this file, never user input.
    const child = spawn([command, ...args].join(" "), { stdio: "inherit", shell: true, cwd: ROOT });
    children.push(child);
    child.on("exit", (code) => {
        if (code && code !== 0) console.error(`[${name}] exited with code ${code}`);
        shutdown();
    });
    return child;
}

function shutdown() {
    children.forEach((c) => { if (!c.killed) c.kill(); });
    process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

run("node", ["scripts/local-api-server.js"], "api");
run("npx", ["react-scripts", "start"], "cra");