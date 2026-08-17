#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runBackendEntrypoint } from "../lib/run-entrypoint.mjs";

const args = process.argv.slice(2);

if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
  console.log(`Usage: memorax-cli [status|search|add|tui] [options]

Memory commands:
  status [--json] [--config-only]
  search --query TEXT [--session-id ID] [--limit N] [--json]
  add --memory TEXT --type TYPE --reason REASON [--session-id ID] [--content-type code]
  tui

Run the command from the active task workspace so MemoraX Code can enforce its repository scope.`);
  process.exit(0);
}

if (args.length === 1 && (args[0] === "--version" || args[0] === "-v")) {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(readFileSync(join(scriptDir, "..", "package.json"), "utf8"));
  console.log(`memorax-cli ${pkg.version}`);
  process.exit(0);
}

await runBackendEntrypoint("memorax-cli.js");
