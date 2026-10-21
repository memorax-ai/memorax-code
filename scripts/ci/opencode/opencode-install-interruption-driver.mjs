#!/usr/bin/env node
// Pause admission to real installed CLI children without replacing product code.
import { realpathSync } from "node:fs";

const args = process.argv.slice(2);
if (process.argv[1] && process.env.MEMORAX_TEST_GATED_ENTRYPOINT
  && realpathSync(process.argv[1]) === realpathSync(process.env.MEMORAX_TEST_GATED_ENTRYPOINT)
  && ["start", "status"].includes(args[0])) {
  try {
    const response = await fetch(process.env.MEMORAX_TEST_OPENCODE_GATE_URL, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ pid: process.pid, args }),
      signal: AbortSignal.timeout(110_000),
    });
    if (!response.ok) throw new Error("OPENCODE_DEPENDENCY_GATE_REJECTED");
  } catch {
    console.error("SETUP_DEPENDENCY_GATE_FAILED");
    process.exit(1);
  }
}
