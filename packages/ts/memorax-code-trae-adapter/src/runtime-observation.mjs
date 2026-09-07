import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export function traeRuntimeObservationPath(memoraxCodeHome) {
  return join(memoraxCodeHome, "adapters", "trae", "runtime-observed.json");
}

export async function writeTraeRuntimeObservation({ memoraxCodeHome, traeHome, runtimeDigest }) {
  const path = traeRuntimeObservationPath(memoraxCodeHome);
  const record = {
    version: 1,
    runtimeDigest,
    traeHome,
    observedAt: new Date().toISOString(),
  };
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, path);
  return record;
}

export async function readTraeRuntimeObservation(memoraxCodeHome) {
  try {
    const value = JSON.parse(await readFile(traeRuntimeObservationPath(memoraxCodeHome), "utf8"));
    if (!isRecord(value) || !hasExactKeys(value, ["observedAt", "runtimeDigest", "traeHome", "version"])) return undefined;
    if (value.version !== 1
      || !sha256(value.runtimeDigest)
      || !stringValue(value.traeHome)
      || !validTimestamp(value.observedAt)) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasExactKeys(value, expected) {
  return Object.keys(value).sort().join("\n") === [...expected].sort().join("\n");
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function sha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function validTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
