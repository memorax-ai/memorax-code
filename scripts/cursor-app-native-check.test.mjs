import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";

const source = await readFile(new URL("./cursor-app-native-check.mjs", import.meta.url), "utf8");

test("native cleanup audits the pending marker Node and Shell without killing discovered processes", async () => {
  const body = source.split("async function ownedProcessesRemain(")[1]?.split("\nfunction assertWriteback()")[0];
  assert.ok(body);
  const marker = "/owned/workspace/cancelled-shell-marker";
  for (const [argv, includeBackend, expected] of [
    [["/usr/local/bin/node", "-e", "synthetic marker script", marker], true, true],
    [["/bin/sh", "-c", `/usr/local/bin/node -e 'synthetic marker script' '${marker}'`], true, true],
    [["/owned/app/cursor"], false, true],
    [["node", "/owned/package/backend.mjs"], true, true],
    [["node", "/owned/package/backend.mjs"], false, false],
    [["node", "--home", "/owned/state"], true, true],
    [["node", "/unrelated/workspace/cancelled-shell-marker"], true, false],
    [["node", "/owned/state-other/tool.mjs"], true, false],
  ]) {
    const check = runInNewContext(`(async function ownedProcessesRemain(${body})`, {
      process: { pid: 1 }, dirname, appPath: "/owned/app/cursor", packageRoot: "/owned/package",
      env: { MEMORAX_CODE_HOME: "/owned/state" }, interruption: { marker },
      async readdir(path) { assert.equal(path, "/proc"); return ["1", "2", "self"]; },
      async readFile(path, encoding) {
        assert.equal(path, "/proc/2/cmdline"); assert.equal(encoding, "utf8");
        return argv.join("\0");
      },
    }, { timeout: 100 });
    assert.equal(await check({ includeBackend }), expected);
  }
});
