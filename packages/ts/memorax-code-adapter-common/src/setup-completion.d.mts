import type { JsonFileLockOptions } from "./config-utils.mjs";
import {
  RuntimeRecordError,
  type RuntimeRecordWriteResult,
  type RuntimeRecordWriteRuntime,
} from "./runtime-record.mjs";

export type SetupCompletionRecord = Readonly<{
  version: 1;
  state: "complete";
  completedAt: string;
  completedByVersion: string;
}>;

export type SetupCompletionRecordInvalidReason =
  | "unreadable"
  | "malformed_json"
  | "invalid_record"
  | "invalid_version"
  | "unknown_fields"
  | "invalid_state"
  | "invalid_completed_at"
  | "invalid_completed_by_version";

export type SetupCompletionRecordState =
  | Readonly<{ status: "absent" }>
  | Readonly<{ status: "valid"; record: SetupCompletionRecord }>
  | Readonly<{ status: "invalid"; reason: SetupCompletionRecordInvalidReason }>
  | Readonly<{ status: "unsupported"; version: number }>;

export type WritableSetupCompletionRecordState = Extract<
  SetupCompletionRecordState,
  { status: "absent" | "valid" }
>;

export type SetupCompletionClearResult = Readonly<{
  path: string;
  removed: boolean;
}>;

export type SetupCompletionLockMutation = Readonly<{
  clear(): SetupCompletionClearResult;
}>;

export const SETUP_COMPLETION_RECORD_VERSION: 1;

export class SetupCompletionRecordError extends RuntimeRecordError {
  constructor(
    state: Extract<SetupCompletionRecordState, { status: "invalid" | "unsupported" }>,
    path: string,
  );
}

export function setupCompletionPath(memoraxCodeHome?: string): string;

export function readSetupCompletionRecord(
  memoraxCodeHome?: string,
): SetupCompletionRecordState;

export function writeSetupCompletionRecord(
  options: {
    memoraxCodeHome?: string;
    completedAt: string;
    completedByVersion: string;
  },
  runtime?: RuntimeRecordWriteRuntime,
): RuntimeRecordWriteResult<SetupCompletionRecord>;

export function clearSetupCompletionRecord(
  memoraxCodeHome?: string,
  options?: JsonFileLockOptions,
): Promise<SetupCompletionClearResult>;

export function withSetupCompletionLock<T>(
  memoraxCodeHome: string,
  operation: (
    state: WritableSetupCompletionRecordState,
    mutation: SetupCompletionLockMutation,
  ) => T | Promise<T>,
  options?: JsonFileLockOptions,
): Promise<T>;
