#!/usr/bin/env node

console.log = console.error;
console.info = console.error;
console.warn = console.error;
console.debug = console.error;

// Ensure initial logs are sent to help verify logging is working
console.error("[opencode-acp] Starting opencode-acp v0.1.0");
console.error("[opencode-acp] Debug logging enabled");

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

import { runAcp } from "./acp-agent.js";

runAcp();

process.stdin.resume();