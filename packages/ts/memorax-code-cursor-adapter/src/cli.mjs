#!/usr/bin/env node
import {
  defaultCursorHome,
} from "./adapter-paths.mjs";
import {
  disableCursorAdapter,
  enableCursorAdapter,
  readCursorAdapterStatus,
  removeCursorAdapterInstallation,
} from "./config.mjs";

try {
  const parsed = parseCli(process.argv);
  if (parsed.help) {
    console.log("Usage: memorax-code-cursor [status|enable|disable|remove] [--cursor-home DIR] [--json]");
    process.exit(0);
  }
  const options = { cursorHome: parsed.home };
  const result = parsed.command === "status"
    ? await readCursorAdapterStatus(options)
    : parsed.command === "enable"
      ? await enableCursorAdapter(options)
      : parsed.command === "disable"
        ? await disableCursorAdapter(options)
        : parsed.command === "remove"
          ? await removeCursorAdapterInstallation(options)
          : undefined;
  if (!result) throw new Error(`unknown command: ${parsed.command}`);
  const ready = result.ok === true
    && result.installed === true
    && result.enabled === true
    && result.cursorHooks?.ok === true
    && result.cursorSkills?.ok === true
    && result.cursorAgents?.ok === true;
  const ok = parsed.command === "status" ? ready : result.ok === true;
  if (parsed.json) console.log(JSON.stringify(result, null, 2));
  else console.log(`${result.action}: ${ok ? "ok" : "failed"}\nhome: ${result.cursorHome ?? parsed.home ?? defaultCursorHome()}`);
  process.exit(ok ? 0 : 1);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

function parseCli(argv) {
  const args = argv.slice(2);
  const command = args[0] && !args[0].startsWith("-") ? args.shift() : "status";
  let home;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help") return { command, help: true };
    if (arg === "--json") { json = true; continue; }
    if (arg === "--cursor-home") {
      home = args[++index];
      if (!home || home.startsWith("--")) throw new Error("--cursor-home requires a value");
      continue;
    }
    throw new Error(`unknown option: ${arg}`);
  }
  return { command, home, json, help: false };
}
