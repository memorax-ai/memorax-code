#!/usr/bin/env node
import {
  disableCodeBuddyAdapter,
  enableCodeBuddyAdapter,
  readCodeBuddyAdapterStatus,
  removeCodeBuddyPluginInstallation,
} from "./config.mjs";

try {
  const parsed = parseCli(process.argv);
  if (parsed.help) {
    console.log("Usage: memorax-code-codebuddy [status|enable|disable|remove] [--client codebuddy|workbuddy] [--codebuddy-home DIR|--workbuddy-home DIR] [--json]");
    process.exit(0);
  }
  const options = { client: parsed.client, codeBuddyHome: parsed.home, workBuddyHome: parsed.workBuddyHome };
  const result = parsed.command === "status"
    ? await readCodeBuddyAdapterStatus(options)
    : parsed.command === "enable"
      ? await enableCodeBuddyAdapter(options)
      : parsed.command === "disable"
        ? await disableCodeBuddyAdapter(options)
        : parsed.command === "remove"
          ? await removeCodeBuddyPluginInstallation(options)
          : undefined;
  if (!result) throw new Error(`unknown command: ${parsed.command}`);
  if (parsed.json) console.log(JSON.stringify(result, null, 2));
  else console.log(`${result.action}: ${result.ok ? "ok" : "failed"}\nhome: ${result.codeBuddyHome ?? parsed.home}`);
  const ready = result.ok === true
    && result.installed === true
    && result.enabled === true
    && result.marketplaceReady === true
    && result.codebuddyHooks?.ok === true
    && result.codebuddySkills?.ok === true;
  process.exit(parsed.command === "status" ? (ready ? 0 : 1) : (result.ok ? 0 : 1));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

function parseCli(argv) {
  const args = argv.slice(2);
  const command = args[0] && !args[0].startsWith("-") ? args.shift() : "status";
  let home;
  let workBuddyHome;
  let client = "codebuddy";
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help") return { command, help: true };
    if (arg === "--json") { json = true; continue; }
    if (arg === "--client") {
      client = args[++index];
      if (client !== "codebuddy" && client !== "workbuddy") throw new Error("--client requires codebuddy or workbuddy");
      continue;
    }
    if (arg === "--codebuddy-home" || arg === "--workbuddy-home") {
      if (arg === "--workbuddy-home") client = "workbuddy";
      home = args[++index];
      if (!home || home.startsWith("--")) throw new Error(`${arg} requires a value`);
      if (arg === "--workbuddy-home") workBuddyHome = home;
      continue;
    }
    throw new Error(`unknown option: ${arg}`);
  }
  return { command, home, workBuddyHome, client, json, help: false };
}
