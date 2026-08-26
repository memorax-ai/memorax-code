#!/usr/bin/env node
import { runMemoryCli } from "./memory/cli.js";

runMemoryCli(process.argv.slice(2)).then((result) => {
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
