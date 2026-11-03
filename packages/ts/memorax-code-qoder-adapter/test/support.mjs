import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enableQoderAdapter } from "../src/config.mjs";

export async function fixture(t, { install = true, server = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "memorax-qoder-test-"));
  const home = join(root, "user");
  const qoderHome = join(home, ".qoder");
  const memoraxCodeHome = join(root, "state");
  const skillSourcePath = join(root, "skill-source");
  const memoraxCodeCommand = join(root, "lifecycle.mjs");
  await Promise.all([mkdir(qoderHome, { recursive: true }), mkdir(skillSourcePath, { recursive: true })]);
  await writeFile(join(skillSourcePath, "SKILL.md"), "---\nname: memorax-code\ndescription: Synthetic test Skill.\n---\nUse memorax-cli.\n");
  await writeFile(memoraxCodeCommand, "process.stdout.write(JSON.stringify({ok:true}));\n");
  const options = { qoderHome, memoraxCodeHome, skillSourcePath, memoraxCodeCommand };
  const value = { root, home, qoderHome, memoraxCodeHome, options, requests: [], recorded: true, healthy: true };
  if (server) {
    value.server = createServer(async (request, response) => {
      let text = "";
      for await (const part of request) text += part;
      const body = text ? JSON.parse(text) : undefined;
      value.requests.push({ path: request.url, body });
      await value.beforeReply?.({ path: request.url, body });
      if (value.disconnectTurnStart && request.url === "/memory/turn-start") {
        request.socket.destroy();
        return;
      }
      let reply = { ok: true };
      if (request.url === "/health") reply = { ok: value.healthy, service: "memorax-code-backend" };
      if (request.url === "/memory/turn-start") reply = { ok: true, recorded: value.recorded, userNotice: value.notice, repoMemoryWorktree: value.repoMemoryWorktree };
      if (request.url === "/memory/search-guidance") reply = value.searchGuidance ?? { ok: true, decision: "skip" };
      if (request.url === "/memory/writeback") reply = { ok: true, scheduled: body?.status === "completed" };
      response.writeHead(value.rejectTurnStart && request.url === "/memory/turn-start" ? 409 : 200, { "content-type": "application/json" });
      response.end(JSON.stringify(reply));
    });
    await new Promise((resolve) => value.server.listen(0, "127.0.0.1", resolve));
  }
  t.after(async () => {
    if (value.server) await new Promise((resolve) => value.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  if (install) {
    const installed = await enableQoderAdapter(options);
    if (!installed.ok) throw new Error(JSON.stringify(installed));
    value.installed = installed;
    value.runtimePath = installed.runtimePath;
  }
  return value;
}

export function runNode(args, { cwd, env, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], timeout: 15_000 });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (part) => { stdout += part; });
    child.stderr.on("data", (part) => { stderr += part; });
    child.on("error", reject);
    child.on("close", (status, signal) => resolve({ status, signal, stdout: stdout.trim(), stderr }));
    child.stdin.end(input === undefined ? "" : JSON.stringify(input));
  });
}

export function hookInput(value, overrides = {}) {
  return {
    hook_event_name: "UserPromptSubmit", session_id: "qoder-session-1", request_set_id: "qoder-turn-1",
    cwd: value.root, transcript_path: join(value.root, "native-transcript.jsonl"), prompt: "Synthetic Qoder prompt.",
    ...overrides,
  };
}

export function hook(value, input, overrides = {}) {
  return runNode([value.runtimePath], {
    cwd: value.root,
    env: {
      PATH: process.env.PATH,
      ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot, USERPROFILE: value.home, APPDATA: join(value.home, "AppData", "Roaming"), LOCALAPPDATA: join(value.home, "AppData", "Local") } : {}),
      HOME: value.home, QODER_CONFIG_DIR: value.qoderHome, MEMORAX_CODE_HOME: value.memoraxCodeHome,
      ...(value.server ? { MEMORAX_CODE_BACKEND_URL: `http://127.0.0.1:${value.server.address().port}` } : {}),
      ...overrides,
    },
    input,
  });
}

export async function json(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
