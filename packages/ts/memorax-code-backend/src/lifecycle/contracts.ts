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

export type BackendServiceFailureReason =
  | "http_error"
  | "invalid_response"
  | "not_ready"
  | "identity_mismatch"
  | "transport"
  | "timeout"
  | "deadline"
  | "health_conflict"
  | "process_mismatch"
  | "process_not_found"
  | "process_probe_inconclusive"
  | "invalid_state"
  | "unknown";

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
  stage?: string;
  failureReason?: BackendServiceFailureReason;
  recordReason?: string;
  httpStatus?: number;
  systemCode?: string;
  processState?: "not-started" | "stopped" | "running" | "unknown";
  cleanupErrorCode?: string;
  cleanupSystemCode?: string;
  degraded?: true;
  warnings?: BackendRuntimeRecordWarning[];
  startup?: BackendStartupDiagnostics;
};

export type BackendStartupDiagnostics = {
  version: 1;
  elapsedMs: number;
  healthTimeoutMs: number;
  phases: Array<{ phase: string; elapsedMs: number; durationMs: number }>;
  healthCheckCount: number;
  lastHealthCheck?: {
    outcome: "ready" | BackendServiceFailureReason;
    elapsedMs: number;
    durationMs: number;
    systemCode?: string;
    httpStatus?: number;
  };
  child: {
    pid?: number;
    exitObserved: boolean;
    exitCode?: number;
    signal?: string;
    phases: Array<{
      phase: "runtime_import" | "state_creation" | "plugin_preparation" | "server_creation" | "listen";
      event: "start" | "complete";
      elapsedMs: number;
    }>;
  };
};
