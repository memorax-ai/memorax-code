import { randomBytes } from "node:crypto";
import {
  backendTokenPath,
  BackendTokenRecordError,
  readBackendTokenRecordState,
  writeBackendTokenRecord,
} from "../../../../memorax-code-adapter-common/src/backend-connection.mjs";
import type {
  RuntimeRecordWriteResult,
  RuntimeRecordWriteRuntime,
} from "../../../../memorax-code-adapter-common/src/runtime-record.mjs";

export type BackendTokenRecord = {
  token: string;
  tokenPath: string;
  createdAt: string;
  rotatedAt?: string;
  persistence?: Pick<
    RuntimeRecordWriteResult<unknown>,
    "durability" | "durabilityErrorCode"
  >;
};

export function readBackendTokenForHome(memoraxCodeHome: string): BackendTokenRecord | undefined {
  const state = readBackendTokenRecordState(memoraxCodeHome);
  if (state.status === "absent") return undefined;
  if (state.status !== "valid") {
    throw new BackendTokenRecordError(state, backendTokenPath(memoraxCodeHome));
  }
  return serviceTokenRecord(state.record, backendTokenPath(memoraxCodeHome));
}

export function writeBackendTokenForHome(
  memoraxCodeHome: string,
  rotate = false,
  runtime?: RuntimeRecordWriteRuntime,
): BackendTokenRecord {
  const state = readBackendTokenRecordState(memoraxCodeHome);
  if (state.status === "unsupported") {
    throw new BackendTokenRecordError(state, backendTokenPath(memoraxCodeHome));
  }
  if (state.status === "invalid" && !rotate) {
    throw new BackendTokenRecordError(state, backendTokenPath(memoraxCodeHome));
  }
  const existing = state.status === "valid"
    ? serviceTokenRecord(state.record, backendTokenPath(memoraxCodeHome))
    : undefined;
  if (existing && !rotate) return existing;
  const now = new Date().toISOString();
  return persistTokenRecord(memoraxCodeHome, {
    token: randomBytes(32).toString("base64url"),
    tokenPath: backendTokenPath(memoraxCodeHome),
    createdAt: existing?.createdAt ?? now,
    ...(existing ? { rotatedAt: now } : {}),
  }, runtime);
}

export function persistBackendTokenForHome(
  memoraxCodeHome: string,
  token: string,
  runtime?: RuntimeRecordWriteRuntime,
): BackendTokenRecord {
  const state = readBackendTokenRecordState(memoraxCodeHome);
  if (state.status !== "absent" && state.status !== "valid") {
    throw new BackendTokenRecordError(state, backendTokenPath(memoraxCodeHome));
  }
  const existing = state.status === "valid"
    ? serviceTokenRecord(state.record, backendTokenPath(memoraxCodeHome))
    : undefined;
  if (existing?.token === token) return existing;
  const now = new Date().toISOString();
  return persistTokenRecord(memoraxCodeHome, {
    token,
    tokenPath: backendTokenPath(memoraxCodeHome),
    createdAt: existing?.createdAt ?? now,
    ...(existing ? { rotatedAt: now } : {}),
  }, runtime);
}

export function assertBackendTokenPersistenceEligible(memoraxCodeHome: string): void {
  const state = readBackendTokenRecordState(memoraxCodeHome);
  if (state.status === "invalid" || state.status === "unsupported") {
    throw new BackendTokenRecordError(state, backendTokenPath(memoraxCodeHome));
  }
}

function serviceTokenRecord(
  record: Readonly<{ token: string; createdAt: string; rotatedAt?: string }>,
  path: string,
  persistence?: BackendTokenRecord["persistence"],
): BackendTokenRecord {
  return {
    token: record.token,
    tokenPath: path,
    createdAt: record.createdAt,
    ...(record.rotatedAt ? { rotatedAt: record.rotatedAt } : {}),
    ...(persistence ? { persistence } : {}),
  };
}

function persistTokenRecord(
  memoraxCodeHome: string,
  record: BackendTokenRecord,
  runtime?: RuntimeRecordWriteRuntime,
): BackendTokenRecord {
  const written = writeBackendTokenRecord({
    memoraxCodeHome,
    token: record.token,
    createdAt: record.createdAt,
    ...(record.rotatedAt ? { rotatedAt: record.rotatedAt } : {}),
  }, runtime);
  return serviceTokenRecord(written.record, written.path, {
    durability: written.durability,
    ...(written.durabilityErrorCode
      ? { durabilityErrorCode: written.durabilityErrorCode }
      : {}),
  });
}
