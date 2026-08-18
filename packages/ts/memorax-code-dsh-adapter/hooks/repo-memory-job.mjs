#!/usr/bin/env node
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runRepoMemoryJob } from "../memorax-code-adapter-common/src/repo-memory/repo-memory-job-supervisor.mjs";
import { evaluateRepository } from "../memorax-code-adapter-common/src/repo-memory/repo-memory-update-policy-evaluator.mjs";
import { requireEnabledDshRuntime } from "../src/runtime-state.mjs";

const ADAPTER_PACKAGE_NAME = "@memorax-code/dsh-memorax-code";
const HEADLESS_BUNDLE_NAME = "@deepseek-ai/dsh-headless";
const hookDir = dirname(fileURLToPath(import.meta.url));
const pluginRoot = dirname(hookDir);

try {
  const runtime = requireEnabledDshRuntime(pluginRoot);
  process.env.MEMORAX_CODE_HOME = runtime.memoraxCodeHome;
  const profile = selectHeadlessProfile(runtime.dshHome, runtime.profiles);
  if (!profile) throw new Error("no existing DSH headless-capable profile is available");
  const payload = runRepoMemoryJob(process.argv.slice(2), {
    runner: "dsh",
    finalMessageSource: "stdout",
    memorySkillInvocation: "/memorax-code",
    validatorPath: resolve(pluginRoot, "skills/memorax-code/scripts/validate_memory.py"),
    evaluateRepository,
    createCommand({ prompt }) {
      return [runtime.dshCommand, "--profile", profile, prompt];
    },
  });
  process.stdout.write(`${JSON.stringify(payload)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

function selectHeadlessProfile(dshHome, managedProfiles) {
  const profilesRoot = join(dshHome, "profiles");
  const managedNames = new Set(managedProfiles);
  let entries;
  try {
    entries = readdirSync(profilesRoot, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries
    .filter((candidate) => candidate.isDirectory()
      && managedNames.has(candidate.name)
      && validProfileName(candidate.name))
    .sort((left, right) => left.name.localeCompare(right.name))) {
    try {
      const manifest = JSON.parse(readFileSync(join(profilesRoot, entry.name, "package.json"), "utf8"));
      const bundles = manifest?.dsh?.profile?.bundles;
      if (Array.isArray(bundles)
        && bundles.includes(HEADLESS_BUNDLE_NAME)
        && bundles.includes(ADAPTER_PACKAGE_NAME)
        && Object.hasOwn(manifest.dependencies || {}, ADAPTER_PACKAGE_NAME)) {
        return entry.name;
      }
    } catch {
      // Ignore invalid or concurrently replaced Profiles.
    }
  }
  return undefined;
}

function validProfileName(value) {
  return value && value !== "." && value !== ".." && value !== "node_modules"
    && !value.includes("/") && !value.includes("\\");
}
