#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { lstat, readFile, readdir, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const productionRoots = [
  "packages/npm/memorax-code/bin/",
  "packages/npm/memorax-code/lib/",
  "packages/ts/memorax-code-adapter-common/src/",
  "packages/ts/memorax-code-backend/src/",
  "packages/ts/memorax-code-codex-adapter/hooks/",
  "packages/ts/memorax-code-codex-adapter/runtime-hooks/",
  "packages/ts/memorax-code-codex-adapter/skills/memorax-code/scripts/",
  "packages/ts/memorax-code-codex-adapter/src/",
  "packages/ts/memorax-code-claude-adapter/hooks/",
  "packages/ts/memorax-code-claude-adapter/runtime-hooks/",
  "packages/ts/memorax-code-claude-adapter/scripts/",
  "packages/ts/memorax-code-claude-adapter/src/",
  "packages/ts/memorax-code-dsh-adapter/src/",
  "packages/ts/memorax-code-opencode-adapter/src/",
];

const reviewedNetworkSources = new Set([
  "packages/npm/memorax-code/lib/trial-provision-client.mjs",
  "packages/ts/memorax-code-adapter-common/src/hooks/ensure-backend-runner.mjs",
  "packages/ts/memorax-code-backend/src/app/backend-server.ts",
  "packages/ts/memorax-code-backend/src/clients/claude/memory-hook-runtime.ts",
  "packages/ts/memorax-code-backend/src/clients/codex/memory-hook-runtime.ts",
  "packages/ts/memorax-code-backend/src/clients/dsh/memory-hook-runtime.ts",
  "packages/ts/memorax-code-backend/src/clients/opencode/memory-hook-runtime.ts",
  "packages/ts/memorax-code-backend/src/lifecycle/backend/service.ts",
  "packages/ts/memorax-code-backend/src/lifecycle/backend/status.ts",
  "packages/ts/memorax-code-backend/src/memory/automatic-retrieval.ts",
  "packages/ts/memorax-code-backend/src/memory/automatic-writeback.ts",
  "packages/ts/memorax-code-backend/src/memory/cli.ts",
  "packages/ts/memorax-code-backend/src/memory/writeback-buffer.ts",
  "packages/ts/memorax-code-backend/src/provider/memorax/adapter.ts",
  "packages/ts/memorax-code-backend/src/provider/memorax/http.ts",
  "packages/ts/memorax-code-backend/src/transport/http/health.ts",
  "packages/ts/memorax-code-backend/src/transport/http/json.ts",
  "packages/ts/memorax-code-backend/src/transport/http/memory-hook.ts",
  "packages/ts/memorax-code-backend/src/transport/http/request.ts",
  "packages/ts/memorax-code-claude-adapter/runtime-hooks/memory-skill-reminder.mjs",
  "packages/ts/memorax-code-claude-adapter/runtime-hooks/memory-turn.mjs",
  "packages/ts/memorax-code-claude-adapter/src/cli.mjs",
  "packages/ts/memorax-code-codex-adapter/runtime-hooks/memory-skill-reminder.mjs",
  "packages/ts/memorax-code-codex-adapter/runtime-hooks/memory-writeback.mjs",
  "packages/ts/memorax-code-codex-adapter/src/cli.mjs",
  "packages/ts/memorax-code-codex-adapter/skills/memorax-code/scripts/detect_updates.py",
  "packages/ts/memorax-code-dsh-adapter/src/http-client.mjs",
  "packages/ts/memorax-code-opencode-adapter/src/cli.mjs",
  "packages/ts/memorax-code-opencode-adapter/src/plugin.mjs",
  "packages/ts/memorax-code-opencode-adapter/src/repo-memory-server-runner.mjs",
]);

const localTraceCoreSources = new Set([
  "packages/ts/memorax-code-backend/src/memory/reminder-trace-recorder.ts",
  "packages/ts/memorax-code-backend/src/trace/config.ts",
  "packages/ts/memorax-code-backend/src/trace/context.ts",
  "packages/ts/memorax-code-backend/src/trace/store.ts",
]);

const providerTransportSources = new Set([
  "packages/ts/memorax-code-backend/src/provider/memorax/adapter.ts",
  "packages/ts/memorax-code-backend/src/provider/memorax/http.ts",
]);

const reviewedTraceAwareOutboundSources = new Set([
  // Reads the current turn only to resolve workspace scope; memory payload
  // construction remains centralized in provider/memorax/adapter.ts.
  "packages/ts/memorax-code-backend/src/memory/cli.ts",
]);

const providerTransportSourcePrefix =
  "packages/ts/memorax-code-backend/src/provider/memorax/";
const lifecycleContractsSource =
  "packages/ts/memorax-code-backend/src/lifecycle/contracts.ts";
const lifecycleFetchTypeProperty = /^\s*fetch\?:\s*typeof\s+fetch;\s*$/m;
const nestedProviderTransportImport =
  /from\s+["'](?:\.\.?\/)+provider\/memorax\/(?:adapter|http)\.js["']/;
const siblingProviderTransportImport =
  /from\s+["']\.\/(?:adapter|http)\.js["']/;

const networkCapabilityPatterns = [
  [/\bfetch(?:Impl)?\b/, "fetch"],
  [/\b(?:WebSocket|XMLHttpRequest)\b/, "browser network API"],
  [/node:(?:http|https|http2|net|tls|dgram)\b/, "Node network module"],
  [/(?:^|[^A-Za-z0-9_])(?:curl|wget)(?:[^A-Za-z0-9_]|$)/m, "external network command"],
];

const outboundCapabilityPatterns = [
  [/\b(?:fetch|fetchImpl)\s*\(/, "HTTP request"],
  [/\b(?:invokeMemoraxMemoryProvider|callMemo(?:Search|Add))\s*\(/, "MemoraX request"],
  [/\bnew\s+(?:WebSocket|XMLHttpRequest)\b/, "browser network request"],
  [/node:(?:https|http2|net|tls|dgram)\b/, "outbound-capable Node network module"],
  [/(?:^|[^A-Za-z0-9_])(?:curl|wget)(?:[^A-Za-z0-9_]|$)/m, "external network command"],
];

const localTraceStorageDependency =
  /(?:from\s+["'](?:\.\.?\/)+trace\/(?:config|store)\.js["']|\bclientTracePaths\b|\bmemoraxCodeHomeForTrace\b)/;

export async function collectLocalTraceOnlyFailures({
  repoRoot = defaultRepoRoot,
  artifactRoots = [],
  includeSource = true,
} = {}) {
  const failures = [];
  if (includeSource) {
    for (const path of trackedFiles(repoRoot)) {
      await inspectFile(resolve(repoRoot, path), path, {
        failures,
        sourcePath: path,
      });
    }
  }
  for (const artifactRoot of artifactRoots) {
    const root = resolve(artifactRoot);
    await walk(root, async (path, artifactPath) => {
      await inspectFile(path, artifactPath, {
        failures,
        sourcePath: sourcePathForArtifact(artifactPath),
      });
    }, failures);
  }
  return failures;
}

export async function assertLocalTraceOnly(options = {}) {
  const failures = await collectLocalTraceOnlyFailures(options);
  if (failures.length === 0) return;
  throw new Error([
    "Local-only trace contract failed:",
    ...failures.map((failure) => `- ${failure}`),
  ].join("\n"));
}

function parseArgs(argv) {
  const roots = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--artifact") {
      throw new Error(`unknown argument: ${argv[index]}`);
    }
    const value = argv[++index];
    if (!value) throw new Error("--artifact requires a directory");
    roots.push(value);
  }
  return roots;
}

function trackedFiles(repoRoot) {
  const result = spawnSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 10_000,
      killSignal: "SIGKILL",
    },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || result.error?.message || "git ls-files failed");
  }
  return result.stdout.split("\0").filter(Boolean);
}

async function inspectFile(path, displayPath, options) {
  let content;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "EISDIR") return;
    throw error;
  }
  if (options.sourcePath && productionRoots.some((prefix) => options.sourcePath.startsWith(prefix))) {
    inspectProductionSource(content, options.sourcePath, options.failures);
  }
}

function inspectProductionSource(content, sourcePath, failures) {
  const networkCapabilityContent = sourcePath === lifecycleContractsSource
    ? content.replace(lifecycleFetchTypeProperty, "")
    : content;
  const capabilities = networkCapabilityPatterns
    .filter(([pattern]) => pattern.test(networkCapabilityContent))
    .map(([, label]) => label);
  const outboundCapabilities = outboundCapabilityPatterns
    .filter(([pattern]) => pattern.test(content))
    .map(([, label]) => label);
  if (importsProviderTransport(content, sourcePath)) {
    capabilities.push("provider transport import");
    outboundCapabilities.push("provider transport import");
  }
  if (capabilities.length > 0) {
    if (localTraceCoreSources.has(sourcePath)) {
      failures.push(`${sourcePath}: local trace core depends on network capability (${capabilities.join(", ")})`);
    } else if (!reviewedNetworkSources.has(sourcePath)) {
      failures.push(`${sourcePath}: undeclared network-capable production module (${capabilities.join(", ")})`);
    }
  }
  if (
    localTraceStorageDependency.test(content)
    && (outboundCapabilities.length > 0 || providerTransportSources.has(sourcePath))
    && !reviewedTraceAwareOutboundSources.has(sourcePath)
  ) {
    failures.push(`${sourcePath}: unreviewed trace-aware outbound bridge`);
  }
}

function importsProviderTransport(content, sourcePath) {
  return nestedProviderTransportImport.test(content)
    || (
      sourcePath.startsWith(providerTransportSourcePrefix)
      && siblingProviderTransportImport.test(content)
    );
}

async function walk(root, visitor, failures, directory = root) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    const artifactPath = normalizePath(relative(root, path));
    if (entry.isDirectory()) await walk(root, visitor, failures, path);
    else if (entry.isFile()) await visitor(path, artifactPath);
    else if (entry.isSymbolicLink()) {
      const targetType = await safeArtifactSymlinkTarget(root, path, artifactPath, failures);
      if (targetType === "file") await visitor(path, artifactPath);
    } else {
      failures.push(`${artifactPath}: artifact contains an unsupported filesystem entry`);
    }
  }
}

async function safeArtifactSymlinkTarget(root, path, artifactPath, failures) {
  let target;
  try {
    target = await readlink(path);
  } catch (error) {
    failures.push(`${artifactPath}: cannot read artifact symbolic link (${errorCode(error)})`);
    return undefined;
  }
  if (isAbsolute(target)) {
    failures.push(`${artifactPath}: artifact symbolic link must use a relative target`);
    return undefined;
  }
  const lexicalTarget = resolve(dirname(path), target);
  if (!isWithinRoot(root, lexicalTarget)) {
    failures.push(`${artifactPath}: artifact symbolic link escapes artifact root`);
    return undefined;
  }
  let resolvedTarget;
  try {
    resolvedTarget = await realpath(path);
  } catch (error) {
    failures.push(`${artifactPath}: artifact symbolic link target is unavailable (${errorCode(error)})`);
    return undefined;
  }
  const resolvedRoot = await realpath(root);
  if (!isWithinRoot(resolvedRoot, resolvedTarget)) {
    failures.push(`${artifactPath}: artifact symbolic link resolves outside artifact root`);
    return undefined;
  }
  const metadata = await lstat(resolvedTarget);
  if (metadata.isFile()) return "file";
  if (metadata.isDirectory()) return "directory";
  failures.push(`${artifactPath}: artifact symbolic link targets an unsupported filesystem entry`);
  return undefined;
}

function sourcePathForArtifact(rawPath) {
  let path = normalizePath(rawPath).replace(/^package\//, "");
  if (productionRoots.some((prefix) => path.startsWith(prefix))) return path;

  if (path.startsWith("bin/")) {
    return `packages/npm/memorax-code/${path}`;
  }
  if (path.startsWith("lib/memorax-code-adapter-common/src/")) {
    return `packages/ts/memorax-code-adapter-common/src/${path.slice("lib/memorax-code-adapter-common/src/".length)}`;
  }
  if (path.startsWith("lib/memorax-code-backend/dist/") && path.endsWith(".js")) {
    return `packages/ts/memorax-code-backend/src/${path.slice("lib/memorax-code-backend/dist/".length, -3)}.ts`;
  }
  if (path.startsWith("lib/memorax-code-codex-adapter/")) {
    return `packages/ts/memorax-code-codex-adapter/${path.slice("lib/memorax-code-codex-adapter/".length)}`;
  }
  if (path.startsWith("lib/memorax-code-claude-adapter/skills/memorax-code/")) {
    return `packages/ts/memorax-code-codex-adapter/skills/memorax-code/${path.slice("lib/memorax-code-claude-adapter/skills/memorax-code/".length)}`;
  }
  if (path.startsWith("lib/memorax-code-claude-adapter/")) {
    return `packages/ts/memorax-code-claude-adapter/${path.slice("lib/memorax-code-claude-adapter/".length)}`;
  }
  if (path.startsWith("lib/memorax-code-claude-marketplace/plugins/memorax-code-claude-adapter/")) {
    const pluginPath = path.slice("lib/memorax-code-claude-marketplace/plugins/memorax-code-claude-adapter/".length);
    if (pluginPath.startsWith("memorax-code-adapter-common/src/")) {
      return `packages/ts/memorax-code-adapter-common/src/${pluginPath.slice("memorax-code-adapter-common/src/".length)}`;
    }
    if (pluginPath.startsWith("skills/memorax-code/")) {
      return `packages/ts/memorax-code-codex-adapter/skills/memorax-code/${pluginPath.slice("skills/memorax-code/".length)}`;
    }
    return `packages/ts/memorax-code-claude-adapter/${pluginPath}`;
  }
  if (path.startsWith("lib/memorax-code-dsh-adapter/")) {
    return `packages/ts/memorax-code-dsh-adapter/${path.slice("lib/memorax-code-dsh-adapter/".length)}`;
  }
  if (path.startsWith("lib/memorax-code-opencode-adapter/skills/memorax-code/")) {
    return `packages/ts/memorax-code-codex-adapter/skills/memorax-code/${path.slice("lib/memorax-code-opencode-adapter/skills/memorax-code/".length)}`;
  }
  if (path.startsWith("lib/memorax-code-opencode-adapter/")) {
    return `packages/ts/memorax-code-opencode-adapter/${path.slice("lib/memorax-code-opencode-adapter/".length)}`;
  }
  if (path.startsWith("lib/") && !path.slice("lib/".length).includes("/")) {
    return `packages/npm/memorax-code/${path}`;
  }
  return undefined;
}

function isWithinRoot(root, path) {
  const relativePath = relative(resolve(root), resolve(path));
  return relativePath === ""
    || (!isAbsolute(relativePath) && relativePath !== ".." && !relativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
}

function normalizePath(path) {
  return String(path).replaceAll("\\", "/").replace(/^\.\//, "");
}

function errorCode(error) {
  return typeof error?.code === "string" ? error.code : "unknown error";
}

if (isDirectInvocation()) {
  try {
    const artifactRoots = parseArgs(process.argv.slice(2));
    const failures = await collectLocalTraceOnlyFailures({ artifactRoots });
    if (failures.length > 0) {
      for (const failure of failures) console.error(`local-trace-only: ${failure}`);
      process.exitCode = 1;
    } else {
      console.log("Local-only trace contract check passed.");
    }
  } catch (error) {
    console.error(`local-trace-only: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

function isDirectInvocation() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
  }
}
