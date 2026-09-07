#!/usr/bin/env node
import {
  defaultTraeHome,
} from "./adapter-paths.mjs";
import {
  disableTraeAdapter,
  enableTraeAdapter,
  readTraeAdapterStatus,
  removeTraeAdapterInstallation,
} from "./config.mjs";

try {
  const parsed = parseCli(process.argv);
  if (parsed.help) {
    console.log("Usage: memorax-code-trae [status|enable|disable|remove] [--trae-home DIR] [--json]");
    process.exit(0);
  }
  const options = { traeHome: parsed.home };
  const result = parsed.command === "status"
    ? await readTraeAdapterStatus(options)
    : parsed.command === "enable"
      ? await enableTraeAdapter(options)
      : parsed.command === "disable"
        ? await disableTraeAdapter(options)
        : parsed.command === "remove"
          ? await removeTraeAdapterInstallation(options)
          : undefined;
  if (!result) throw new Error(`unknown command: ${parsed.command}`);
  if (parsed.json) console.log(JSON.stringify(result, null, 2));
  else console.log(`${result.action}: ${result.ok ? "ok" : "failed"}\nhome: ${result.traeHome ?? parsed.home}`);
  const ready = result.ok === true
    && result.installed === true
    && result.enabled === true
    && result.traeHooks?.ok === true
    && result.traeSkills?.ok === true;
  process.exit(parsed.command === "status" ? (ready ? 0 : 1) : (result.ok ? 0 : 1));
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
    if (arg === "--trae-home") {
      home = args[++index];
      if (!home || home.startsWith("--")) throw new Error("--trae-home requires a value");
      continue;
    }
    throw new Error(`unknown option: ${arg}`);
  }
  return { command, home: home ?? defaultTraeHome(), json, help: false };
}
