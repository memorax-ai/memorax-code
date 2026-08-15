import { createHash } from "node:crypto";
import {
  isMainThread,
  parentPort,
  Worker,
  workerData,
} from "node:worker_threads";

const MAX_CHALLENGE_LENGTH = 1024;
const MAX_DIFFICULTY_BITS = 28;
const MAX_NONCE = 9_223_372_036_854_775_807n;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 600_000;
const WORKER_PROTOCOL = "memorax-trial-pow-v1";
const ERROR_REASONS = new Set([
  "invalid_challenge",
  "invalid_difficulty",
  "invalid_nonce",
  "invalid_options",
  "search_exhausted",
  "aborted",
  "timed_out",
  "worker_failed",
]);

export class TrialPowError extends Error {
  constructor(reason) {
    const safeReason = ERROR_REASONS.has(reason) ? reason : "worker_failed";
    super(`Trial PoW failed (${safeReason})`);
    this.name = "TrialPowError";
    this.code = "TRIAL_POW_FAILED";
    this.reason = safeReason;
  }
}

export function trialPowDigestHex(powChallenge, powNonce) {
  return trialPowDigest(powChallenge, powNonce).toString("hex");
}

export function isTrialPowSolution(powChallenge, difficultyBits, powNonce) {
  const bits = validateDifficulty(difficultyBits);
  const digest = trialPowDigest(powChallenge, powNonce);
  return hasLeadingZeroBits(digest, bits);
}

export function solveTrialPowSync(powChallenge, difficultyBits, options = {}) {
  const challenge = validateChallenge(powChallenge);
  const bits = validateDifficulty(difficultyBits);
  const maxNonce = options?.maxNonce ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(maxNonce) || maxNonce < 0) {
    throw new TrialPowError("invalid_options");
  }

  for (let nonce = 0; nonce <= maxNonce; nonce += 1) {
    const decimalNonce = String(nonce);
    const digest = createHash("sha256")
      .update(challenge, "utf8")
      .update(decimalNonce, "utf8")
      .digest();
    if (hasLeadingZeroBits(digest, bits)) return decimalNonce;
  }
  throw new TrialPowError("search_exhausted");
}

export async function solveTrialPow(powChallenge, difficultyBits, options = {}) {
  const challenge = validateChallenge(powChallenge);
  const bits = validateDifficulty(difficultyBits);
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new TrialPowError("invalid_options");
  }
  const signal = options?.signal;
  if (signal?.aborted) throw new TrialPowError("aborted");

  let worker;
  try {
    worker = new Worker(new URL(import.meta.url), {
      env: {},
      execArgv: [],
      workerData: {
        protocol: WORKER_PROTOCOL,
        powChallenge: challenge,
        difficultyBits: bits,
      },
    });
  } catch {
    throw new TrialPowError("worker_failed");
  }

  return await new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => finish(undefined, new TrialPowError("timed_out")), timeoutMs);
    timeout.unref?.();

    const onAbort = () => finish(undefined, new TrialPowError("aborted"));
    const onMessage = (message) => {
      const nonce = message?.protocol === WORKER_PROTOCOL ? message.nonce : undefined;
      if (typeof nonce !== "string"
        || !isTrialPowSolutionSafely(challenge, bits, nonce)) {
        finish(undefined, new TrialPowError("worker_failed"));
        return;
      }
      finish(nonce);
    };
    const onError = () => finish(undefined, new TrialPowError("worker_failed"));
    const onExit = (code) => {
      if (!settled && code !== 0) finish(undefined, new TrialPowError("worker_failed"));
      else if (!settled) finish(undefined, new TrialPowError("worker_failed"));
    };

    function finish(value, error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener?.("abort", onAbort);
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
      terminateWorker(worker);
      if (error) reject(error);
      else resolve(value);
    }

    signal?.addEventListener?.("abort", onAbort, { once: true });
    worker.once("message", onMessage);
    worker.once("error", onError);
    worker.once("exit", onExit);
    if (signal?.aborted) onAbort();
  });
}

function terminateWorker(worker) {
  try {
    const pending = worker.terminate();
    if (pending && typeof pending.then === "function") {
      Promise.resolve(pending).catch(() => undefined);
    }
  } catch {
    // Termination is best effort after the public result has already been fixed.
  }
}

function trialPowDigest(powChallenge, powNonce) {
  const challenge = validateChallenge(powChallenge);
  const nonce = validateNonce(powNonce);
  return createHash("sha256")
    .update(challenge, "utf8")
    .update(nonce, "utf8")
    .digest();
}

function validateChallenge(value) {
  if (typeof value !== "string"
    || value.length === 0
    || value.length > MAX_CHALLENGE_LENGTH) {
    throw new TrialPowError("invalid_challenge");
  }
  return value;
}

function validateDifficulty(value) {
  if (!Number.isInteger(value) || value < 0 || value > MAX_DIFFICULTY_BITS) {
    throw new TrialPowError("invalid_difficulty");
  }
  return value;
}

function validateNonce(value) {
  if (typeof value !== "string"
    || !/^(?:0|[1-9][0-9]{0,18})$/.test(value)) {
    throw new TrialPowError("invalid_nonce");
  }
  try {
    if (BigInt(value) > MAX_NONCE) throw new TrialPowError("invalid_nonce");
  } catch (error) {
    if (error instanceof TrialPowError) throw error;
    throw new TrialPowError("invalid_nonce");
  }
  return value;
}

function hasLeadingZeroBits(digest, difficultyBits) {
  const wholeBytes = Math.floor(difficultyBits / 8);
  for (let index = 0; index < wholeBytes; index += 1) {
    if (digest[index] !== 0) return false;
  }
  const remainingBits = difficultyBits % 8;
  if (remainingBits === 0) return true;
  const mask = (0xff << (8 - remainingBits)) & 0xff;
  return (digest[wholeBytes] & mask) === 0;
}

function isTrialPowSolutionSafely(challenge, bits, nonce) {
  try {
    return isTrialPowSolution(challenge, bits, nonce);
  } catch {
    return false;
  }
}

if (!isMainThread && workerData?.protocol === WORKER_PROTOCOL && parentPort) {
  try {
    const nonce = solveTrialPowSync(workerData.powChallenge, workerData.difficultyBits);
    parentPort.postMessage({ protocol: WORKER_PROTOCOL, nonce });
  } catch {
    parentPort.postMessage({ protocol: WORKER_PROTOCOL, failed: true });
  }
}
