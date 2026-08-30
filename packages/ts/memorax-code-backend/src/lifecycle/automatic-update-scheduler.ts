import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  AUTOMATIC_UPDATE_RETRY_INTERVAL_MS,
  readAutomaticUpdateState,
  type AutomaticUpdateState,
} from "../../../memorax-code-adapter-common/src/automatic-update-state.mjs";
import {
  readSetupCompletionRecord,
  type SetupCompletionRecordState,
} from "../../../memorax-code-adapter-common/src/setup-completion.mjs";

const MAX_TIMER_DELAY_MS = 2_147_483_647;

type TimerHandle = Readonly<{ unref?(): unknown }>;

export type AutomaticUpdateScheduler = Readonly<{ close(): void }>;

export type AutomaticUpdateSchedulerRuntime = Readonly<{
  existsSync?: (path: string) => boolean;
  now?: () => number;
  readAutomaticUpdateState?: (memoraxCodeHome: string) => AutomaticUpdateState;
  readSetupCompletionRecord?: (memoraxCodeHome: string) => SetupCompletionRecordState;
  spawnProcess?: typeof spawn;
  setTimeout?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimeout?: (handle: TimerHandle) => void;
}>;

export function startBackendAutomaticUpdateScheduler(
  options: {
    env?: NodeJS.ProcessEnv;
    memoraxCodeHome: string;
    packageRoot?: string;
    packageVersion?: string;
    debug?: (message: string) => void;
  },
  runtime: AutomaticUpdateSchedulerRuntime = {},
): AutomaticUpdateScheduler | undefined {
  const env = options.env ?? process.env;
  if (automaticUpdateDisabled(env.MEMORAX_CODE_AUTO_UPDATE)) return undefined;

  const packageRoot = nonEmptyString(options.packageRoot);
  const installedVersion = nonEmptyString(options.packageVersion);
  if (!packageRoot || !installedVersion) return undefined;
  const memoraxCodeHome = resolve(options.memoraxCodeHome);
  const memoraxCodeCommand = join(resolve(packageRoot), "bin", "memorax-code.mjs");
  if (!(runtime.existsSync ?? existsSync)(memoraxCodeCommand)) return undefined;

  const readCompletion = runtime.readSetupCompletionRecord ?? readSetupCompletionRecord;
  const readUpdateState = runtime.readAutomaticUpdateState ?? readAutomaticUpdateState;
  const spawnProcess = runtime.spawnProcess ?? spawn;
  const now = runtime.now ?? Date.now;
  const setTimer = runtime.setTimeout
    ?? ((callback: () => void, delayMs: number): TimerHandle => setTimeout(callback, delayMs));
  const clearTimer = runtime.clearTimeout
    ?? ((handle: TimerHandle): void => clearTimeout(handle as NodeJS.Timeout));
  let closed = false;
  let childRunning = false;
  let timer: TimerHandle | undefined;
  let suppressImmediate = env.MEMORAX_CODE_AUTOMATIC_UPDATE_PROCESS === "1";

  const debug = (message: string): void => options.debug?.(message);
  const scheduleAfter = (delayMs: number): void => {
    if (closed) return;
    if (timer !== undefined) clearTimer(timer);
    timer = setTimer(() => {
      timer = undefined;
      reconcile();
    }, Math.max(1, Math.min(MAX_TIMER_DELAY_MS, Math.trunc(delayMs))));
    timer.unref?.();
  };
  const scheduleRetry = (): void => scheduleAfter(AUTOMATIC_UPDATE_RETRY_INTERVAL_MS);

  const launch = (): void => {
    let child;
    try {
      child = spawnProcess(
        process.execPath,
        [memoraxCodeCommand, "update", "--automatic", "--home", memoraxCodeHome],
        {
          detached: true,
          env: {
            ...env,
            MEMORAX_CODE_AUTOMATIC_UPDATE_PROCESS: "1",
            MEMORAX_CODE_HOME: memoraxCodeHome,
          },
          stdio: "ignore",
          windowsHide: true,
        },
      );
    } catch (error) {
      debug(`MemoraX Code automatic update could not start: ${errorMessage(error)}`);
      scheduleRetry();
      return;
    }

    childRunning = true;
    let settled = false;
    const finish = (successful: boolean): void => {
      if (settled) return;
      settled = true;
      childRunning = false;
      if (!closed) reconcile(!successful);
    };
    child.once("error", (error) => {
      debug(`MemoraX Code automatic update could not start: ${error.message}`);
      finish(false);
    });
    child.once("close", (code, signal) => finish(signal === null && code === 0));
    child.unref();
  };

  function reconcile(deferDue = false): void {
    if (closed || childRunning) return;
    const suppressDue = suppressImmediate;
    suppressImmediate = false;
    try {
      const completion = readCompletion(memoraxCodeHome);
      const state = readUpdateState(memoraxCodeHome);
      const nowMs = Number(now());
      if (!Number.isFinite(nowMs)) throw new TypeError("automatic update scheduler clock is invalid");
      if (completion.status !== "valid") {
        scheduleRetry();
        return;
      }
      if (state.status === "valid" && state.record.installedVersion === installedVersion) {
        const remainingMs = Date.parse(state.record.nextCheckAt) - nowMs;
        if (remainingMs > 0) {
          scheduleAfter(remainingMs);
          return;
        }
      }
    } catch (error) {
      debug(`MemoraX Code automatic update scheduling failed: ${errorMessage(error)}`);
      scheduleRetry();
      return;
    }
    if (suppressDue || deferDue) scheduleRetry();
    else launch();
  }

  reconcile();
  return {
    close() {
      if (closed) return;
      closed = true;
      if (timer !== undefined) clearTimer(timer);
      timer = undefined;
    },
  };
}

function automaticUpdateDisabled(value: string | undefined): boolean {
  return ["0", "false", "no", "off", "disabled"].includes(String(value ?? "").trim().toLowerCase());
}

function nonEmptyString(value: string | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
