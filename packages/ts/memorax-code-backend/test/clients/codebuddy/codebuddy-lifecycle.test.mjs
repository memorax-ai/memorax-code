import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { codeBuddyAdapterLifecycle } from "../../../dist/clients/codebuddy/lifecycle.js";

test("CodeBuddy lifecycle converts asynchronous adapter failures into its own report", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-codebuddy-lifecycle-failure-"));
  const codeBuddyHome = join(root, "codebuddy-home");
  await mkdir(codeBuddyHome);
  await writeFile(join(codeBuddyHome, "settings.json"), "{invalid-json\n");
  try {
    const context = {
      argv: ["--codebuddy-home", codeBuddyHome],
      serviceOptions: { home: join(root, "memorax-code-home") },
      backendUrl: "http://127.0.0.1:8787",
    };
    for (const [method, action, errorField] of [
      ["status", "status", "error"],
      ["prepareEnable", "enable", "error"],
      ["disable", "disable", "error"],
      ["remove", "codebuddy-plugin-remove", "message"],
    ]) {
      const report = await codeBuddyAdapterLifecycle[method](context);
      assert.equal(report.ok, false, method);
      assert.equal(report.action, action, method);
      assert.match(report[errorField], /JSON|Unexpected|Expected/i, method);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
