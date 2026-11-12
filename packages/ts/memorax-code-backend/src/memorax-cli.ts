#!/usr/bin/env node
import { runMemoryCli } from "./memory/cli.js";

runMemoryCli(process.argv.slice(2)).then((result) => {
  if (!process.argv.includes("--json") && !result.ok && result.diagnostic) {
    console.error(`[${result.errorCode}] ${result.action} failed (${result.stage}).`);
    console.error(`${result.error}${result.systemCode ? ` (${result.systemCode})` : ""}`);
    if (result.httpStatus !== undefined) console.error(`HTTP status: ${result.httpStatus}`);
    if (result.retryAfterMs !== undefined) console.error(`Retry after: ${result.retryAfterMs} ms`);
    console.error(`Impact: ${result.impact}`);
    console.error(`Next step: ${result.userAction}`);
    console.error(`Diagnostic: ${result.diagnostic.id}`);
    console.error(result.diagnostic.recorded
      ? `Diagnostic file: ${result.diagnostic.path}`
      : `Diagnostic could not be saved (${result.diagnostic.recordingError}); keep this error output.`);
    process.exitCode = 1;
    return;
  }
  if (!process.argv.includes("--json") && result.ok && result.quotaNotice) {
    console.warn(result.quotaNotice);
  }
  if (!process.argv.includes("--json") && result.ok && result.action === "memory.search") {
    if (result.userNotice) console.warn(`Warning: ${result.userNotice}`);
    console.log(result.answer?.trim() || "No memory context returned.");
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
  process.exit(result.ok ? 0 : 1);
}).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
