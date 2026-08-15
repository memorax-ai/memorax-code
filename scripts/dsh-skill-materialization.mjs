const DEFINITION_VERSION = 1;

export function materializeDshSkillDefinition(source) {
  const { frontmatter, content } = splitSkill(source);
  const fields = parseCanonicalFrontmatter(frontmatter);
  const name = scalar(fields, "name");
  const description = scalar(fields, "description");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new Error("canonical memorax-code skill has an invalid name");
  }
  if (!description) throw new Error("canonical memorax-code skill has no description");
  if (!content.trim()) throw new Error("canonical memorax-code skill has no body");

  const definition = {
    version: DEFINITION_VERSION,
    name,
    description,
    invocation: {
      modelInvocable: !booleanField(fields, "disable-model-invocation", false),
      userInvocable: booleanField(fields, "user-invocable", true),
    },
    source: "bundled",
    content,
  };
  if (fields.has("whenToUse")) definition.whenToUse = scalar(fields, "whenToUse");
  assertDshSkillDefinition(definition, source);
  return definition;
}

export function assertDshSkillDefinition(definition, canonicalSource) {
  if (!definition || definition.version !== DEFINITION_VERSION) {
    throw new Error("staged DSH skill definition has an unsupported version");
  }
  if (definition.name !== "memorax-code"
    || typeof definition.description !== "string"
    || !definition.description.trim()
    || definition.source !== "bundled"
    || definition.invocation?.modelInvocable !== true
    || definition.invocation?.userInvocable !== true
    || typeof definition.content !== "string") {
    throw new Error("staged DSH skill definition is invalid");
  }
  if (canonicalSource !== undefined && definition.content !== splitSkill(canonicalSource).content) {
    throw new Error("staged DSH skill body diverges from the canonical skill");
  }
}

export function dshRepoMemoryJobSource() {
  return `#!/usr/bin/env node
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runRepoMemoryJob } from "../memorax-code-adapter-common/src/repo-memory/repo-memory-job-supervisor.mjs";
import { evaluateRepository } from "../memorax-code-adapter-common/src/repo-memory/repo-memory-update-policy-evaluator.mjs";

const ADAPTER_PACKAGE_NAME = "@memorax-code/dsh-adapter";
const HEADLESS_BUNDLE_NAME = "@deepseek-ai/dsh-headless";
const hookDir = dirname(fileURLToPath(import.meta.url));
const pluginRoot = dirname(hookDir);

try {
  const metadata = readMetadata(pluginRoot);
  const state = assertEnabled(metadata);
  const profile = selectHeadlessProfile(metadata.dshHome, state.profiles);
  if (!profile) throw new Error("no existing DSH headless-capable profile is available");
  const payload = runRepoMemoryJob(process.argv.slice(2), {
    runner: "dsh",
    finalMessageSource: "stdout",
    memorySkillInvocation: "/memorax-code",
    validatorPath: resolve(pluginRoot, "skills/memorax-code/scripts/validate_memory.py"),
    evaluateRepository,
    createCommand({ prompt }) {
      return [metadata.dshCommand || "dsh", "--profile", profile, prompt];
    },
  });
  process.stdout.write(\`\${JSON.stringify(payload)}\\n\`);
} catch (error) {
  process.stderr.write(\`\${error instanceof Error ? error.message : String(error)}\\n\`);
  process.exit(1);
}

function readMetadata(root) {
  const path = join(root, ".memorax-code-package.json");
  const metadata = JSON.parse(readFileSync(path, "utf8"));
  if (metadata?.version !== 1
    || typeof metadata.memoraxCodeCommand !== "string"
    || typeof metadata.memoraxCodeHome !== "string"
    || typeof metadata.dshHome !== "string"
    || typeof metadata.dshCommand !== "string"
    || typeof metadata.sourceAdapterRoot !== "string") {
    throw new Error("invalid MemoraX Code DSH package metadata");
  }
  return {
    ...metadata,
    memoraxCodeHome: resolve(metadata.memoraxCodeHome),
    dshHome: resolve(metadata.dshHome),
    sourceAdapterRoot: resolve(metadata.sourceAdapterRoot),
  };
}

function assertEnabled(metadata) {
  const statePath = join(metadata.memoraxCodeHome, "adapters", "dsh", "state.json");
  let state;
  try {
    state = JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    throw new Error("MemoraX Code DSH integration is not enabled");
  }
  if (state?.version !== 1
    || state.runtime !== "dsh"
    || state.integration !== "plugin"
    || state.enabled !== true
    || resolve(state.memoraxCodeHome || "") !== metadata.memoraxCodeHome
    || resolve(state.dshHome || "") !== metadata.dshHome) {
    throw new Error("MemoraX Code DSH integration is not enabled");
  }
  if (resolve(state.adapterRoot || "") !== metadata.sourceAdapterRoot
    || state.memoraxCodeCommand !== metadata.memoraxCodeCommand
    || state.dshCommand !== metadata.dshCommand
    || typeof state.updatedAt !== "string"
    || !Number.isFinite(Date.parse(state.updatedAt))
    || !Array.isArray(state.profiles)
    || !state.profiles.every(validProfileName)) {
    throw new Error("MemoraX Code DSH integration is not enabled");
  }
  return state;
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
      // Ignore invalid or concurrently replaced profiles.
    }
  }
  return undefined;
}

function validProfileName(value) {
  return value && value !== "." && value !== ".." && value !== "node_modules"
    && !value.includes("/") && !value.includes("\\\\");
}
`;
}

function splitSkill(source) {
  const normalized = String(source).replaceAll("\r\n", "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) throw new Error("canonical memorax-code skill has invalid frontmatter");
  return { frontmatter: match[1], content: match[2] };
}

function parseCanonicalFrontmatter(source) {
  const fields = new Map();
  const lines = source.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^([A-Za-z][A-Za-z0-9-]*):(?:\s*(.*))?$/.exec(lines[index]);
    if (!match) throw new Error(`unsupported canonical skill frontmatter line: ${lines[index]}`);
    const [, key, rawValue = ""] = match;
    if (fields.has(key)) throw new Error(`duplicate canonical skill frontmatter field: ${key}`);
    if (rawValue === ">-" || rawValue === ">") {
      const folded = [];
      while (index + 1 < lines.length && /^\s+/.test(lines[index + 1])) {
        folded.push(lines[++index].trim());
      }
      fields.set(key, folded.join(" "));
    } else {
      fields.set(key, unquote(rawValue.trim()));
    }
  }
  for (const key of fields.keys()) {
    if (!["name", "description", "whenToUse", "disable-model-invocation", "user-invocable"].includes(key)) {
      throw new Error(`unsupported canonical skill frontmatter field: ${key}`);
    }
  }
  return fields;
}

function scalar(fields, key) {
  const value = fields.get(key);
  if (typeof value !== "string") throw new Error(`canonical skill frontmatter is missing ${key}`);
  return value.trim();
}

function booleanField(fields, key, fallback) {
  if (!fields.has(key)) return fallback;
  const value = scalar(fields, key).toLowerCase();
  if (["true", "yes", "on", "1"].includes(value)) return true;
  if (["false", "no", "off", "0"].includes(value)) return false;
  throw new Error(`canonical skill frontmatter field ${key} must be boolean`);
}

function unquote(value) {
  if ((value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}
