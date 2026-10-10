#!/usr/bin/env node
// Test-only Node preload. It pauses admission to a real installed CLI child;
// it does not replace product functions or synthesize a lifecycle result.
import { realpathSync } from "node:fs";

const args = process.argv.slice(2);
if (process.argv[1] && process.env.MEMORAX_TEST_GATED_ENTRYPOINT
  && realpathSync(process.argv[1]) === realpathSync(process.env.MEMORAX_TEST_GATED_ENTRYPOINT)
  && ((args[0] === "codex-plugin" && args[1] === "install") || args[0] === "status")) {
  try {
    const response = await fetch(process.env.MEMORAX_TEST_CODEX_GATE_URL, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ pid: process.pid, args }),
      signal: AbortSignal.timeout(110_000),
    });
    if (!response.ok) throw new Error("CODEX_DEPENDENCY_GATE_REJECTED");
  } catch {
    console.error("SETUP_DEPENDENCY_GATE_FAILED");
    process.exit(1);
  }
}
