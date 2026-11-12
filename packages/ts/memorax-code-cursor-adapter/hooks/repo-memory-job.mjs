#!/usr/bin/env node
import { holdCursorRepoMemoryLease, runCursorRepoMemoryJob } from "../src/native-repo-memory.mjs";

try {
  if (process.argv[2] === "lease-guard") {
    await holdCursorRepoMemoryLease(process.argv.slice(3));
  } else {
    const payload = runCursorRepoMemoryJob(process.argv.slice(2));
    process.stdout.write(JSON.stringify(payload) + "\n");
    if (payload.ok === false) process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
  process.exitCode = 1;
}
