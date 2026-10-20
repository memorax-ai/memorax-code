import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify, stripVTControlCharacters } from "node:util";
import { boundedInt, projectProductDiagnostics } from "../shared/ci-evidence-projections.mjs";

const execFileAsync = promisify(execFile);
const productStages = [
  ["Checking local setup state...", "preflight"],
  ["Reusing the existing MemoraX connection and memory preferences.", "saved-connection"],
  ["MemoraX Code Codex Adapter hooks activated and trusted.", "codex-hooks-activated"],
  ["Starting backend with \x60memorax-code start\x60...", "backend-start"],
  ["Attempting automatic recovery: \x60memorax-code stop\x60 then \x60memorax-code start\x60...", "backend-recovery"],
  ["Backend start completed after automatic recovery.", "backend-recovered"],
  ["Backend start completed.", "backend-started"],
  ["Checking backend status with \x60memorax-code status\x60...", "backend-status"],
  ["Setup completed successfully.", "completed"],
];

// This observes delivery to the PTY callback. An exit event does not establish
// that every output byte was delivered; late bytes stay separate from the exit snapshot.
export function createSetupTerminalObservation({ now = () => performance.now() } = {}) {
  const started = now();
  let tail = "", outputBytes = 0, outputAfterExitBytes = 0, lastProductStage = null;
  let exitObserved = false, exitCode = null, signal = null, exitElapsedMs = null, lastOutputElapsedMs = null;
  let disposal = "not-requested";
  const elapsed = () => boundedInt(Math.round(now() - started), 0, 1_000_000_000) ?? null;
  return {
    output(chunk) {
      if (typeof chunk !== "string") return;
      const bytes = Buffer.byteLength(chunk, "utf8");
      outputBytes = Math.min(1_000_000_000, outputBytes + bytes);
      if (exitObserved) outputAfterExitBytes = Math.min(1_000_000_000, outputAfterExitBytes + bytes);
      lastOutputElapsedMs = elapsed();
      const visible = stripVTControlCharacters(tail + chunk);
      let last = -1;
      for (const [marker, stage] of productStages) {
        const index = visible.lastIndexOf(marker);
        if (index > last) { last = index; lastProductStage = stage; }
      }
      tail = visible.slice(-512);
    },
    exit(event) {
      if (exitObserved) return;
      exitObserved = true;
      exitCode = boundedInt(event?.exitCode, -2147483648, 4294967295) ?? null;
      signal = boundedInt(event?.signal, 0, 255) ?? null;
      exitElapsedMs = elapsed();
    },
    dispose(succeeded) { disposal = succeeded ? "succeeded" : "failed"; },
    snapshot() {
      return { exitObserved, exitCode, signal, outputBytes, outputAfterExitBytes, lastProductStage,
        lastOutputElapsedMs, exitElapsedMs, disposal };
    },
  };
}

// The product validates its local records; the shared projection drops free text
// and identities before either the journal or runner report receives them.
export async function collectSetupProductDiagnostics(evidence, phase, harness, { run = execFileAsync } = {}) {
  if (!harness) return { status: "UNAVAILABLE" };
  const collected = await evidence.collect(phase + ".productDiagnostics", async () => {
    const result = await run(process.execPath,
      [join(harness.packageRoot, "bin", "memorax-code.mjs"), "logs", "--diagnostics", "--limit", "20", "--json"],
      { cwd: harness.workspace, env: harness.env, timeout: 15_000, maxBuffer: 1024 * 1024,
        encoding: "utf8", windowsHide: true })
      .catch((error) => { if (/^\s*\{/.test(error.stdout ?? "")) return error; throw error; });
    return projectProductDiagnostics(JSON.parse(result.stdout));
  }, { budgetMs: 20_000 });
  return collected.status === "OK" ? { status: "OK", ...collected.value } : collected;
}

export function interruptionFailureEvidence(report) {
  if (report.status === "PASS") return undefined;
  const failed = report.cases.find((item) => item.firstFailure)?.firstFailure;
  const cleanup = report.cases.find((item) => item.cleanupFailures?.length)?.cleanupFailures[0];
  const functional = failed ?? (report.error ? { stage: report.failureStage ?? "prerequisites", code: report.error } : undefined);
  return {
    kind: functional ? (cleanup ? "functional+cleanup" : "functional") : "cleanup",
    stage: functional?.stage, code: functional?.code ?? cleanup?.code,
    cleanupStage: cleanup?.stage, cleanupCode: cleanup?.code,
  };
}
