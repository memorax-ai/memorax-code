import type { spawn } from "node:child_process";
import type { SetupCompletionRecordState } from "../setup-completion.mjs";

export type AutomaticUpdateOutcome =
  | "up-to-date"
  | "updated"
  | "reconciled"
  | "check-failed"
  | "update-failed"
  | "reconcile-failed";

export type AutomaticUpdateRecord = Readonly<{
  version: 1;
  checkedAt: string;
  nextCheckAt: string;
  installedVersion: string;
  targetVersion: string | null;
  channel: "latest" | "preview";
  outcome: AutomaticUpdateOutcome;
}>;

export type AutomaticUpdateState =
  | Readonly<{ status: "absent" }>
  | Readonly<{ status: "valid"; record: AutomaticUpdateRecord }>
  | Readonly<{ status: "invalid"; reason: string }>
  | Readonly<{ status: "unsupported"; version: number }>;

export type AutomaticUpdateScheduler = Readonly<{
  close(): void;
}>;

type TimerHandle = Readonly<{
  unref?(): unknown;
}>;

export type AutomaticUpdateSchedulerRuntime = Readonly<{
  existsSync?: (path: string) => boolean;
  now?: () => number;
  readAutomaticUpdateState?: (memoraxCodeHome: string) => AutomaticUpdateState;
  readSetupCompletionRecord?: (memoraxCodeHome: string) => SetupCompletionRecordState;
  spawnProcess?: typeof spawn;
  setTimeout?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimeout?: (handle: TimerHandle) => void;
}>;

export const AUTOMATIC_UPDATE_RECORD_VERSION: 1;
export const AUTOMATIC_UPDATE_CHECK_INTERVAL_MS: number;
export const AUTOMATIC_UPDATE_RETRY_INTERVAL_MS: number;

export function automaticUpdateStatePath(memoraxCodeHome?: string): string;

export function readAutomaticUpdateState(
  memoraxCodeHome?: string,
): AutomaticUpdateState;

export function writeAutomaticUpdateState(options: {
  memoraxCodeHome: string;
  checkedAtMs: number;
  installedVersion: string;
  targetVersion: string | null;
  channel: "latest" | "preview";
  outcome: AutomaticUpdateOutcome;
  retry: boolean;
}): AutomaticUpdateRecord;

export function startAutomaticUpdateScheduler(
  options: {
    automaticUpdateProcess?: boolean;
    automaticUpdateValue?: string;
    debug?: (message: string) => void;
    env?: NodeJS.ProcessEnv;
    installedVersion: string;
    memoraxCodeCommand: string;
    memoraxCodeHome: string;
    nodePath?: string;
  },
  runtime?: AutomaticUpdateSchedulerRuntime,
): AutomaticUpdateScheduler | undefined;
