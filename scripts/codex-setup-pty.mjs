#!/usr/bin/env node
import { createRequire } from "node:module";
import { chmod, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { assertCredentialNotEchoed } from "./codex-lifecycle-assertions.mjs";

// A real PTY is required here: piped answers and ASSUME_INTERACTIVE fixtures do
// not exercise masked input, Ctrl-C, or native terminal detection.
const report = { status: "FAIL", evidence: "native_terminal", platform: process.platform };
let terminal;
let timeout;
let output = "";
let input;
let errorCode;
let cursorReports = 0;
try {
  check(process.argv.length === 5, "EXPECTED_PTY_ROOT_ENTRYPOINT_AND_MODE");
  const [, , dependencyRoot, entrypoint, mode] = process.argv;
  check(["complete", "cancel", "update", "force-update"].includes(mode), "INVALID_TERMINAL_CASE");
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
    : ["setup", "--existing-account"];
  terminal = spawn(process.execPath, [resolve(entrypoint), ...args], {
    name: "xterm-256color", cols: 120, rows: 40, cwd: process.cwd(), env,
  });
  Object.assign(report, { mode, usernamePromptSeen: false, keyPromptSeen: false, languagePromptSeen: false });
  const exited = new Promise((done) => {
    terminal.onData((chunk) => {
      output += chunk;
      if (output.length > 2 * 1024 * 1024) {
        errorCode = "TERMINAL_OUTPUT_LIMIT_EXCEEDED";
        terminal.kill();
        return;
      }
      // ConPTY and readline use terminal control sequences during repainting.
      // Answer cursor-position queries as a terminal and match visible prompts.
      // ConPTY may represent a trailing blank as cursor motion, not text.
      const queries = output.split("\x1b[6n").length - 1;
      while (cursorReports < queries && cursorReports < 8) {
        cursorReports += 1;
        terminal.write("\x1b[1;1R");
      }
      const visible = stripVTControlCharacters(output);
      // These are exact product prompt contracts, not a semantic success judge.
      if (!report.usernamePromptSeen && /Username from your existing MemoraX Code setup[^\r\n]*:/.test(visible)) {
        report.usernamePromptSeen = true;
        terminal.write(`${input.username}\r`);
      }
      if (!report.languagePromptSeen && visible.includes("Preferred language [ZH/en] (used for Memory extraction):")) {
        report.languagePromptSeen = true;
        terminal.write("en\r");
      }
      if (!report.keyPromptSeen && visible.includes("MemoraX API key:")) {
        report.keyPromptSeen = true;
        // Allow the child to finish enabling raw masked input after the prompt.
        setTimeout(() => terminal.write(mode === "cancel" ? "\x03" : `${input.apiKey}\r`), 30);
      }
    });
    terminal.onExit(done);
  });
  timeout = setTimeout(() => { errorCode = "TERMINAL_CASE_TIMEOUT"; terminal.kill(); }, 110_000);
  const result = await exited;
  clearTimeout(timeout);
  report.exitCode = result.exitCode;
  report.signal = result.signal ?? 0;
  check(Number.isInteger(report.exitCode) && Number.isInteger(report.signal), "INVALID_TERMINAL_EXIT_STATUS");
  check(!errorCode, errorCode);
  if (!isUpdate) check(report.usernamePromptSeen && report.keyPromptSeen, "EXPECTED_INTERACTIVE_PROMPTS_NOT_OBSERVED");
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
  clearTimeout(timeout);
  report.outputBytes = Buffer.byteLength(output);
  report.cursorPositionReplies = cursorReports;
  if (terminal) { try { terminal.kill(); } catch {} }
}
console.log(JSON.stringify(report));
if (report.status !== "PASS") process.exitCode = 1;

function check(condition, code) {
  if (!condition) throw Object.assign(new Error(code), { testCode: code });
}
