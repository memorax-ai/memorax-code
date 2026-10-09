import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { startLifecycleCommand } from "./claude-lifecycle-process.mjs";

const driver = new URL("./claude-install-interruption-driver.mjs", import.meta.url).href;

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "claude-interruption-driver-"));
  const entrypoint = join(root, "entry.mjs"), other = join(root, "other.mjs"), marker = join(root, "entered.json");
  await writeFile(entrypoint, `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)));
console.log("REAL_ENTRYPOINT_EXECUTED");
`);
  await writeFile(other, "// A different installed entrypoint identity.\n");
  const requests = [], responses = [], operations = [];
  let received;
  const admitted = new Promise((done) => { received = done; });
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ method: request.method, path: request.url, body: JSON.parse(body) });
    responses.push(response);
    received();
  });
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const url = `http://127.0.0.1:${server.address().port}`;
  return { requests, admitted, marker, other,
    launch(args, options = {}) {
      const env = { ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {}),
        MEMORAX_TEST_CLAUDE_GATE_URL: options.url ?? url,
        MEMORAX_TEST_GATED_ENTRYPOINT: options.entrypoint ?? entrypoint };
      const operation = startLifecycleCommand(process.execPath, ["--import", driver, entrypoint, ...args], { env, timeoutMs: 5_000 });
      const result = operation.result.then((value) => ({ value }), (error) => ({ error }));
      operations.push({ operation, result });
      return result;
    },
    release(status = 200) { for (const response of responses) response.writeHead(status).end("fixture"); },
    async close() {
      let failure;
      for (const { operation, result } of operations) {
        try { await operation.stop(); } catch (error) { failure ??= error; }
        const settled = await result;
        if (settled.error?.cleanupFailed) failure ??= settled.error;
      }
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
      if (!failure) await rm(root, { recursive: true, force: true });
      if (failure) throw failure;
    },
  };
}

for (const command of ["start", "status"]) {
  test(`interruption preload pauses real ${command} entry until the loopback gate releases it`, { timeout: 15_000 }, async () => {
    const fixture = await createFixture();
    try {
      const result = fixture.launch([command, "--clients", "claude", "--json"]);
      await Promise.race([fixture.admitted, result.then(() => assert.fail("Real child exited before reaching the gate"))]);
      assert.equal(await stat(fixture.marker).then(() => true, (error) => { if (error.code === "ENOENT") return false; throw error; }), false);
      assert.equal(fixture.requests.length, 1);
      const [{ method, path, body }] = fixture.requests;
      assert.equal(method, "POST");
      assert.equal(path, "/");
      assert.ok(Number.isInteger(body.pid) && body.pid > 1 && body.pid !== process.pid);
      assert.deepEqual(body.args, [command, "--clients", "claude", "--json"]);
      fixture.release();
      const completed = await result;
      assert.equal(completed.error, undefined);
      assert.equal(completed.value.stdout, "REAL_ENTRYPOINT_EXECUTED\n");
      assert.deepEqual(JSON.parse(await readFile(fixture.marker, "utf8")), body.args);
    } finally { await fixture.close(); }
  });
}

test("interruption preload fails closed when the gate rejects the real child", { timeout: 15_000 }, async () => {
  const fixture = await createFixture();
  try {
    const result = fixture.launch(["start"]);
    await Promise.race([fixture.admitted, result.then(() => assert.fail("Real child exited before reaching the gate"))]);
    fixture.release(503);
    const { error } = await result;
    assert.equal(error.code, 1);
    assert.equal(error.cleanupFailed, undefined);
    assert.equal(error.stdout, "");
    assert.equal(error.stderr, "SETUP_DEPENDENCY_GATE_FAILED\n");
    await assert.rejects(stat(fixture.marker), { code: "ENOENT" });
  } finally { await fixture.close(); }
});

test("interruption preload does not replace setup or unrelated installed commands", { timeout: 15_000 }, async () => {
  const fixture = await createFixture();
  try {
    for (const args of [["setup"], ["update"], ["start", "--clients", "claude"]]) {
      const completed = await fixture.launch(args, args[0] === "start" ? { entrypoint: fixture.other } : {});
      assert.equal(completed.error, undefined);
      assert.equal(completed.value.stdout, "REAL_ENTRYPOINT_EXECUTED\n");
      assert.deepEqual(JSON.parse(await readFile(fixture.marker, "utf8")), args);
    }
    assert.equal(fixture.requests.length, 0);
  } finally { await fixture.close(); }
});

test("interruption preload rejects non-loopback and non-root gate URLs before sending a request", { timeout: 15_000 }, async () => {
  const fixture = await createFixture();
  try {
    for (const url of ["https://127.0.0.1:1", "http://example.invalid:1", "http://127.0.0.1:1/not-the-gate",
      "http://name@127.0.0.1:1", pathToFileURL(fixture.other).href]) {
      const { error } = await fixture.launch(["status"], { url });
      assert.equal(error.code, 1);
      assert.equal(error.stdout, "");
      assert.equal(error.stderr, "SETUP_DEPENDENCY_GATE_FAILED\n");
    }
    assert.equal(fixture.requests.length, 0);
    await assert.rejects(stat(fixture.marker), { code: "ENOENT" });
  } finally { await fixture.close(); }
});
