import type { ChildProcess } from "node:child_process";
import { performance } from "node:perf_hooks";
import type { BackendServiceResult, BackendStartupDiagnostics } from "../contracts.js";

const MESSAGE_TYPE = "memorax-code.backend-startup";
const PARENT_PHASES = [
  "resolve_connection", "read_state", "resolve_token", "verify_ownership",
  "prepare_runtime", "spawn", "persist_pid", "health", "persist_token",
  "persist_connection", "cleanup",
] as const;
const CHILD_PHASES = ["runtime_import", "state_creation", "plugin_preparation", "server_creation", "listen"] as const;
type ParentPhase = typeof PARENT_PHASES[number];
type ChildPhase = typeof CHILD_PHASES[number];
type ChildEvent = BackendStartupDiagnostics["child"]["phases"][number];
type HealthCheck = NonNullable<BackendStartupDiagnostics["lastHealthCheck"]>;
const HEALTH_OUTCOMES = ["ready", "http_error", "invalid_response", "not_ready", "identity_mismatch", "transport", "timeout", "unknown"];
const childStarted = performance.now();

// This dedicated child channel carries observations, never lifecycle authority.
export function reportBackendStartupPhase(phase: ChildPhase, event: "start" | "complete"): void {
  if (!process.send || !process.connected) return;
  const observation = { phase, event, elapsedMs: milliseconds(performance.now() - childStarted) };
  try {
    process.send({ type: MESSAGE_TYPE, version: 1, ...observation }, () => undefined);
    console.error(JSON.stringify({ type: MESSAGE_TYPE, version: 1, timestamp: new Date().toISOString(), pid: process.pid, ...observation }));
  } catch { /* A closed diagnostic channel must not prevent startup. */ }
}

export function createBackendStartupDiagnostics(timeoutMs: number) {
  const started = performance.now();
  const phases: BackendStartupDiagnostics["phases"] = [];
  const childPhases: ChildEvent[] = [];
  let current: { phase: ParentPhase; at: number } | undefined;
  let child: ChildProcess | undefined;
  let childObservation: BackendStartupDiagnostics["child"] | undefined;
  let healthCheckCount = 0;
  let lastHealthCheck: HealthCheck | undefined;
  const elapsed = () => milliseconds(performance.now() - started);
  const completePhase = () => {
    if (!current) return;
    const at = elapsed();
    phases.push({ phase: current.phase, elapsedMs: at, durationMs: Math.max(0, at - current.at) });
    current = undefined;
  };
  const observeChild = (): BackendStartupDiagnostics["child"] => ({
    ...(positiveInteger(child?.pid) ? { pid: child!.pid } : {}),
    exitObserved: child?.exitCode != null || child?.signalCode != null,
    ...(Number.isSafeInteger(child?.exitCode) ? { exitCode: child!.exitCode! } : {}),
    ...(safeSignal(child?.signalCode) ? { signal: child!.signalCode! } : {}),
    phases: childPhases.map((phase) => ({ ...phase })),
  });
  const onMessage = (message: unknown) => {
    if (!record(message) || message.type !== MESSAGE_TYPE || message.version !== 1) return;
    const observation = projectChildEvent(message);
    if (!observation || !nextChildEvent(childPhases, observation)) return;
    childPhases.push(observation);
  };
  return {
    phase(phase: ParentPhase) {
      completePhase();
      current = { phase, at: elapsed() };
    },
    attach(process: ChildProcess) {
      child = process;
      child.on("message", onMessage);
      child.channel?.unref();
    },
    healthCheckStarted() {
      healthCheckCount += 1;
      return elapsed();
    },
    healthCheckFinished(at: number, observation: Omit<HealthCheck, "elapsedMs" | "durationMs">) {
      const finished = elapsed();
      lastHealthCheck = { ...observation, elapsedMs: finished, durationMs: Math.max(0, finished - at) };
    },
    captureChild() {
      // Freeze before cleanup so our own SIGTERM is not mistaken for the cause.
      childObservation ??= observeChild();
    },
    finish(result: BackendServiceResult): BackendServiceResult {
      completePhase();
      return { ...result, startup: {
        version: 1,
        elapsedMs: elapsed(),
        healthTimeoutMs: Number.isFinite(timeoutMs) ? Math.max(0, Math.trunc(timeoutMs)) : 0,
        phases,
        healthCheckCount,
        ...(lastHealthCheck ? { lastHealthCheck } : {}),
        child: childObservation ?? observeChild(),
      } };
    },
    close() {
      child?.removeListener("message", onMessage);
      try { if (child?.connected) child.disconnect(); }
      catch { /* The child may already have closed its channel. */ }
    },
  };
}

export type BackendStartupTracker = ReturnType<typeof createBackendStartupDiagnostics>;

// Used both before persistence and when reading an untrusted diagnostic file.
export function projectBackendStartupDiagnostics(value: unknown): BackendStartupDiagnostics | undefined {
  if (!record(value) || value.version !== 1 || !nonnegative(value.elapsedMs)
    || !nonnegative(value.healthTimeoutMs) || !Number.isSafeInteger(value.healthCheckCount)
    || (value.healthCheckCount as number) < 0 || !Array.isArray(value.phases)
    || value.phases.length > PARENT_PHASES.length || !record(value.child)
    || typeof value.child.exitObserved !== "boolean" || !Array.isArray(value.child.phases)
    || value.child.phases.length > CHILD_PHASES.length * 2) return undefined;
  const phases: BackendStartupDiagnostics["phases"] = [];
  for (const phase of value.phases) {
    if (!record(phase) || !PARENT_PHASES.includes(phase.phase as ParentPhase)
      || !nonnegative(phase.elapsedMs) || !nonnegative(phase.durationMs)
      || phase.durationMs > phase.elapsedMs || phase.elapsedMs > value.elapsedMs
      || phase.elapsedMs < (phases.at(-1)?.elapsedMs ?? 0)) return undefined;
    phases.push({ phase: phase.phase as ParentPhase, elapsedMs: phase.elapsedMs, durationMs: phase.durationMs });
  }
  const childPhases: ChildEvent[] = [];
  for (const item of value.child.phases) {
    const phase = projectChildEvent(item);
    if (!phase || !nextChildEvent(childPhases, phase)) return undefined;
    childPhases.push(phase);
  }
  const child = value.child;
  if ((child.pid !== undefined && !positiveInteger(child.pid))
    || (child.exitCode !== undefined && !Number.isSafeInteger(child.exitCode))
    || (child.signal !== undefined && !safeSignal(child.signal))) return undefined;
  let lastHealthCheck: HealthCheck | undefined;
  if (value.lastHealthCheck !== undefined) {
    const check = value.lastHealthCheck;
    if (!record(check) || !HEALTH_OUTCOMES.includes(String(check.outcome))
      || !nonnegative(check.durationMs) || !nonnegative(check.elapsedMs)
      || check.durationMs > check.elapsedMs || check.elapsedMs > value.elapsedMs
      || (check.httpStatus !== undefined && (!Number.isInteger(check.httpStatus) || Number(check.httpStatus) < 100 || Number(check.httpStatus) > 599))
      || (check.systemCode !== undefined && (typeof check.systemCode !== "string" || !/^E[A-Z0-9_]{1,40}$/.test(check.systemCode)))) return undefined;
    lastHealthCheck = {
      outcome: check.outcome as HealthCheck["outcome"], durationMs: check.durationMs, elapsedMs: check.elapsedMs,
      ...(check.httpStatus === undefined ? {} : { httpStatus: check.httpStatus as number }),
      ...(check.systemCode === undefined ? {} : { systemCode: check.systemCode as string }),
    };
  }
  return {
    version: 1, elapsedMs: value.elapsedMs, healthTimeoutMs: value.healthTimeoutMs,
    phases, healthCheckCount: value.healthCheckCount as number,
    ...(lastHealthCheck ? { lastHealthCheck } : {}),
    child: {
      exitObserved: child.exitObserved as boolean,
      ...(child.pid === undefined ? {} : { pid: child.pid as number }),
      ...(child.exitCode === undefined ? {} : { exitCode: child.exitCode as number }),
      ...(child.signal === undefined ? {} : { signal: child.signal as string }),
      phases: childPhases,
    },
  };
}

export function backendStartupDiagnosticLines(startup: BackendStartupDiagnostics | undefined): string[] {
  if (!startup) return [];
  const last = startup.child.phases.at(-1);
  const health = startup.lastHealthCheck;
  return [
    `Startup: ${startup.elapsedMs}ms total; health budget ${startup.healthTimeoutMs}ms; ${startup.healthCheckCount} health checks.`,
    `Startup phases: ${startup.phases.map(({ phase, durationMs }) => `${phase}=${durationMs}ms`).join(", ")}.`,
    `Child startup: ${last ? `${last.phase} ${last.event} at ${last.elapsedMs}ms` : "no phase observed"}; ${startup.child.exitObserved ? `exit observed${startup.child.exitCode === undefined ? "" : ` (code ${startup.child.exitCode})`}${startup.child.signal ? ` (${startup.child.signal})` : ""}` : "exit not observed"} before cleanup.`,
    ...(health ? [`Last health check: ${health.outcome}${health.systemCode ? ` (${health.systemCode})` : ""}${health.httpStatus ? ` (HTTP ${health.httpStatus})` : ""}, ${health.durationMs}ms at ${health.elapsedMs}ms.`] : []),
  ];
}

function projectChildEvent(value: unknown): ChildEvent | undefined {
  if (!record(value) || !CHILD_PHASES.includes(value.phase as ChildPhase)
    || !["start", "complete"].includes(String(value.event)) || !nonnegative(value.elapsedMs)) return undefined;
  return { phase: value.phase as ChildPhase, event: value.event as ChildEvent["event"], elapsedMs: value.elapsedMs };
}

function nextChildEvent(previous: ChildEvent[], next: ChildEvent): boolean {
  const index = previous.length;
  return index < CHILD_PHASES.length * 2 && next.phase === CHILD_PHASES[Math.floor(index / 2)]
    && next.event === (index % 2 === 0 ? "start" : "complete")
    && next.elapsedMs >= (previous.at(-1)?.elapsedMs ?? 0);
}

function milliseconds(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function nonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function positiveInteger(value: unknown): value is number {
  return nonnegative(value) && value > 0;
}

function safeSignal(value: unknown): value is string {
  return typeof value === "string" && /^SIG[A-Z0-9]{1,16}$/.test(value);
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
