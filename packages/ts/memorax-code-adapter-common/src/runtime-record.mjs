import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export class RuntimeRecordError extends Error {
  constructor({ name, path, state, codePrefix, recovery }) {
    const detail = state.status === "unsupported"
      ? `uses unsupported version ${state.version}`
      : state.status === "invalid"
        ? `is invalid (${state.reason})`
        : "is missing";
    super(`${name} ${detail}: ${path}${recovery ? `; ${recovery}` : ""}`);
    this.name = "RuntimeRecordError";
    this.code = `${codePrefix}_${state.status.toUpperCase()}`;
    this.recordStatus = state.status;
    this.recordPath = path;
    if (state.status === "unsupported") this.version = state.version;
    if (state.status === "invalid") this.reason = state.reason;
  }
}

export function readJsonRuntimeRecord(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "absent" };
    return { status: "invalid", reason: "unreadable" };
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { status: "invalid", reason: "malformed_json" };
  }
  if (!isRecord(value)) return { status: "invalid", reason: "invalid_record" };
  return { status: "present", value };
}

// Atomic replacement gives readers a complete snapshot. Read-modify-write
// callers must hold their own lock across the read and this write.
export function writePrivateJsonRecord(path, value, options) {
  const directoryPath = dirname(path);
  ensurePrivateDirectory(directoryPath, {
    durableBoundary: options?.durableBoundary,
  });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, path);
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Best-effort cleanup after an incomplete write.
      }
    }
    try {
      rmSync(temporaryPath, { force: true });
    } catch {
      // Preserve the original write failure.
    }
    throw error;
  }
  // rename has already published the new record. A directory-sync failure
  // means crash durability is uncertain; it does not mean the write was undone.
  try {
    (options?.syncDirectory ?? syncDirectory)(directoryPath);
    return { path, record: value, durability: "confirmed" };
  } catch (error) {
    const durabilityErrorCode = errorCode(error);
    return {
      path,
      record: value,
      durability: "uncertain",
      ...(durabilityErrorCode ? { durabilityErrorCode } : {}),
    };
  }
}

export function ensurePrivateDirectory(path, options) {
  const directoryPath = resolve(path);
  const durableBoundary = privateDirectoryBoundary(
    directoryPath,
    options?.durableBoundary,
  );
  mkdirSync(directoryPath, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") return;
  chmodSync(directoryPath, 0o700);
  const sync = options?.syncDirectory ?? syncDirectory;
  let current = directoryPath;
  while (true) {
    sync(current);
    if (current === durableBoundary) return;
    const parent = dirname(current);
    if (parent === current) {
      throw new Error("private directory durable boundary was not reached");
    }
    current = parent;
  }
}

function privateDirectoryBoundary(directoryPath, boundary) {
  if (typeof boundary !== "string" || !boundary.trim()) {
    throw new TypeError("private directory requires an explicit durable boundary");
  }
  const boundaryPath = resolve(boundary);
  const childPath = relative(boundaryPath, directoryPath);
  if (childPath === ""
    || (childPath !== ".."
      && !childPath.startsWith(`..${sep}`)
      && !isAbsolute(childPath))) {
    return boundaryPath;
  }
  throw new RangeError("private directory must be contained by its durable boundary");
}

function syncDirectory(directoryPath) {
  if (process.platform === "win32") return;
  let descriptor;
  try {
    descriptor = openSync(directoryPath, "r");
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function errorCode(error) {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && typeof error.code === "string"
    ? error.code
    : undefined;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
