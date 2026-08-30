export type AutomaticUpdateRecord = Readonly<{
  version: 1;
  installedVersion: string;
  nextCheckAt: string;
}>;

export type AutomaticUpdateState =
  | Readonly<{ status: "absent" }>
  | Readonly<{ status: "valid"; record: AutomaticUpdateRecord }>
  | Readonly<{ status: "invalid"; reason: string }>
  | Readonly<{ status: "unsupported"; version: number }>;

export const AUTOMATIC_UPDATE_RECORD_VERSION: 1;
export const AUTOMATIC_UPDATE_CHECK_INTERVAL_MS: number;
export const AUTOMATIC_UPDATE_RETRY_INTERVAL_MS: number;

export function automaticUpdateStatePath(memoraxCodeHome: string): string;
export function readAutomaticUpdateState(memoraxCodeHome: string): AutomaticUpdateState;
export function writeAutomaticUpdateState(options: {
  memoraxCodeHome: string;
  nowMs: number;
  installedVersion: string;
  retry: boolean;
}): AutomaticUpdateRecord;
