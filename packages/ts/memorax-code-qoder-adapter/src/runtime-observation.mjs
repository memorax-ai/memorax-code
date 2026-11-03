import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export function qoderRuntimeObservationPath(memoraxCodeHome) {
  return join(memoraxCodeHome, "adapters", "qoder", "runtime-observed.json");
}

export async function writeQoderRuntimeObservation({ memoraxCodeHome, qoderHome, runtimeDigest }) {
  const path = qoderRuntimeObservationPath(memoraxCodeHome);
  const record = { version: 1, runtimeDigest, qoderHome, observedAt: new Date().toISOString() };
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
  return record;
}

export async function readQoderRuntimeObservation(memoraxCodeHome) {
  try {
    const value = JSON.parse(await readFile(qoderRuntimeObservationPath(memoraxCodeHome), "utf8"));
    if (Object.keys(value).sort().join(",") !== "observedAt,qoderHome,runtimeDigest,version"
      || value.version !== 1 || !/^[a-f0-9]{64}$/.test(value.runtimeDigest)
      || typeof value.qoderHome !== "string" || !value.qoderHome.trim()
      || typeof value.observedAt !== "string" || !Number.isFinite(Date.parse(value.observedAt))) return undefined;
    return value;
  } catch {
    return undefined;
  }
}
