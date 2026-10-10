#!/usr/bin/env node
// A test-only Node preload pauses real installed lifecycle children, not their
// product functions, persistent state or success reports.
import { realpathSync } from "node:fs";

const args = process.argv.slice(2);
try {
  if (process.argv[1] && process.env.MEMORAX_TEST_GATED_ENTRYPOINT
    && realpathSync(process.argv[1]) === realpathSync(process.env.MEMORAX_TEST_GATED_ENTRYPOINT)
    && ["start", "status"].includes(args[0])) {
    const url = new URL(process.env.MEMORAX_TEST_CLAUDE_GATE_URL);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port
      || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("INVALID_GATE");
    const response = await fetch(url, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ pid: process.pid, args }), signal: AbortSignal.timeout(110_000),
    });
    if (!response.ok) throw new Error("GATE_REJECTED");
  }
} catch {
  console.error("SETUP_DEPENDENCY_GATE_FAILED");
  process.exit(1);
}
