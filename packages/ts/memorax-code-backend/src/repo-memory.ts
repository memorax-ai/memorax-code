#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { runRepoMemoryCli } from "./repo-memory/cli.js";

const skillDir = fileURLToPath(new URL(
  "../../memorax-code-codex-adapter/skills/memorax-code/",
  import.meta.url,
));
const offset = process.argv[2] === "repo-memory" ? 3 : 2;
process.exitCode = await runRepoMemoryCli(process.argv.slice(offset), { skillDir });
