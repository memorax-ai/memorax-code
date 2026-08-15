import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  isTrialPowSolution,
  solveTrialPow,
  solveTrialPowSync,
  trialPowDigestHex,
  TrialPowError,
} from "../lib/trial-pow.mjs";

const GOLDEN_CHALLENGE = "memorax-pow-test-v1";
const GOLDEN_NONCE = "88405";
const GOLDEN_DIGEST = "000060049f79bb922397b4c7fdace37baf114ff97dbdc2f8aa98688d6762e413";

test("trial PoW matches the cross-service golden vector", () => {
  assert.equal(trialPowDigestHex(GOLDEN_CHALLENGE, GOLDEN_NONCE), GOLDEN_DIGEST);
  assert.equal(isTrialPowSolution(GOLDEN_CHALLENGE, 16, GOLDEN_NONCE), true);
  assert.equal(isTrialPowSolution(GOLDEN_CHALLENGE, 17, GOLDEN_NONCE), true);
  assert.equal(isTrialPowSolution(GOLDEN_CHALLENGE, 18, GOLDEN_NONCE), false);
  assert.equal(isTrialPowSolution(GOLDEN_CHALLENGE, 16, "88406"), false);
});

test("difficulty zero succeeds immediately with decimal nonce zero", () => {
  assert.equal(solveTrialPowSync(GOLDEN_CHALLENGE, 0), "0");
});

test("synchronous solver uses decimal nonces without skipping the golden solution", () => {
  assert.throws(
    () => solveTrialPowSync(GOLDEN_CHALLENGE, 16, { maxNonce: 88_404 }),
    (error) => error instanceof TrialPowError
      && error.code === "TRIAL_POW_FAILED"
      && error.reason === "search_exhausted",
  );
  assert.equal(
    solveTrialPowSync(GOLDEN_CHALLENGE, 16, { maxNonce: 88_405 }),
    GOLDEN_NONCE,
  );
});

test("worker solver keeps PoW off the caller event loop", async () => {
  let eventLoopAdvanced = false;
  const pending = solveTrialPow(GOLDEN_CHALLENGE, 16);
  await new Promise((resolve) => setImmediate(() => {
    eventLoopAdvanced = true;
    resolve();
  }));

  assert.equal(eventLoopAdvanced, true);
  assert.equal(await pending, GOLDEN_NONCE);
});

test("worker solver supports cancellation and terminates without returning a nonce", async () => {
  const controller = new AbortController();
  const pending = solveTrialPow(GOLDEN_CHALLENGE, 28, {
    signal: controller.signal,
    timeoutMs: 600_000,
  });
  controller.abort();

  await assert.rejects(
    pending,
    (error) => error instanceof TrialPowError
      && error.code === "TRIAL_POW_FAILED"
      && error.reason === "aborted",
  );

  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  await assert.rejects(
    solveTrialPow(GOLDEN_CHALLENGE, 28, {
      signal: alreadyAborted.signal,
      timeoutMs: 600_000,
    }),
    (error) => error instanceof TrialPowError && error.reason === "aborted",
  );
});

test("worker solver enforces its execution timeout", async () => {
  await assert.rejects(
    solveTrialPow(GOLDEN_CHALLENGE, 28, { timeoutMs: 1 }),
    (error) => error instanceof TrialPowError
      && error.code === "TRIAL_POW_FAILED"
      && error.reason === "timed_out",
  );
});

test("worker strips parent environment and exec arguments", () => {
  const guardSource = [
    'import { isMainThread } from "node:worker_threads";',
    'if (!isMainThread) throw new Error("inherited parent worker options");',
  ].join("");
  const guardUrl = `data:text/javascript,${encodeURIComponent(guardSource)}`;
  const moduleUrl = new URL("../lib/trial-pow.mjs", import.meta.url).href;
  const childSource = [
    `import { solveTrialPow } from ${JSON.stringify(moduleUrl)};`,
    `process.stdout.write(await solveTrialPow(${JSON.stringify(GOLDEN_CHALLENGE)}, 0));`,
  ].join("");
  const result = spawnSync(process.execPath, [
    `--import=${guardUrl}`,
    "--input-type=module",
    "--eval",
    childSource,
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_OPTIONS: `--import=${guardUrl}`,
    },
    timeout: 10_000,
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout, "0");
});

test("PoW inputs fail closed at the documented boundaries", async () => {
  assert.equal(
    trialPowDigestHex("x".repeat(1024), "9223372036854775807").length,
    64,
  );
  assert.equal(
    typeof isTrialPowSolution(GOLDEN_CHALLENGE, 28, "9223372036854775807"),
    "boolean",
  );

  for (const [operation, reason] of [
    [() => trialPowDigestHex("", "0"), "invalid_challenge"],
    [() => trialPowDigestHex("x".repeat(1025), "0"), "invalid_challenge"],
    [() => isTrialPowSolution("challenge", -1, "0"), "invalid_difficulty"],
    [() => isTrialPowSolution("challenge", 29, "0"), "invalid_difficulty"],
    [() => isTrialPowSolution("challenge", 1.5, "0"), "invalid_difficulty"],
    [() => isTrialPowSolution("challenge", 1, ""), "invalid_nonce"],
    [() => isTrialPowSolution("challenge", 1, "-1"), "invalid_nonce"],
    [() => isTrialPowSolution("challenge", 1, "+1"), "invalid_nonce"],
    [() => isTrialPowSolution("challenge", 1, "1.0"), "invalid_nonce"],
    [() => isTrialPowSolution("challenge", 1, "1e3"), "invalid_nonce"],
    [() => isTrialPowSolution("challenge", 1, " 1"), "invalid_nonce"],
    [() => isTrialPowSolution("challenge", 1, "00"), "invalid_nonce"],
    [() => isTrialPowSolution("challenge", 1, "9223372036854775808"), "invalid_nonce"],
    [() => solveTrialPowSync("challenge", 1, { maxNonce: -1 }), "invalid_options"],
    [() => solveTrialPowSync("challenge", 1, { maxNonce: 1.5 }), "invalid_options"],
    [() => solveTrialPowSync("challenge", 1, { maxNonce: 1n }), "invalid_options"],
  ]) {
    assert.throws(
      operation,
      (error) => error instanceof TrialPowError
        && error.code === "TRIAL_POW_FAILED"
        && error.reason === reason,
    );
  }

  await assert.rejects(
    solveTrialPow("challenge", 29),
    (error) => error instanceof TrialPowError && error.reason === "invalid_difficulty",
  );

  for (const timeoutMs of [0, -1, 1.5, 600_001, Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(
      solveTrialPow("challenge", 1, { timeoutMs }),
      (error) => error instanceof TrialPowError && error.reason === "invalid_options",
    );
  }
});
