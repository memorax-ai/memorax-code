import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_ENSURE_BACKEND_START_TIMEOUT_MS,
  ensureBackendAvailable,
} from "../src/hooks/ensure-backend-runner.mjs";

test("ensure-backend process ceiling leaves room for lifecycle lock wait and recovery", () => {
  assert.equal(DEFAULT_ENSURE_BACKEND_START_TIMEOUT_MS, 90000);
});

test("shared Backend recovery passes caller-supplied internal environment", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-ensure-runner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const memoraxCodeHome = join(root, "memorax-code-home");
  await mkdir(memoraxCodeHome, { recursive: true });
  const recordPath = join(root, "recovery.json");
  const command = join(root, "recovery-memorax-code.mjs");
  await writeFile(command, [
    'import { writeFileSync } from "node:fs";',
    'writeFileSync(process.env.MEMORAX_CODE_TEST_RECORD_PATH, JSON.stringify({',
    '  marker: process.env.MEMORAX_CODE_DSH_ADAPTER_RECOVERY,',
    '  revision: process.env.MEMORAX_CODE_DSH_ADAPTER_EXPECTED_REVISION,',
    '}));',
  ].join("\n"));

  await ensureBackendAvailable({
    backendConnection: {
      memoraxCodeHome,
      url: "http://127.0.0.1:9",
      source: "environment",
    },
    healthTimeoutValue: "50",
    memoraxCodeCommand: command,
    nodePath: process.execPath,
    resolveHomes: () => ({ memoraxCodeHome }),
    buildStartArgs: () => ["start"],
    recoveryEnv: {
      MEMORAX_CODE_TEST_RECORD_PATH: recordPath,
      MEMORAX_CODE_DSH_ADAPTER_RECOVERY: "1",
      MEMORAX_CODE_DSH_ADAPTER_EXPECTED_REVISION: "revision-1",
    },
  });

  assert.deepEqual(JSON.parse(await readFile(recordPath, "utf8")), {
    marker: "1",
    revision: "revision-1",
  });
});
