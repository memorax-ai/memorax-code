#!/usr/bin/env node
import { createRequire } from "node:module";
import { chmod, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { assertCredentialNotEchoed } from "./codex-lifecycle-assertions.mjs";
import { projectTerminalDisposal } from "./codex-setup-pty-evidence.mjs";

// A real PTY is required here: piped answers and ASSUME_INTERACTIVE fixtures do
// not exercise masked input, Ctrl-C, or native terminal detection.
const report = { status: "FAIL", evidence: "native_terminal", platform: process.platform,
  terminalDisposal: { status: "not-created", exitObserved: false } };
let terminal;
let timeout;
let output = "";
let input;
let errorCode;
let cursorReports = 0;
let outputBytes = 0;
let inputTimeout;
let exitObserved = false;
let exitResult;
let settleExit;
let disposalAttempted = false;
let finished = false;
const outputLimit = 2 * 1024 * 1024;
try {
  check(process.argv.length === 5, "EXPECTED_PTY_ROOT_ENTRYPOINT_AND_MODE");
  const [, , dependencyRoot, entrypoint, mode] = process.argv;
  check(["complete", "cancel", "reuse", "update", "force-update"].includes(mode), "INVALID_TERMINAL_CASE");
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk;
    check(raw.length < 4096, "TERMINAL_INPUT_TOO_LARGE");
  }
  input = JSON.parse(raw);
  check(typeof input.username === "string" && /^[a-z][a-z0-9-]{1,40}$/.test(input.username), "INVALID_FIXTURE_USERNAME");
  check(typeof input.apiKey === "string" && /^sk_[A-Za-z0-9]{43}$/.test(input.apiKey), "INVALID_FIXTURE_KEY");
  const require = createRequire(join(resolve(dependencyRoot), "package.json"));
  check(require("node-pty/package.json").version === "1.1.0", "UNEXPECTED_PTY_DEPENDENCY_VERSION");
  if (process.platform === "darwin") {
    // The pinned package's macOS prebuild can arrive without its executable bit.
    // This is the disposable test dependency, not a user or product executable.
    const helper = join(dirname(require.resolve("node-pty/package.json")), "prebuilds", `darwin-${process.arch}`, "spawn-helper");
    const info = await stat(helper);
    check(info.isFile(), "PTY_SPAWN_HELPER_NOT_A_FILE");
    if (!(info.mode & 0o100)) await chmod(helper, info.mode | 0o100);
  }
  const { spawn } = require("node-pty");
  const env = { ...process.env, TERM: "xterm-256color" };
  delete env.MEMORAX_CODE_SETUP_ASSUME_INTERACTIVE;
  const isUpdate = mode === "update" || mode === "force-update";
  const args = isUpdate ? ["update", "--latest", ...(mode === "force-update" ? ["--force"] : [])]
    : mode === "reuse" ? ["setup"] : ["setup", "--existing-account"];
  terminal = spawn(process.execPath, [resolve(entrypoint), ...args], {
    name: "xterm-256color", cols: 120, rows: 40, cwd: process.cwd(), env,
  });
  Object.assign(report, { mode, usernamePromptSeen: false, keyPromptSeen: false, languagePromptSeen: false,
    accountInputSent: false });
  const exited = new Promise((done) => {
    settleExit = done;
    terminal.onExit((result) => {
      if (exitObserved) return;
      exitObserved = true;
      exitResult = result;
      done();
    });
    terminal.onData((chunk) => {
      if (finished || errorCode) return;
      outputBytes = Math.min(Number.MAX_SAFE_INTEGER, outputBytes + Buffer.byteLength(chunk));
      const available = outputLimit - output.length;
      output += chunk.slice(0, available);
      if (chunk.length > available) {
        abortTerminal("TERMINAL_OUTPUT_LIMIT_EXCEEDED");
        return;
      }
      // ConPTY and readline use terminal control sequences during repainting.
      // Answer cursor-position queries as a terminal and match visible prompts.
      // ConPTY may represent a trailing blank as cursor motion, not text.
      const queries = output.split("\x1b[6n").length - 1;
      while (cursorReports < queries && cursorReports < 8) {
        cursorReports += 1;
        writeTerminal("\x1b[1;1R");
      }
      const visible = stripVTControlCharacters(output);
      if ((mode === "reuse" || isUpdate) && (/Username[^\r\n]*:/.test(visible)
        || visible.includes("MemoraX API key:") || visible.includes("Preferred language [ZH/en]")
        || visible.includes("Connect MemoraX Code to MemoraX now")
        || visible.includes("Use the saved connection and memory preferences"))) {
        abortTerminal("SAVED_ACCOUNT_UNEXPECTEDLY_REQUESTED_INPUT");
        return;
      }
      // These are exact product prompt contracts, not a semantic success judge.
      if (!report.usernamePromptSeen && /Username from your existing MemoraX Code setup[^\r\n]*:/.test(visible)) {
        report.usernamePromptSeen = true;
        report.accountInputSent = true;
        writeTerminal(`${input.username}\r`);
      }
      if (!report.languagePromptSeen && visible.includes("Preferred language [ZH/en] (used for Memory extraction):")) {
        report.languagePromptSeen = true;
        writeTerminal("en\r");
      }
      if (!report.keyPromptSeen && visible.includes("MemoraX API key:")) {
        report.keyPromptSeen = true;
        // Allow the child to finish enabling raw masked input after the prompt.
        inputTimeout = setTimeout(() => writeTerminal(mode === "cancel" ? "\x03" : `${input.apiKey}\r`), 30);
      }
    });
  });
  timeout = setTimeout(() => abortTerminal("TERMINAL_CASE_TIMEOUT"), 110_000);
  await exited;
  clearTimeout(timeout);
  if (exitObserved) {
    report.exitCode = exitResult?.exitCode;
    report.signal = exitResult?.signal ?? 0;
  }
  check(!errorCode, errorCode);
  check(Number.isInteger(report.exitCode) && Number.isInteger(report.signal), "INVALID_TERMINAL_EXIT_STATUS");
  if (mode === "complete" || mode === "cancel") {
    check(report.usernamePromptSeen && report.keyPromptSeen, "EXPECTED_INTERACTIVE_PROMPTS_NOT_OBSERVED");
  }
  if (mode === "reuse") check(!report.accountInputSent && !report.usernamePromptSeen
    && !report.keyPromptSeen && !report.languagePromptSeen, "SAVED_ACCOUNT_RECEIVED_TEST_INPUT");
  try { assertCredentialNotEchoed(output, input.apiKey); }
  catch { check(false, "TERMINAL_DISCLOSED_FIXTURE_CREDENTIAL"); }
  const plainOutput = stripVTControlCharacters(output);
  if (mode === "complete") check(plainOutput.includes("*".repeat(input.apiKey.length)), "MASKED_KEY_INPUT_NOT_OBSERVED");
  check(mode === "cancel" ? report.exitCode !== 0 || report.signal > 0
    : report.exitCode === 0 && report.signal === 0, "UNEXPECTED_TERMINAL_EXIT_CODE");
  Object.assign(report, { status: "PASS",
    credentialNotEchoed: true, maskedInputObserved: mode === "complete", cancellationSent: mode === "cancel" });
} catch (error) {
  report.error = error.testCode ?? "TERMINAL_CHECK_FAILED_PRIVATE_OUTPUT_SUPPRESSED";
  if (["ENOENT", "ENOEXEC", "EACCES", "EPERM"].includes(error.code)) report.nativeErrorCode = error.code;
  if (error.message === "posix_spawnp failed.") report.nativeErrorCode = "PTY_SPAWN_FAILED";
} finally {
  finished = true;
  clearTimeout(timeout);
  clearTimeout(inputTimeout);
  disposeTerminal();
  report.exitObserved = exitObserved;
  report.outputBytes = outputBytes;
  report.cursorPositionReplies = cursorReports;
}
console.log(JSON.stringify(report));
if (report.status !== "PASS") process.exitCode = 1;

function abortTerminal(code) {
  errorCode ??= code;
  disposeTerminal();
  // A failed kill cannot be relied on to emit onExit. Preserve the first failure
  // and produce a report within the existing helper deadline in either case.
  settleExit?.();
}

function writeTerminal(value) {
  if (finished || errorCode || exitObserved) return;
  try { terminal.write(value); }
  catch { abortTerminal("TERMINAL_INPUT_WRITE_FAILED"); }
}

function disposeTerminal() {
  if (!terminal || disposalAttempted) return;
  if (process.platform !== "win32" && exitObserved) {
    // node-pty 1.1.0 emits POSIX exit after socket close. Its kill only signals
    // the PID, whose lifetime has ended; a second signal could hit a reused PID.
    report.terminalDisposal = { status: "not-required-after-exit", exitObserved: true };
    return;
  }
  disposalAttempted = true;
  const observedBeforeCall = exitObserved;
  try {
    // Windows still needs ConPTY/worker disposal after shell exit. A returned
    // call records the API outcome; it is not proof that every handle is closed.
    terminal.kill();
    report.terminalDisposal = { status: "returned", exitObserved: observedBeforeCall };
  } catch (error) {
    report.terminalDisposal = projectTerminalDisposal({ status: "failed", exitObserved: observedBeforeCall,
      systemCode: error?.code });
    errorCode ??= "PTY_RESOURCE_DISPOSE_FAILED";
    report.error ??= errorCode;
    report.status = "FAIL";
  }
}

function check(condition, code) {
  if (!condition) throw Object.assign(new Error(code), { testCode: code });
}
