import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { isSupportedDshVersion } from "./dsh-version.mjs";

const PACKAGE_METADATA_VERSION = 1;
const STATE_VERSION = 1;
const DSH_PACKAGE_NAME = "@deepseek-ai/dsh";

/** Read the current durable enablement authority for this installed DSH bundle. */
export function requireEnabledDshRuntime(pluginRoot, options = {}) {
  const root = resolveRequiredPath(pluginRoot, "pluginRoot");
  const metadata = readRecord(join(root, ".memorax-code-package.json"));
  if (metadata?.version !== PACKAGE_METADATA_VERSION
    || !nonEmptyString(metadata.memoraxCodeCommand)
    || !nonEmptyString(metadata.memoraxCodeHome)
    || !nonEmptyString(metadata.dshCommand)
    || !nonEmptyString(metadata.dshHome)
    || !isSupportedDshVersion(metadata.dshVersion)
    || !nonEmptyString(metadata.sourceAdapterRoot)) {
    throw disabledError();
  }

  const memoraxCodeHome = resolve(metadata.memoraxCodeHome);
  const dshHome = resolve(metadata.dshHome);
  const state = readRecord(join(memoraxCodeHome, "adapters", "dsh", "state.json"));
  if (state?.version !== STATE_VERSION
    || state.runtime !== "dsh"
    || state.integration !== "plugin"
    || state.enabled !== true
    || resolveString(state.memoraxCodeHome) !== memoraxCodeHome
    || resolveString(state.dshHome) !== dshHome
    || resolveString(state.adapterRoot) !== resolve(metadata.sourceAdapterRoot)
    || state.memoraxCodeCommand !== metadata.memoraxCodeCommand
    || state.dshCommand !== metadata.dshCommand
    || state.dshVersion !== metadata.dshVersion
    || !timestampString(state.updatedAt)) {
    throw disabledError();
  }
  const hostDshVersion = readHostDshVersion(options.hostEntrypoint ?? process.argv[1]);
  if (hostDshVersion !== metadata.dshVersion) throw disabledError();

  return {
    memoraxCodeCommand: metadata.memoraxCodeCommand,
    memoraxCodeHome,
    dshCommand: metadata.dshCommand,
    dshHome,
    revision: state.updatedAt,
  };
}

function readHostDshVersion(entrypoint) {
  const path = nonEmptyString(entrypoint);
  if (!path) return undefined;
  let directory;
  try {
    directory = dirname(realpathSync(path));
  } catch {
    return undefined;
  }
  while (true) {
    const manifestPath = join(directory, "package.json");
    if (existsSync(manifestPath)) {
      const manifest = readRecord(manifestPath);
      if (manifest?.name !== DSH_PACKAGE_NAME) return undefined;
      const version = nonEmptyString(manifest.version);
      return isSupportedDshVersion(version) ? version : undefined;
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
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

function timestampString(value) {
  const normalized = nonEmptyString(value);
  return normalized && Number.isFinite(Date.parse(normalized)) ? normalized : undefined;
}

function disabledError() {
  const error = new Error("MemoraX Code DSH integration is not enabled");
  error.code = "MEMORAX_CODE_DSH_DISABLED";
  return error;
}
