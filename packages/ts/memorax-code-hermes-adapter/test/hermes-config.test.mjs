import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  HOOK_EVENTS,
  allowlistContains,
  configContainsCommand,
  installHookEntries,
  listEntryCommands,
  readAllowlistApprovals,
  readConfigText,
  removeHookEntries,
  writeAllowlistApprovals,
} from "../src/hermes-config.mjs";

const COMMAND = `"C:\\Program Files\\nodejs\\node.exe" "C:\\x\\hooks\\memorax-code-hermes-hook.mjs"`;

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "mx-hermes-config-"));
  return {
    dir,
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("readConfigText returns missing for absent config", () => {
  const { dir, cleanup } = tempDir();
  try {
    const result = readConfigText(join(dir, "config.yaml"));
    assert.equal(result.missing, true);
  } finally {
    cleanup();
  }
});

test("installHookEntries appends hooks block to config without hooks", () => {
  const config = "model: claude-sonnet-4\nsandbox: true\n";
  const result = installHookEntries(config, COMMAND);
  assert.equal(result.error, undefined);
  assert.equal(result.changed, true);
  assert.match(result.text, /^model: claude-sonnet-4\nsandbox: true\nhooks:\n/);
  assert.match(result.text, /^  pre_llm_call:\n/m);
  assert.match(result.text, /^    - command: '/m);
  assert.match(result.text, /^  on_session_end:\n/m);
  assert.ok(result.text.startsWith("model: claude-sonnet-4\nsandbox: true\n"));
  for (const event of HOOK_EVENTS) {
    assert.ok(configContainsCommand(result.text, COMMAND));
  }
});

test("installHookEntries preserves existing hooks and user entries", () => {
  const config = [
    "hooks:",
    "  pre_tool_call:",
    '    - command: "echo hello"',
    "  on_session_end:",
    '    - command: "echo existing"',
    "",
  ].join("\n");
  const result = installHookEntries(config, COMMAND);
  assert.equal(result.error, undefined);
  assert.equal(result.changed, true);
  assert.match(result.text, /  pre_tool_call:\n/);
  assert.match(result.text, /    - command: "echo hello"\n/);
  assert.match(result.text, /    - command: "echo existing"\n/);
  assert.match(result.text, new RegExp(`    - command: '${escapeRegExp(COMMAND)}'`));
  assert.equal((result.text.match(/echo existing/g) ?? []).length, 1);
});

test("installHookEntries is idempotent for existing command", () => {
  const once = installHookEntries("", COMMAND);
  const twice = installHookEntries(once.text, COMMAND);
  assert.equal(twice.changed, false);
  assert.equal(twice.text, once.text);
});

test("installHookEntries rejects malformed hooks layout", () => {
  const config = "hooks:\n  pre_llm_call: |\n    block scalar\n";
  const result = installHookEntries(config, COMMAND);
  assert.equal(result.error, "hermes_hooks_unexpected_format");
});

test("removeHookEntries removes only matching command and empties events", () => {
  const installed = installHookEntries(
    ["hooks:",
      "  pre_tool_call:",
      '    - command: "echo hello"',
      ""].join("\n"),
    COMMAND,
  ).text;
  const removed = removeHookEntries(installed, COMMAND);
  assert.equal(removed.changed, true);
  assert.ok(!configContainsCommand(removed.text, COMMAND));
  assert.match(removed.text, /pre_tool_call:/);
  assert.doesNotMatch(removed.text, /pre_llm_call:|on_session_end:/);
});

test("removeHookEntries is idempotent", () => {
  const installed = installHookEntries("", COMMAND).text;
  const removed = removeHookEntries(installed, COMMAND);
  const again = removeHookEntries(removed.text, COMMAND);
  assert.equal(again.changed, false);
  assert.equal(again.text, removed.text);
});

test("removeHookEntries leaves unrelated user hooks untouched", () => {
  const config = [
    "hooks:",
    "  pre_llm_call:",
    '    - command: "echo keep"',
    "  on_session_end:",
    `    - command: '${COMMAND}'`,
    "",
  ].join("\n");
  const removed = removeHookEntries(config, COMMAND);
  assert.equal(removed.changed, true);
  assert.match(removed.text, /echo keep/);
  assert.doesNotMatch(removed.text, new RegExp(escapeRegExp(COMMAND)));
});

test("allowlist read/write round trip with approval matching", () => {
  const { dir, cleanup } = tempDir();
  try {
    const path = join(dir, "shell-hooks-allowlist.json");
    assert.deepEqual(readAllowlistApprovals(path), []);
    writeAllowlistApprovals(path, [
      { event: "pre_llm_call", command: COMMAND },
      { event: "on_session_end", command: COMMAND },
      { event: "pre_tool_call", command: "echo other" },
    ]);
    const approvals = readAllowlistApprovals(path);
    assert.equal(approvals.length, 3);
    assert.ok(allowlistContains(approvals, "pre_llm_call", COMMAND));
    assert.ok(allowlistContains(approvals, "on_session_end", COMMAND));
    assert.ok(!allowlistContains(approvals, "pre_llm_call", '"node.exe" "other.mjs"'));
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(onDisk.approvals, [
      { event: "pre_llm_call", command: COMMAND },
      { event: "on_session_end", command: COMMAND },
      { event: "pre_tool_call", command: "echo other" },
    ]);
  } finally {
    cleanup();
  }
});

test("writeAllowlistApprovals replaces content", () => {
  const { dir, cleanup } = tempDir();
  try {
    const path = join(dir, "shell-hooks-allowlist.json");
    writeAllowlistApprovals(path, [{ event: "pre_llm_call", command: COMMAND }]);
    writeAllowlistApprovals(path, []);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).approvals, []);
  } finally {
    cleanup();
  }
});

test("installHookEntries finds a hooks section that follows other top-level keys", () => {
  const config = [
    "model: claude-sonnet-4",
    "providers:",
    "  custom:",
    "    base_url: https://example.invalid/v1",
    "hooks:",
    "  pre_tool_call:",
    '    - command: "echo user-hook"',
    "",
  ].join("\n");
  const result = installHookEntries(config, COMMAND);
  assert.equal(result.error, undefined);
  assert.equal(result.changed, true);
  assert.ok(configContainsCommand(result.text, COMMAND));
  assert.match(result.text, /echo user-hook/);
  const removed = removeHookEntries(result.text, COMMAND);
  assert.equal(removed.changed, true);
  assert.match(removed.text, /echo user-hook/);
  assert.doesNotMatch(removed.text, new RegExp(escapeRegExp(COMMAND)));
  assert.ok(!configContainsCommand(removed.text, COMMAND));
});

test("configContainsCommand matches a command in a late hooks section", () => {
  const config = [
    "model: claude-sonnet-4",
    "hooks:",
    `  pre_llm_call:`,
    `    - command: '${COMMAND}'`,
    "  on_session_end:",
    `    - command: '${COMMAND}'`,
    "",
  ].join("\n");
  assert.ok(configContainsCommand(config, COMMAND));
});

test("listEntryCommands returns every distinct command in the hooks section", () => {
  const config = [
    "model: claude-sonnet-4",
    "hooks:",
    "  pre_llm_call:",
    `    - command: '${COMMAND}'`,
    '    - command: "echo user-hook"',
    "  on_session_end:",
    `    - command: '${COMMAND}'`,
    "  pre_tool_call:",
    '    - command: "echo user-tool"',
    "",
  ].join("\n");
  assert.deepEqual(listEntryCommands(config).sort(), [COMMAND, "echo user-hook"].sort());
  assert.deepEqual(listEntryCommands("model: claude-sonnet-4\n"), []);
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
