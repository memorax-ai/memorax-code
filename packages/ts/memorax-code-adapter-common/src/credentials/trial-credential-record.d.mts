export const TRIAL_CREDENTIAL_RECORD_VERSION: 1;

export type TrialCredentialRecordState = "provisioning" | "ready";

type TrialCredentialIdentity = Readonly<{
  version: 1;
  mark_id: string;
  mark_version: 1;
  app_salt: "memorax-plugin-v1";
  machine_id: string;
  hostname: string;
  platform: "windows" | "linux" | "macos";
  arch: "x86_64" | "arm64";
  mac_hash: string;
}>;

export type TrialCredentialRecord = TrialCredentialIdentity & (
  | Readonly<{
      state: "provisioning";
      api_key: null;
      account_id: null;
      project_id: null;
      last_warned_write_level: null;
      last_warned_search_level: null;
    }>
  | Readonly<{
      state: "ready";
      api_key: string;
      account_id: string;
      project_id: string;
      last_warned_write_level: number | null;
      last_warned_search_level: number | null;
    }>
);

export type TrialCredentialRecordInvalidReason =
  | "malformed_json"
  | "invalid_record"
  | "unknown_fields"
  | "missing_fields"
  | "unsupported_version"
  | "invalid_version"
  | "invalid_state"
  | "invalid_mark_id"
  | "invalid_mark_version"
  | "invalid_app_salt"
  | "invalid_machine_id"
  | "invalid_hostname"
  | "invalid_platform"
  | "invalid_arch"
  | "invalid_mac_hash"
  | "invalid_api_key"
  | "invalid_shape"
  | "invalid_account_id"
  | "invalid_project_id"
  | "invalid_last_warned_level"
  | "invalid_transition";

export class TrialCredentialRecordError extends Error {
  constructor(reason: TrialCredentialRecordInvalidReason);
  readonly code: "TRIAL_CREDENTIAL_RECORD_INVALID";
  readonly reason: TrialCredentialRecordInvalidReason;
}

export function parseTrialCredentialRecord(text: string): TrialCredentialRecord;
export function validateTrialCredentialRecord(value: unknown): TrialCredentialRecord;
export function serializeTrialCredentialRecord(value: unknown): string;

export function createInitialTrialCredentialRecord(options: Readonly<{
  markId: string;
  markVersion: 1;
  appSalt: "memorax-plugin-v1";
  machineId: string;
  hostname: string;
  platform: "windows" | "linux" | "macos";
  arch: "x86_64" | "arm64";
  macHash: string;
}>): TrialCredentialRecord;

export function completeTrialCredentialProvisioning(
  value: unknown,
  metadata: Readonly<{
    accountId: string;
    projectId: string;
    apiKey: string;
  }>,
): TrialCredentialRecord;
