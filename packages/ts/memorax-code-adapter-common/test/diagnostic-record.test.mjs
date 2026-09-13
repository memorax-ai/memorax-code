import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { writeDiagnosticRecord } from "../src/diagnostic-record.mjs";

const fields = {
  source: "memorax-cli",
  operation: "memory.search",
  stage: "request",
  errorCode: "MEMORAX_HTTP_ERROR",
  error: "MemoraX HTTP 503",
  impact: "No Search result was returned.",
  userAction: "Check MemoraX service availability.",
  version: "0.0.0",
  runtimeVersion: process.version,
  platform: process.platform,
};

test("diagnostics stay immutable during rapid writes and prune only owned expired or excess records", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "memorax-diagnostic-retention-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const directory = join(home, "runtime", "diagnostics");
  await mkdir(directory, { recursive: true });
  const now = Date.now();
  t.mock.method(Date, "now", () => now);
  const name = (timestamp, index) => `mc-${timestamp}-00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}.json`;
  const fresh = Array.from({ length: 120 }, (_, index) => name(now - 1000 - index, index));
  const expired = name(now - 8 * 24 * 60 * 60 * 1000, 120);
  const unrelated = ["notes.txt", "unrelated.json", "mc-unrelated.json"];
  await Promise.all([
    ...fresh.map((filename) => writeFile(join(directory, filename), "{}\n")),
    writeFile(join(directory, expired), "{}\n"),
    ...unrelated.map((filename) => writeFile(join(directory, filename), "keep unchanged\n")),
  ]);

  const first = writeDiagnosticRecord(home, fields);
  assert.equal(first.recorded, true);
  const firstText = await readFile(first.path, "utf8");
  const results = [first, ...Array.from({ length: 19 }, () => writeDiagnosticRecord(home, fields))];
  assert.equal(results.every((result) => result.recorded), true);
  assert.equal(new Set(results.map((result) => result.id)).size, results.length);
  for (const result of results) {
    const record = JSON.parse(await readFile(result.path, "utf8"));
    assert.equal(record.id, result.id);
    assert.equal(record.operation, fields.operation);
  }
  assert.equal(await readFile(first.path, "utf8"), firstText);
  const retained = await readdir(directory);
  assert.equal(retained.length - unrelated.length, 100);
  assert.equal(retained.includes(expired), false);
  assert.equal(retained.includes(fresh[0]), true);
  assert.equal(retained.includes(fresh.at(-1)), false);
  for (const filename of unrelated) assert.equal(await readFile(join(directory, filename), "utf8"), "keep unchanged\n");
});

test("diagnostics tighten existing POSIX permissions and reject symlinked storage without outside writes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "memorax-diagnostic-storage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const directory = join(home, "runtime", "diagnostics");
  await mkdir(directory, { recursive: true });
  if (process.platform !== "win32") await chmod(directory, 0o777);
  const result = writeDiagnosticRecord(home, fields);
  assert.equal(result.recorded, true);
  if (process.platform !== "win32") {
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(result.path)).mode & 0o777, 0o600);
  }

  const outside = join(root, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "sentinel.txt"), "keep unchanged\n");
  for (const segment of ["runtime", "diagnostics"]) {
    const linkedHome = join(root, `linked-${segment}`);
    const parent = segment === "runtime" ? linkedHome : join(linkedHome, "runtime");
    await mkdir(parent, { recursive: true });
    try {
      await symlink(outside, join(parent, segment), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (process.platform !== "win32" || !["EPERM", "EACCES", "ENOSYS"].includes(error.code)) throw error;
      t.diagnostic(`Symlink checks unavailable on this Windows host: ${error.code}`);
      return;
    }
    const rejected = writeDiagnosticRecord(linkedHome, fields);
    assert.equal(rejected.recorded, false, segment);
    assert.equal(rejected.recordingError, "DIAGNOSTIC_DIRECTORY_INVALID", segment);
    assert.deepEqual(await readdir(outside), ["sentinel.txt"]);
    assert.equal(await readFile(join(outside, "sentinel.txt"), "utf8"), "keep unchanged\n");
  }
});
