import { readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { parseDshVersion } from "./dsh-version.mjs";

const PACKAGE_METADATA_VERSION = 1;
const STATE_VERSION = 1;

export function buildDshCommand(command, args, options = {}) {
  const executable = nonEmptyString(command);
  if (!executable) throw new TypeError("DSH command must be a non-empty string");
  if (!Array.isArray(args)) throw new TypeError("DSH arguments must be an array");
  if (isNpxCommand(executable)) throw disabledError();
  return isAbsolute(executable) && /\.(?:cjs|js|mjs)$/i.test(executable)
    ? [nonEmptyString(options.nodePath) ?? process.execPath, executable, ...args]
    : [executable, ...args];
}

/** Read the current durable enablement authority for this installed DSH bundle. */
export function requireEnabledDshRuntime(pluginRoot) {
  const authority = requireDshRuntimeAuthority(pluginRoot);
  if (!authority.enabled) throw disabledError();
  return {
    memoraxCodeCommand: authority.memoraxCodeCommand,
    memoraxCodeHome: authority.memoraxCodeHome,
    dshCommand: authority.dshCommand,
    dshHome: authority.dshHome,
    dshVersion: authority.dshVersion,
    profiles: authority.profiles,
    revision: authority.revision,
  };
}

/** Validate one installed bundle's metadata against its durable lifecycle state. */
export function requireDshRuntimeAuthority(pluginRoot) {
  const root = resolveRequiredPath(pluginRoot, "pluginRoot");
  const metadata = readRecord(join(root, ".memorax-code-package.json"));
  if (metadata?.version !== PACKAGE_METADATA_VERSION
    || !nonEmptyString(metadata.memoraxCodeCommand)
    || !nonEmptyString(metadata.memoraxCodeHome)
    || !nonEmptyString(metadata.dshCommand)
    || isNpxCommand(metadata.dshCommand)
    || !nonEmptyString(metadata.dshHome)
    || !parseDshVersion(metadata.dshVersion)
    || !nonEmptyString(metadata.sourceAdapterRoot)
    || !nonEmptyString(metadata.runtimeBundleRoot)) {
    throw disabledError();
  }

  const memoraxCodeHome = resolve(metadata.memoraxCodeHome);
  const dshHome = resolve(metadata.dshHome);
  const runtimeBundleRoot = resolve(metadata.runtimeBundleRoot);
  if (!isPathInside(
    runtimeBundleRoot,
    join(memoraxCodeHome, "adapters", "dsh", "runtime", "generations"),
  )) {
    throw disabledError();
  }
  const state = readRecord(join(memoraxCodeHome, "adapters", "dsh", "state.json"));
  if (state?.version !== STATE_VERSION
    || state.runtime !== "dsh"
    || state.integration !== "plugin"
    || typeof state.enabled !== "boolean"
    || resolveString(state.memoraxCodeHome) !== memoraxCodeHome
    || resolveString(state.dshHome) !== dshHome
    || resolveString(state.adapterRoot) !== resolve(metadata.sourceAdapterRoot)
    || resolveString(state.runtimeBundleRoot) !== runtimeBundleRoot
    || state.memoraxCodeCommand !== metadata.memoraxCodeCommand
    || state.dshCommand !== metadata.dshCommand
    || state.dshVersion !== metadata.dshVersion
    || !Array.isArray(state.profiles)
    || !state.profiles.every(validProfileName)
    || !timestampString(state.updatedAt)) {
    throw disabledError();
  }

  return {
    enabled: state.enabled,
    sourceAdapterRoot: resolve(metadata.sourceAdapterRoot),
    runtimeBundleRoot,
    memoraxCodeCommand: metadata.memoraxCodeCommand,
    memoraxCodeHome,
    dshCommand: metadata.dshCommand,
    dshHome,
    dshVersion: metadata.dshVersion,
    profiles: [...state.profiles],
    revision: state.updatedAt,
  };
}

function readRecord(path) {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

function resolveRequiredPath(value, name) {
  const normalized = nonEmptyString(value);
  if (!normalized) throw new TypeError(`DSH ${name} must be a non-empty path`);
  return resolve(normalized);
}

function resolveString(value) {
  const normalized = nonEmptyString(value);
  return normalized ? resolve(normalized) : undefined;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isNpxCommand(value) {
  const command = nonEmptyString(value);
  return Boolean(command && command
    .split(/[\\/]/)
    .at(-1)
    .replace(/\.(?:cmd|bat|exe|com)$/i, "")
    .toLowerCase() === "npx");
}

function timestampString(value) {
  const normalized = nonEmptyString(value);
  return normalized && Number.isFinite(Date.parse(normalized)) ? normalized : undefined;
}

function validProfileName(value) {
  return typeof value === "string"
    && value.length > 0
    && value !== "."
    && value !== ".."
    && value !== "node_modules"
    && !value.includes("/")
    && !value.includes("\\");
}

function isPathInside(value, parent) {
  const child = relative(resolve(parent), resolve(value));
  return child !== ""
    && child !== ".."
    && !child.startsWith(`..${sep}`)
    && !isAbsolute(child);
}

function disabledError() {
  const error = new Error("MemoraX Code DSH integration is not enabled");
  error.code = "MEMORAX_CODE_DSH_DISABLED";
  return error;
}
