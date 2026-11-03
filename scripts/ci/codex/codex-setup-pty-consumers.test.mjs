import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { projectTerminalDisposal } from "./codex-setup-pty-evidence.mjs";

const privateText = "sk_private_CANARY /private/user/terminal.log C:\\private\\credential";
const consumers = [
  ["Claude", "../claude/claude-install-smoke.mjs"],
  ["CodeBuddy and WorkBuddy", "../codebuddy-workbuddy/codebuddy-lifecycle-check.mjs"],
  ["OpenCode", "../opencode/opencode-install-smoke.mjs"],
  ["Cursor", "../cursor/cursor-lifecycle-check.mjs"],
];
const failedDisposal = { status: "failed", exitObserved: true, errorCode: "PTY_RESOURCE_DISPOSE_FAILED", systemCode: "EIO" };

for (const [client, path] of consumers) {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  const isCursor = client === "Cursor";
  const start = source.indexOf(isCursor ? "  async function terminal(mode) {" : "async function terminalSetup(mode) {");
  const end = source.indexOf(isCursor ? "  async function prepareHome(name) {" : "async function verifySavedAccountSearch(label) {", start);
  assert.ok(start >= 0 && end > start, client + " terminal function must be tested from live source");
  const terminalSource = source.slice(start, end).trim();
  assert.match(source, /import \{ projectTerminalDisposal \} from "\.\.\/codex\/codex-setup-pty-evidence\.mjs";/);
  const catchStart = source.indexOf("} catch (error) {", source.indexOf('  report.status = "PASS";'));
  const catchEnd = source.indexOf("} finally {", catchStart);
  assert.ok(catchStart >= 0 && catchEnd > catchStart);
  const failureSource = source.slice(catchStart + "} catch (error) {".length, catchEnd);

  function fixture(run) {
    const report = { status: "FAIL" }, env = {};
    const context = { report, env, run, join, JSON, projectTerminalDisposal, stage: "terminal setup",
      root: "/synthetic/root", savedEndpoint: "http://127.0.0.1:1", entrypoint: "/synthetic/product.mjs",
      ptyScript: "/synthetic/pty.mjs", ptyPackage: "/synthetic/node-pty", fixtureUser: "synthetic-user",
      fixtureKey: "synthetic-key", process: { execPath: "/synthetic/node" },
      check(value, code) { assert.ok(value, code); },
      installEvidence: { fail() { return { code: "EXPECTED_TERMINAL_FAILURE" }; } },
    };
    return { report, env, terminal: runInNewContext("(" + terminalSource + ")", context),
      fail: runInNewContext("(function(error) {" + failureSource + "})", context) };
  }

  for (const errorCode of ["EXPECTED_INTERACTIVE_PROMPTS_NOT_OBSERVED", "PTY_RESOURCE_DISPOSE_FAILED"]) {
    test(client + " keeps " + errorCode + " and terminal disposal failure while rejecting the helper exit", async () => {
      const original = Object.assign(new Error(privateText), {
        code: 1, testCode: "INSTALL_TERMINAL_CLEANUP_UNVERIFIED", cleanupFailed: true,
        stdout: JSON.stringify({ status: "FAIL", error: errorCode, outputBytes: 42,
          terminalDisposal: { ...failedDisposal, message: privateText, stdout: privateText, pid: 456789 },
          path: privateText, stderr: privateText }),
      });
      let calls = 0;
      const subject = fixture(async () => {
        calls += 1;
        assert.equal(subject.env.MEMORAX_CODE_MEMORAX_ENDPOINT, "http://127.0.0.1:1");
        throw original;
      });
      await assert.rejects(subject.terminal("complete"), (error) => error === original);
      subject.fail(original);
      assert.equal(calls, 1);
      assert.equal(subject.report.status, "FAIL");
      assert.equal(subject.report.terminalError, errorCode);
      assert.deepEqual(subject.report.terminalDisposal, failedDisposal);
      assert.equal(subject.env.MEMORAX_CODE_MEMORAX_ENDPOINT, undefined);
      assert.doesNotMatch(JSON.stringify(subject.report), /CANARY|456789|terminal\.log|credential/);
    });
  }

  test(client + " drops untyped terminal disposal fields without replacing the original failure", async () => {
    const original = Object.assign(new Error(privateText), {
      code: 1, stdout: JSON.stringify({ status: "FAIL", error: "UNEXPECTED_TERMINAL_EXIT_CODE",
        terminalDisposal: { status: privateText, exitObserved: true, systemCode: privateText } }),
    });
    const subject = fixture(async () => { throw original; });
    await assert.rejects(subject.terminal("reuse"), (error) => error === original);
    subject.fail(original);
    assert.equal(subject.report.status, "FAIL");
    assert.equal(subject.report.terminalError, "UNEXPECTED_TERMINAL_EXIT_CODE");
    assert.equal(subject.report.terminalDisposal, undefined);
    assert.doesNotMatch(JSON.stringify(subject.report), /CANARY|terminal\.log|credential/);
  });

  test(client + " preserves successful terminal checks and endpoint cleanup", async () => {
    const terminalReport = { status: "PASS", credentialNotEchoed: true, exitCode: 0, accountInputSent: false,
      terminalDisposal: { status: "returned", exitObserved: true } };
    const subject = fixture(async () => ({ stdout: JSON.stringify(terminalReport) }));
    const result = await subject.terminal("reuse");
    if (!isCursor) assert.deepEqual(result, terminalReport);
    assert.equal(subject.env.MEMORAX_CODE_MEMORAX_ENDPOINT, undefined);
    assert.equal(subject.report.terminalError, undefined);
    assert.equal(subject.report.terminalDisposal, undefined);
  });
}
