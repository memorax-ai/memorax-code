import type { spawn } from "node:child_process";
import type { RuntimeRecordWriteRuntime } from "../../../memorax-code-adapter-common/src/runtime-record.mjs";
import type { ProcessCommandLineProbeResult } from "./backend/process.js";
import type { BackendServiceState } from "./backend/record.js";

export type BackendServiceOptions = {
  home?: string;
  host?: string;
  port?: number;
  timeoutMs?: number;
  authToken?: string;
};

export type BackendServiceRuntime = {
  isProcessAlive?: (pid: number) => boolean;
  terminateProcessTree?: (pid: number) => boolean;
  probeProcessCommandLine?: (pid: number) => ProcessCommandLineProbeResult;
  spawnProcess?: typeof spawn;
  fetch?: typeof fetch;
  platform?: NodeJS.Platform;
  recordWriteRuntime?: RuntimeRecordWriteRuntime;
};

export type BackendServiceEndpoint = {
  host: string;
  port: number;
  url: string;
  authToken?: string;
  authTokenSource?: "environment" | "authority-file";
};

export type BackendRuntimeRecordKind = "pid" | "token" | "connection";

export type BackendRuntimeRecordWarning = Readonly<{
  code: "BACKEND_RUNTIME_RECORD_DURABILITY_UNCERTAIN";
  record: BackendRuntimeRecordKind;
  errorCode?: string;
  message: string;
}>;

export type BackendServiceResult = {
  ok: boolean;
  action: string;
  skipped?: boolean;
  reason?: string;
  state?: BackendServiceState;
  alreadyRunning?: boolean;
  logPath?: string;
  text?: string;
  error?: string;
  errorCode?: string;
  degraded?: true;
  warnings?: BackendRuntimeRecordWarning[];
};
