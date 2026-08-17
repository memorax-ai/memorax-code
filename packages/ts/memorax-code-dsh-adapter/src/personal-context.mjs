import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const workerPath = fileURLToPath(new URL("./personal-context-worker.mjs", import.meta.url));

/** Load local personal-memory context without blocking the resident DSH process. */
export function loadDshPersonalContext(input, options = {}) {
  const cwd = nonEmptyString(input?.cwd);
  const includeProfile = input?.includeProfile === true;
  const includeProcedure = input?.includeProcedure === true;
  if (!cwd) throw new TypeError("DSH personal context requires cwd");
  if (!includeProfile && !includeProcedure) return Promise.resolve({});

  const signal = options.signal;
  signal?.throwIfAborted();
  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const executable = nonEmptyString(options.nodePath) ?? process.execPath;
  const path = nonEmptyString(options.workerPath) ?? workerPath;
  const spawnImpl = options.spawnImpl ?? spawn;

  return new Promise((resolve, reject) => {
    const child = spawnImpl(executable, [path], {
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    const output = [];
    let outputBytes = 0;
    let settled = false;
    let timer;

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(value);
    };
    const terminate = (error) => {
      if (child.exitCode === null && !child.killed) child.kill();
      finish(error);
    };
    const onAbort = () => terminate(abortError(signal));

    timer = setTimeout(() => {
      terminate(new Error(`DSH personal context worker timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });

    child.once("error", (error) => finish(error));
    child.stdout.on("data", (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += bytes.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        terminate(new Error("DSH personal context worker output exceeded its limit"));
        return;
      }
      output.push(bytes);
    });
    child.stdout.once("error", (error) => terminate(error));
    child.once("close", (code, closeSignal) => {
      if (settled) return;
      if (code !== 0) {
        finish(new Error(`DSH personal context worker exited with ${code ?? closeSignal ?? "unknown status"}`));
        return;
      }
      try {
        finish(undefined, parseWorkerOutput(Buffer.concat(output).toString("utf8")));
      } catch (error) {
        finish(error);
      }
    });
    child.stdin.once("error", (error) => terminate(error));
    child.stdin.end(`${JSON.stringify({ cwd, includeProfile, includeProcedure })}\n`);
  });
}

function parseWorkerOutput(output) {
  const value = JSON.parse(output);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("DSH personal context worker returned an invalid result");
  }
  const profileContext = optionalString(value.profileContext, "profileContext");
  const procedureContext = optionalString(value.procedureContext, "procedureContext");
  return {
    ...(profileContext ? { profileContext } : {}),
    ...(procedureContext ? { procedureContext } : {}),
  };
}

function optionalString(value, name) {
  if (value === undefined) return undefined;
  const normalized = nonEmptyString(value);
  if (!normalized) throw new Error(`DSH personal context worker returned invalid ${name}`);
  return normalized;
}

function abortError(signal) {
  return signal?.reason instanceof Error ? signal.reason : new Error("DSH personal context worker aborted");
}

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
