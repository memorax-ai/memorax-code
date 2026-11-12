#!/usr/bin/env node
import { defaultQoderHome } from "./adapter-paths.mjs";
import {
  disableQoderAdapter,
  enableQoderAdapter,
  readQoderAdapterStatus,
  removeQoderAdapter,
} from "./config.mjs";

try {
  const args = process.argv.slice(2);
  const command = args[0] && !args[0].startsWith("-") ? args.shift() : "status";
  let qoderHome = defaultQoderHome();
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--help") {
      console.log("Usage: memorax-code-qoder [status|enable|disable|remove] [--qoder-home DIR] [--json]");
      process.exit(0);
    }
    if (args[index] === "--json") { json = true; continue; }
    if (args[index] === "--qoder-home") {
      qoderHome = args[++index];
      if (!qoderHome || qoderHome.startsWith("--")) throw new Error("--qoder-home requires a value");
      continue;
    }
    throw new Error(`unknown option: ${args[index]}`);
  }
  const operation = {
    status: readQoderAdapterStatus,
    enable: enableQoderAdapter,
    disable: disableQoderAdapter,
    remove: removeQoderAdapter,
  }[command];
  if (!operation) throw new Error(`unknown command: ${command}`);
  const result = await operation({ qoderHome });
  if (json) console.log(JSON.stringify(result, null, 2));
  else console.log(`${result.action}: ${result.ok ? "ok" : "failed"}\nhome: ${result.qoderHome ?? qoderHome}`);
  const ready = result.ok && result.installed && result.enabled && result.qoderHooks?.ok && result.qoderSkills?.ok;
  process.exit(command === "status" ? (ready ? 0 : 1) : (result.ok ? 0 : 1));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
