import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const [command, repo, format] = process.argv.slice(2);
if (command !== "validate" || !repo || (format && format !== "--pretty")) {
  throw new Error("fixture validator expects validate REPO [--pretty]");
}

// Only model the validator protocol; canonical bundle rules have Skill integration tests.
const profile = join(repo, ".repo_memory", "PROFILE.md");
const ok = existsSync(profile) && /^fixture_valid: true$/m.test(readFileSync(profile, "utf8"));
process.stdout.write(`${JSON.stringify({ ok })}\n`);
process.exitCode = ok ? 0 : 1;
