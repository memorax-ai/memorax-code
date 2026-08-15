import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const PACKAGE_METADATA_VERSION = 1;
const STATE_VERSION = 1;

/** Read the current durable enablement authority for this installed DSH bundle. */
export function requireEnabledDshRuntime(pluginRoot) {
  const root = resolveRequiredPath(pluginRoot, "pluginRoot");
  const metadata = readRecord(join(root, ".memorax-code-package.json"));
  if (metadata?.version !== PACKAGE_METADATA_VERSION
    || !nonEmptyString(metadata.memoraxCodeCommand)
    || !nonEmptyString(metadata.memoraxCodeHome)
    || !nonEmptyString(metadata.dshCommand)
    || !nonEmptyString(metadata.dshHome)
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
    || !timestampString(state.updatedAt)) {
    throw disabledError();
  }

  return {
    memoraxCodeCommand: metadata.memoraxCodeCommand,
    memoraxCodeHome,
    dshCommand: metadata.dshCommand,
    dshHome,
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

function timestampString(value) {
  const normalized = nonEmptyString(value);
  return normalized && Number.isFinite(Date.parse(normalized)) ? normalized : undefined;
}

function disabledError() {
  const error = new Error("MemoraX Code DSH integration is not enabled");
  error.code = "MEMORAX_CODE_DSH_DISABLED";
  return error;
}
