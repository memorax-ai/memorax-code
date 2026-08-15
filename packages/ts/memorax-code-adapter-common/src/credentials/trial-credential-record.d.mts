export const TRIAL_CREDENTIAL_RECORD_VERSION: 1;

export type TrialCredentialRecordState = "provisioning" | "recovering" | "ready";

export type TrialCredentialRecord = Readonly<{
  version: 1;
  state: TrialCredentialRecordState;
  plugin_mark: string;
  api_key: string;
  account_id: string | null;
  project_id: string | null;
  warn_remaining_threshold: number | null;
  warn_remaining_step: number | null;
  register_url: string | null;
  last_warned_level: number | null;
}>;

export type TrialCredentialRecordInvalidReason =
  | "malformed_json"
  | "invalid_record"
  | "unknown_fields"
  | "missing_fields"
  | "unsupported_version"
  | "invalid_version"
  | "invalid_state"
  | "invalid_plugin_mark"
  | "invalid_api_key"
  | "invalid_shape"
  | "invalid_account_id"
  | "invalid_project_id"
  | "invalid_warn_remaining_threshold"
  | "invalid_warn_remaining_step"
  | "invalid_register_url"
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
  pluginMark: string;
  apiKey: string;
}>): TrialCredentialRecord;

export function createTrialCredentialRecoveryRecord(options: Readonly<{
  pluginMark: string;
  apiKey: string;
}>): TrialCredentialRecord;

export function beginTrialCredentialRecovery(
  value: unknown,
  options: Readonly<{ apiKey: string }>,
): TrialCredentialRecord;

export function completeTrialCredentialProvisioning(
  value: unknown,
  metadata: Readonly<{
    accountId: string;
    projectId: string;
    warnRemainingThreshold: number;
    warnRemainingStep: number;
    registerUrl: string;
    lastWarnedLevel?: number | null;
  }>,
): TrialCredentialRecord;
