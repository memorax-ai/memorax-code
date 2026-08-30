import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export function codeBuddyRuntimeObservationPath(memoraxCodeHome) {
  return join(memoraxCodeHome, "adapters", "codebuddy", "runtime-observed.json");
}

export async function writeCodeBuddyRuntimeObservation({
  memoraxCodeHome,
  codeBuddyHome,
  pluginRoot,
}) {
  const pluginVersion = await readPluginVersion(pluginRoot);
  const path = codeBuddyRuntimeObservationPath(memoraxCodeHome);
  const record = {
    version: 1,
    pluginVersion,
    codeBuddyHome,
    observedAt: new Date().toISOString(),
  };
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
  return record;
}

export async function readCodeBuddyRuntimeObservation(memoraxCodeHome) {
  try {
    const value = JSON.parse(await readFile(codeBuddyRuntimeObservationPath(memoraxCodeHome), "utf8"));
    if (!isRecord(value) || !hasExactKeys(value, ["codeBuddyHome", "observedAt", "pluginVersion", "version"])) {
      return undefined;
    }
    if (value.version !== 1
      || !stringValue(value.pluginVersion)
      || !stringValue(value.codeBuddyHome)
      || !validTimestamp(value.observedAt)) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

async function readPluginVersion(pluginRoot) {
  const manifest = JSON.parse(await readFile(join(pluginRoot, ".codebuddy-plugin", "plugin.json"), "utf8"));
  const version = stringValue(manifest?.version);
  if (!version) throw new Error("CodeBuddy plugin manifest has no version");
  return version;
}

function isRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, expected) {
  return Object.keys(value).sort().join("\n") === [...expected].sort().join("\n");
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function validTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
