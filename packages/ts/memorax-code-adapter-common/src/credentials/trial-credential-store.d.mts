import type { JsonFileLockOptions } from "../config-utils.mjs";
import type { TrialCredentialRecord } from "./trial-credential-record.mjs";

export type TrialCredentialSecureBackend = Readonly<{
  load(): Promise<string | null>;
  save(serialized: string): Promise<void>;
  delete(): Promise<boolean>;
}>;

export type TrialCredentialStoreOptions = Readonly<{
  memoraxCodeHome?: string;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  backend?: TrialCredentialSecureBackend;
  runtime?: Record<string, unknown>;
  lockOptions?: JsonFileLockOptions;
}>;

export type TrialCredentialNamespaceOptions = Readonly<{
  platform?: NodeJS.Platform;
  resolveHome?: (value: string) => string;
}>;

export function trialCredentialNamespace(
  memoraxCodeHome: string,
  options?: TrialCredentialNamespaceOptions,
): string;

export function trialCredentialLockPath(memoraxCodeHome: string): string;

export function loadTrialCredentialRecord(
  options?: TrialCredentialStoreOptions,
): Promise<TrialCredentialRecord | null>;

export function createTrialCredentialRecordIfAbsent(
  value: unknown,
  options?: TrialCredentialStoreOptions,
): Promise<Readonly<{ record: TrialCredentialRecord; created: boolean }>>;

export function transitionTrialCredentialRecord(
  operation: (
    current: TrialCredentialRecord,
  ) => TrialCredentialRecord | undefined,
  options?: TrialCredentialStoreOptions,
): Promise<TrialCredentialRecord>;

export function clearTrialCredentialRecord(
  options?: TrialCredentialStoreOptions,
): Promise<Readonly<{ deleted: boolean }>>;
