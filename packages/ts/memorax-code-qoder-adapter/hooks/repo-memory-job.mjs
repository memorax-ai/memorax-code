#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { holdQoderRepoMemoryLease, runQoderRepoMemoryJob } from "../src/native-repo-memory.mjs";

const helperPath = fileURLToPath(import.meta.url);
const runtimeRoot = dirname(dirname(helperPath));

try {
  if (process.argv[2] === "lease-guard") {
    await holdQoderRepoMemoryLease(process.argv.slice(3));
  } else {
    const payload = runQoderRepoMemoryJob(process.argv.slice(2), installedOptions());
    process.stdout.write(JSON.stringify(payload) + "\n");
    if (payload.ok === false) process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
  process.exitCode = 1;
}

function installedOptions() {
  const metadataPath = join(runtimeRoot, ".memorax-code-package.json");
  // The source-tree helper remains directly testable; deployed generations
  // always carry both the common runtime and their private installation record.
  if (!existsSync(metadataPath) && !existsSync(join(runtimeRoot, "memorax-code-adapter-common"))) return {};
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  const home = metadata.memoraxCodeHome, qoderHome = metadata.qoderHome;
  if (metadata.version !== 1 || !absolutePath(home) || !absolutePath(qoderHome) || !/^[a-f0-9]{64}$/.test(metadata.runtimeDigest)) throw new Error("Qoder Repo Memory installation is invalid");
  return {
    memoraxCodeHome: home,
    validatorPath: join(qoderHome, "skills", "memorax-code", "scripts", "repo-memory.mjs"),
    assertEnabled() {
      const state = JSON.parse(readFileSync(join(home, "adapters", "qoder", "state.json"), "utf8"));
      const generation = join(home, "adapters", "qoder", "runtime", "generations", metadata.runtimeDigest);
      if (state.version !== 1 || state.runtime !== "qoder" || state.integration !== "hooks"
        || state.enabled !== true || state.installPending === true || state.qoderHome !== qoderHome
        || state.runtimeDigest !== metadata.runtimeDigest || state.runtimePath !== join(generation, "hooks", "runtime-hook.mjs")
        || realpathSync(join(generation, "hooks", "repo-memory-job.mjs")) !== helperPath) throw new Error("Qoder Repo Memory helper is disabled or superseded");
      if (!/^[a-f0-9]{64}$/.test(state.agentDigest)
        || digest(join(qoderHome, "agents", "memorax-repo-memory.md")) !== state.agentDigest
        || digest(join(generation, "agents", "memorax-repo-memory.md")) !== state.agentDigest) throw new Error("Qoder Repo Memory agent is unavailable or changed");
    },
  };
}

function absolutePath(value) { return typeof value === "string" && isAbsolute(value) && !value.includes("\0"); }
function digest(path) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
