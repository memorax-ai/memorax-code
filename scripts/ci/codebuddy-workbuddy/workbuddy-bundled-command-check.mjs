#!/usr/bin/env node
import { realpath, stat } from "node:fs/promises";
import { isWorkBuddyBundledCommand } from "../../../packages/ts/memorax-code-adapter-common/src/clients/codebuddy-command.mjs";

try {
  if (process.argv.length !== 3) throw new Error();
  const command = await realpath(process.argv[2]);
  if (!isWorkBuddyBundledCommand(command) || !(await stat(command)).isFile()) throw new Error();
} catch {
  console.error("Expected an existing WorkBuddy desktop bundled command, not the standalone CodeBuddy CLI.");
  process.exitCode = 1;
}
