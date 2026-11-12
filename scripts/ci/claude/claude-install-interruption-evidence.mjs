import { boundedInt, code, compact, projectError, systemCode } from "../shared/ci-evidence-projections.mjs";
import { createSetupTerminalObservation } from "../codex/codex-install-interruption-evidence.mjs";
import { collectInstallProductDiagnostics } from "./claude-install-evidence.mjs";

export function interruptionCode(error) {
  return code(error?.testCode) ?? code(error?.nativeCode) ?? systemCode(error?.code)
    ?? code(error?.message?.match(/^PROTECTED_[A-Z_]+/)?.[0])
    ?? "INTERRUPTION_CHECK_FAILED_PRIVATE_OUTPUT_SUPPRESSED";
}

function projectedFailure(error) {
  return { code: interruptionCode(error), error: projectError(error) };
}

// Keep the observer's first failure separate from errors disposing its PTY.
export function observeInterruptionTerminal(tracked) {
  const observation = createSetupTerminalObservation();
  let firstError, cleanupError;
  const terminal = {
    ...tracked,
    observation,
    exited: tracked.exited.then((event) => { observation.exit(event); return event; }),
    async stop() {
      try { await tracked.stop(); observation.dispose(true); }
      catch (error) { cleanupError ??= error; observation.dispose(false); throw error; }
    },
    fail(error) {
      firstError ??= error;
      void terminal.stop().catch(() => {});
    },
    verify() { if (firstError) throw firstError; },
    snapshot() {
      return compact({ ...observation.snapshot(),
        firstError: firstError ? projectedFailure(firstError) : undefined,
        cleanupError: cleanupError ? projectedFailure(cleanupError) : undefined });
    },
  };
  return terminal;
}

export function waitForInterruptionStage(gateReached, terminal) {
  return Promise.race([gateReached, terminal.exited.then(() => {
    terminal.verify();
    throw Object.assign(new Error("SETUP_EXITED_BEFORE_INTERRUPTION_STAGE"), {
      testCode: "SETUP_EXITED_BEFORE_INTERRUPTION_STAGE",
    });
  })]);
}

export function recordInterruptionFailure(result, stage, error, { cleanup = false } = {}) {
  const failure = { stage, ...projectedFailure(error) };
  if (cleanup) {
    (result.cleanupFailures ??= []).push(failure);
    if (!result.cleanup || result.cleanup === "PASS") result.cleanup = failure.code;
    result.status = "FAIL";
  } else {
    result.firstFailure ??= failure;
    result.errors.push(failure.code);
  }
  return failure;
}

// Gate input can contain process identities. Only these fixed observations leave the runner.
export function createInterruptionGateObservation() {
  const state = { startCount: 0, statusCount: 0, command: null, stage: "idle",
    backendRecord: "not-observed", health: "not-probed", httpStatus: null, identityMatched: null, errorCode: null };
  let firstError;
  const allowedErrors = new Set(["DEPENDENCY_GATE_REQUEST_TOO_LARGE", "DEPENDENCY_GATE_REQUEST_INVALID", "BACKEND_RECORD_INVALID"]);
  return {
    request(command) {
      if (!["start", "status"].includes(command)) return;
      state[command + "Count"] = Math.min(1000, state[command + "Count"] + 1);
      Object.assign(state, { command, stage: "record", backendRecord: "not-observed",
        health: "not-probed", httpStatus: null, identityMatched: null, errorCode: null });
    },
    record(value) { if (["absent", "valid", "invalid"].includes(value)) state.backendRecord = value; },
    response(value) { state.httpStatus = boundedInt(value?.status, 100, 599) ?? null; },
    probingHealth() { state.stage = "health"; },
    health(response, body, identityMatched) {
      state.httpStatus = boundedInt(response?.status, 100, 599) ?? null;
      state.identityMatched = typeof identityMatched === "boolean" ? identityMatched : null;
      state.health = response?.ok === true && body?.ok === true && identityMatched === true ? "matched" : "not-matched";
    },
    stage(value) { if (["request", "record", "health", "config", "held", "continued"].includes(value)) state.stage = value; },
    fail(error) {
      if (state.stage === "record") state.backendRecord = error?.name === "SyntaxError" || error?.testCode === "BACKEND_RECORD_INVALID" ? "invalid" : "unreadable";
      if (state.stage === "health") state.health = "error";
      state.errorCode = systemCode(error?.code) ?? systemCode(error?.cause?.code)
        ?? (allowedErrors.has(error?.testCode) ? error.testCode : "DEPENDENCY_GATE_OBSERVATION_FAILED");
      firstError ??= { stage: state.stage, code: state.errorCode };
    },
    snapshot() { return compact({ ...state, firstError }); },
  };
}

export async function collectInterruptionDiagnostics(evidence, phase, harness) {
  if (!harness) return { status: "UNAVAILABLE" };
  const collected = await evidence.collect(phase + ".productDiagnostics",
    () => collectInstallProductDiagnostics(harness.stateHome));
  return collected.status === "OK" ? { status: "OK", ...collected.value } : collected;
}
