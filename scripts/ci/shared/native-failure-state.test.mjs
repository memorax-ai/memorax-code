import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createNativeHarness as codexHarness } from "../codex/codex-native-support.mjs";
import { createNativeHarness as claudeHarness } from "../claude/claude-native-support.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const clients = [
  ["codex", codexHarness, "codexCommand", "runCodex", "spawnCodex", "codexHome"],
  ["claude", claudeHarness, "claudeCommand", "runClaude", "spawnClaude", "claudeHome"],
];
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } };
async function released(url) {
  const probe = createServer();
  await new Promise((done, reject) => { probe.once("error", reject); probe.listen(Number(new URL(url).port), "127.0.0.1", done); });
  await new Promise((done) => probe.close(done));
}
for (const [client, create, command, run, start, home] of clients) {
  async function harness(t, packageRoot = join(repo, "packages/npm/memorax-code")) {
    const h = await create({ packageRoot, [command]: process.execPath, label: "failure-state-test" });
    t.after(async () => { await h.close().catch(() => {}); await rm(h.root, { recursive: true, force: true }); });
    return h;
  }
  test(client + " retains safe command failure observations before cleanup", async (t) => {
    const h = await harness(t);
    const secret = "synthetic-private-command-content";
    await assert.rejects(h[run](["-e", String.raw`
      process.stdout.write(JSON.stringify({ type: "error", message: "stream idle timeout " + process.argv[1] }) + "\n");
      process.stderr.write(process.argv[1]);
      process.exitCode = 17;
    `, secret]));
    const result = h.commandFailure;
    assert.equal(result.code, 17);
    assert.equal(result.nativeErrorObserved, true);
    assert.equal(result.streamIdleTimeoutObserved, true);
    assert.equal(result.stderrBytes, Buffer.byteLength(secret));
    assert.equal(JSON.stringify(result).includes(secret), false);
    result.code = 0;
    assert.equal(h.commandFailure.code, 17);
    await h[run](["-e", 'process.stdout.write("ok")']);
    assert.equal(h.commandFailure, undefined);
  });
  test(client + " preserves failed native state while stopping the owned child and receivers", async (t) => {
    const h = await harness(t);
    const native = join(h[home], "synthetic-native.jsonl");
    const content = '{"fixture":"private native content"}\n';
    await writeFile(native, content);
    const child = h[start](["-e", "setTimeout(() => {}, 60000)"]);
    await new Promise((done, reject) => { child.once("spawn", done); child.once("error", reject); });
    await h.close({ preserveState: true });
    assert.equal(alive(child.pid), false);
    assert.equal(await readFile(native, "utf8"), content);
    await released(h.modelUrl); await released(h.memoryUrl);
    await h.close();
    assert.equal((await stat(h.root)).isDirectory(), true);
    await assert.rejects(h.runMemory(["status"]), { nativeCode: "NATIVE_HARNESS_IS_CLOSING" });
  });
  test(client + " removes successful state by default", async (t) => {
    const h = await harness(t);
    await h.close();
    await assert.rejects(stat(h.root), { code: "ENOENT" });
  });
  test(client + " stops a recorded Backend even before setup and retains its state", async (t) => {
    const pkg = await mkdtemp(join(tmpdir(), "native-failure-backend-package-"));
    t.after(() => rm(pkg, { recursive: true, force: true }));
    await mkdir(join(pkg, "lib")); await mkdir(join(pkg, "bin"));
    await writeFile(join(pkg, "lib/windows-cli-invocation.mjs"), "export const resolveWindowsCliInvocation=(command,args)=>({command,args});\n");
    await writeFile(join(pkg, "bin/memorax-code.mjs"), `
      import { readFileSync, unlinkSync } from "node:fs";
      import { join } from "node:path";
      const file=join(process.env.MEMORAX_CODE_HOME,"runtime/backend/backend.pid.json");
      const {pid}=JSON.parse(readFileSync(file,"utf8"));
      try { process.kill(pid,"SIGTERM"); } catch(e) { if(e.code!=="ESRCH") throw e; }
      const deadline=Date.now()+5000;
      while(Date.now()<deadline){try{process.kill(pid,0);}catch(e){if(e.code==="ESRCH")break;throw e;}await new Promise(r=>setTimeout(r,10));}
      unlinkSync(file);console.log(JSON.stringify({ok:true}));
    `);
    const h = await harness(t, pkg);
    const backend = spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)"], { stdio: "ignore" });
    t.after(async () => { if (alive(backend.pid)) backend.kill("SIGKILL"); });
    await new Promise((done, reject) => { backend.once("spawn", done); backend.once("error", reject); });
    await mkdir(join(h.stateHome, "runtime/backend"), { recursive: true });
    await writeFile(join(h.stateHome, "runtime/backend/backend.pid.json"), JSON.stringify({pid:backend.pid}));
    await h.close({ preserveState: true });
    assert.equal(alive(backend.pid), false);
    assert.equal((await stat(h.root)).isDirectory(), true);
    await assert.rejects(stat(join(h.stateHome,"runtime/backend/backend.pid.json")), {code:"ENOENT"});
    await released(h.modelUrl); await released(h.memoryUrl);
  });
}
