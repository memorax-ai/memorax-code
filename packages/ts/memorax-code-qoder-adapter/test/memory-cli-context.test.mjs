import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { withMemoryCliSession } from "../src/memory-cli-context.mjs";
import { fixture } from "./support.mjs";

test("CLI context targets actual command positions and is idempotent", () => {
  for (const command of [
    "memorax-cli search --query synthetic", '"/path with space/memorax-cli" add --content synthetic',
    "node /package/bin/memorax-cli.mjs search --query synthetic", "node -- '/package path/memorax-cli.mjs' search",
    "cd /workspace && memorax-cli search --query synthetic", "printf input | memorax-cli add",
    "A=one env -i B=two memorax-cli search", "command -- memorax-cli search", "# memorax-cli is prose\nmemorax-cli search",
    "MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT=wrong MEMORAX_CODE_MEMORY_CLI_TRACE_SESSION_ID=old memorax-cli search",
  ]) {
    const updated = withMemoryCliSession(command, "synthetic-session", "/custom/state");
    assert.notEqual(updated, command, command);
    assert.match(updated, /MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT='qoder'/);
    assert.match(updated, /MEMORAX_CODE_MEMORY_CLI_TRACE_SESSION_ID='synthetic-session'/);
    assert.match(updated, /MEMORAX_CODE_HOME='\/custom\/state'/);
    assert.equal(withMemoryCliSession(updated, "synthetic-session", "/custom/state"), updated, command);
  }
});

test("CLI context leaves prose, unrelated commands and dynamic shell programs unchanged", () => {
  for (const command of [
    "echo memorax-cli", "printf '%s' 'memorax-cli search'", "# memorax-cli search", "cat memorax-cli",
    "node unrelated.mjs memorax-cli", "memorax-cli-other search", "bash -c 'memorax-cli search'",
    'echo "$(memorax-cli search)"', "`memorax-cli search`", "$CLI search", "env -u memorax-cli echo hello",
    "cat <<EOF\nmemorax-cli search\nEOF", "function memorax-cli() { echo test; }", "'unterminated",
    '"\\memorax-cli" search',
  ]) assert.equal(withMemoryCliSession(command, "synthetic-session", "/custom/state"), command, command);
});

test("session interpolation stays literal in a real POSIX command environment", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t, { install: false });
  const cli = join(f.root, "memorax-cli");
  const marker = join(f.root, "must-not-exist");
  await writeFile(cli, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({client:process.env.MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT,session:process.env.MEMORAX_CODE_MEMORY_CLI_TRACE_SESSION_ID,home:process.env.MEMORAX_CODE_HOME}));\n`);
  await chmod(cli, 0o700);
  const sessionId = `session'$(touch ${marker});\nnext`;
  const home = `${f.memoraxCodeHome} 'literal $home`;
  const command = withMemoryCliSession(`'${cli}' search --query synthetic`, sessionId, home);
  const result = spawnSync("/bin/sh", ["-c", command], { cwd: f.root, env: { PATH: process.env.PATH, MEMORAX_CODE_HOME: "/wrong/home" }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { client: "qoder", session: sessionId, home });
  assert.equal(existsSync(marker), false);
  assert.equal(withMemoryCliSession(command, sessionId, home), command);
});

test("env -i receives CLI context inside its own assignments even when outer assignments match", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t, { install: false });
  const cli = join(f.root, "memorax-cli");
  await writeFile(cli, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({client:process.env.MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT,session:process.env.MEMORAX_CODE_MEMORY_CLI_TRACE_SESSION_ID,home:process.env.MEMORAX_CODE_HOME}));\n`);
  await chmod(cli, 0o700);
  const command = `MEMORAX_CODE_HOME='/synthetic/home' MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT='qoder' MEMORAX_CODE_MEMORY_CLI_TRACE_SESSION_ID='session-1' env -i '${cli}' search`;
  const updated = withMemoryCliSession(command, "session-1", "/synthetic/home");
  assert.notEqual(updated, command);
  assert.equal(withMemoryCliSession(updated, "session-1", "/synthetic/home"), updated);
  const result = spawnSync("/bin/sh", ["-c", updated], { cwd: f.root, env: { PATH: process.env.PATH }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { client: "qoder", session: "session-1", home: "/synthetic/home" });
});
