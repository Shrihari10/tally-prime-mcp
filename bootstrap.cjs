#!/usr/bin/env node
// CommonJS bootstrap — runnable on ANY version of Node.
// Checks the Node version BEFORE attempting to load the ESM server, so users
// on ancient Node (which can't even parse `import`) get a useful message
// instead of a cryptic SyntaxError.
"use strict";

var path = require("path");

var versionParts = process.versions.node.split(".").map(function (n) {
  return parseInt(n, 10);
});

if (versionParts[0] < 18) {
  process.stderr.write(
    "\n" +
    "============================================================\n" +
    " tally-prime-mcp: Node.js " + process.versions.node + " is too old.\n" +
    "============================================================\n" +
    "\n" +
    "This MCP server requires Node.js 18 or newer.\n" +
    "Your current Node is at: " + process.execPath + "\n" +
    "\n" +
    "Fix on Windows:\n" +
    "  1. Download the latest LTS from https://nodejs.org/\n" +
    "  2. Install it (use the 64-bit MSI).\n" +
    "  3. Open a NEW terminal and confirm: node --version\n" +
    "     It should print v20.x.x or v22.x.x — NOT v8/v10/v12.\n" +
    "  4. Edit claude_desktop_config.json so the 'command' field points\n" +
    "     to the new node.exe — usually:\n" +
    "       C:\\\\Program Files\\\\nodejs\\\\node.exe\n" +
    "     (NOT the old C:\\\\Program Files (x86)\\\\nodejs\\\\node.exe).\n" +
    "  5. Restart Claude Desktop.\n" +
    "\n"
  );
  process.exit(1);
}

// Node ≥ 18 — load the ESM server via dynamic import.
import(path.join(__dirname, "dist", "index.js")).catch(function (err) {
  process.stderr.write(
    "[tally-prime-mcp] failed to start: " + (err && err.message ? err.message : err) + "\n"
  );
  if (err && err.stack) process.stderr.write(err.stack + "\n");
  process.exit(1);
});
