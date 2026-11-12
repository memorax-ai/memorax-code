import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { workBuddyRuntimeVersion } from "./workbuddy-runtime-metadata.mjs";

const script = fileURLToPath(new URL("./workbuddy-runtime-metadata.mjs", import.meta.url));
const legacy = () => ({ name: "@genie/agent-cli", version: "1.0.0", bin: { codebuddy: "./bin/codebuddy" },
  publishConfig: { customPackage: { name: "@tencent-ai/codebuddy-code", version: "2.147.0" } } });
const current = () => ({ name: "@genie/agent-cli", version: "2.165.0", bin: { codebuddy: "./bin/codebuddy" },
  publishConfig: { name: "@tencent-ai/codebuddy-code" } });
const layoutCode = "WORKBUDDY_BUNDLE_LAYOUT_INVALID", runtimeCode = "WORKBUDDY_BUNDLE_RUNTIME_VERSION_MISMATCH";

test("bundled metadata accepts both complete formats and preserves the legacy published version", () => {
  assert.equal(workBuddyRuntimeVersion(legacy()), "2.147.0");
  assert.equal(workBuddyRuntimeVersion(current()), "2.165.0");
  const both = current();
  both.publishConfig.customPackage = { name: "@tencent-ai/codebuddy-code", version: both.version };
  assert.equal(workBuddyRuntimeVersion(both, "2.165.0"), "2.165.0");
});

for (const [label, make] of [["legacy", legacy], ["current", current]]) {
  test("bundled " + label + " metadata enforces identity, bin mapping and a stable matching runtime", () => {
    const change = (mutate, code) => { const metadata = make(); mutate(metadata); assert.throws(() => workBuddyRuntimeVersion(metadata), { code }); };
    for (const name of [undefined, null, ["@tencent-ai/codebuddy-code"], "@unrelated/cli"]) {
      change((m) => { (label === "legacy" ? m.publishConfig.customPackage : m.publishConfig).name = name; }, layoutCode);
    }
    for (const bin of [undefined, null, ["./bin/codebuddy"], "./other-command"]) change((m) => { m.bin.codebuddy = bin; }, layoutCode);
    for (const version of [undefined, null, 21650, ["2.165.0"], "2.165.0-beta.1", "2.165.0+build", "02.165.0", "2.165.0\n", "2.165.0\r"]) {
      change((m) => { (label === "legacy" ? m.publishConfig.customPackage : m).version = version; }, runtimeCode);
    }
    assert.throws(() => workBuddyRuntimeVersion(make(), "0.0.0"), { code: runtimeCode });
    assert.throws(() => workBuddyRuntimeVersion(make(), "discover"), { code: runtimeCode });
    const version = label === "legacy" ? "2.147.0" : "2.165.0";
    assert.equal(workBuddyRuntimeVersion(make(), version), version);
  });
}

test("bundled metadata rejects partial and conflicting formats instead of falling back", () => {
  for (const value of [null, [], {}, { publishConfig: null }, { bin: { codebuddy: "./bin/codebuddy" }, publishConfig: {} }]) {
    assert.throws(() => workBuddyRuntimeVersion(value), { code: layoutCode });
  }
  for (const customPackage of [null, {}, { name: "wrong", version: "2.165.0" }]) {
    const m = current(); m.publishConfig.customPackage = customPackage;
    assert.throws(() => workBuddyRuntimeVersion(m), { code: layoutCode });
  }
  for (const version of [undefined, "2.147.0"]) {
    const m = current(); m.publishConfig.customPackage = { name: "@tencent-ai/codebuddy-code", version };
    assert.throws(() => workBuddyRuntimeVersion(m), { code: runtimeCode });
  }
  const partialCurrent = legacy(); partialCurrent.publishConfig.name = "@tencent-ai/codebuddy-code";
  delete partialCurrent.version;
  assert.throws(() => workBuddyRuntimeVersion(partialCurrent), { code: runtimeCode });
});

test("metadata CLI reports validated versions or safe codes with matching exit status", async () => {
  const root = await mkdtemp(join(tmpdir(), "workbuddy-metadata-"));
  try {
    const path = join(root, "package with spaces.json");
    for (const [source, expected, result] of [
      [JSON.stringify(legacy()), "2.147.0", { ok: true, runtimeVersion: "2.147.0" }],
      [JSON.stringify(current()), "discover", { ok: true, runtimeVersion: "2.165.0" }],
      [JSON.stringify(current()), "2.147.0", { ok: false, code: runtimeCode }],
      ["PRIVATE_MALFORMED_METADATA", "discover", { ok: false, code: layoutCode }],
    ]) {
      await writeFile(path, source);
      const child = spawnSync(process.execPath, [script, path, expected], { encoding: "utf8", timeout: 5000,
        env: { HOME: root, USERPROFILE: root, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR } });
      assert.ifError(child.error);
      assert.equal(child.status, result.ok ? 0 : 1);
      assert.equal(child.stderr, "");
      assert.deepEqual(JSON.parse(child.stdout), result);
      assert.doesNotMatch(child.stdout, /PRIVATE_MALFORMED_METADATA/);
      assert.equal(child.stdout.includes(root), false);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
