#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { resolveCommonSourceRoot } from "./common-runtime.mjs";

const pluginRoot = process.env.CODEBUDDY_PLUGIN_ROOT || dirname(dirname(fileURLToPath(import.meta.url)));
const commonRoot = resolveCommonSourceRoot(pluginRoot);
const { scheduleMissingRepoMemoryBuild } = await import(pathToFileURL(join(commonRoot, "repo-memory", "repo-memory-auto-build.mjs")).href);
const { isRepoMemoryJobWorker } = await import(pathToFileURL(join(commonRoot, "repo-memory", "repo-memory-job-context.mjs")).href);

if (isRepoMemoryJobWorker()) process.exit(0);

const input = await readJsonStdin();
const event = stringValue(input?.hook_event_name) ?? stringValue(input?.hookEventName);
const sessionId = stringValue(input?.session_id) ?? stringValue(input?.sessionId);
const transcriptPath = stringValue(input?.transcript_path) ?? stringValue(input?.transcriptPath);
if (!event || !sessionId || !transcriptPath) process.exit(0);
const home = process.env.MEMORAX_CODE_HOME?.trim() || join(homedir(), ".memorax-code");
const pendingPath = join(home, "adapters", "codebuddy", "pending.json");
if (event === "UserPromptSubmit") {
  const prompt = stringValue(input.prompt);
  if (!prompt) process.exit(0);
  const boundary = await fileBoundary(transcriptPath);
  const turnId = `${sessionId}:${boundary}:${createHash("sha256").update(prompt).digest("hex").slice(0, 16)}:${randomUUID().slice(0, 8)}`;
  await updatePending(pendingPath, (state) => { state[sessionId] = { turnId, transcriptPath, cwd: stringValue(input.cwd), workspaceKind: stringValue(input.workspace_kind) ?? stringValue(input.workspaceKind) }; });
  const response = await post("/memory/turn-start", { version: 1, client: "codebuddy", sessionId, turnId, transcriptPath, prompt, cwd: stringValue(input.cwd), workspaceKind: stringValue(input.workspace_kind) ?? stringValue(input.workspaceKind) });
  scheduleMissingRepoMemoryBuild(stringValue(response?.repoMemoryWorktree), {
    debugEnv: "MEMORAX_CODE_CODEBUDDY_HOOK_DEBUG",
    pluginRoot,
  });
  const context = stringValue(response?.additionalContext);
  if (context) process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context } })}\n`);
} else if (event === "Stop") {
  const record = (await readPending(pendingPath))[sessionId];
  if (!record || record.transcriptPath !== transcriptPath) process.exit(0);
  const response = await post("/memory/writeback", { version: 1, client: "codebuddy", sessionId, turnId: record.turnId, transcriptPath, cwd: record.cwd ?? stringValue(input.cwd), workspaceKind: record.workspaceKind ?? stringValue(input.workspaceKind) });
  if (response?.ok === true) {
    await updatePending(pendingPath, (state) => {
      if (state[sessionId]?.turnId === record.turnId) delete state[sessionId];
    });
  }
}

async function post(path, body) {
  const url = process.env.MEMORAX_CODE_BACKEND_URL?.trim() || "http://127.0.0.1:8787";
  const headers = { "content-type": "application/json", connection: "close" };
  if (process.env.MEMORAX_CODE_BACKEND_TOKEN) headers.authorization = `Bearer ${process.env.MEMORAX_CODE_BACKEND_TOKEN}`;
  try { const response = await fetch(new URL(path, url), { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(12_000) }); return response.ok ? await response.json().catch(() => undefined) : undefined; } catch { return undefined; }
}
async function fileBoundary(path) { try { return (await stat(path)).size; } catch { return 0; } }
async function readJsonStdin() { try { let text = ""; for await (const chunk of process.stdin) text += chunk; return JSON.parse(text); } catch { return {}; } }
async function readRecord(path) { try { const value = JSON.parse(await readFile(path, "utf8")); return value && typeof value === "object" && !Array.isArray(value) ? value : {}; } catch { return {}; } }
async function writeRecord(path, value) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 }); }
async function readPending(path) { return await withJsonFileLockAsync(path, async () => await readRecord(path)); }
async function updatePending(path, mutate) { await withJsonFileLockAsync(path, async () => { const state = await readRecord(path); mutate(state); await writeRecord(path, state); }); }
async function withJsonFileLockAsync(path, operation) {
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + 1500;
  let acquired = false;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  while (!acquired) {
    try {
      await mkdir(lockPath, { recursive: false, mode: 0o700 });
      acquired = true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const lock = await stat(lockPath);
        if (Date.now() - lock.mtimeMs > 30_000) await rm(lockPath, { recursive: true, force: true });
      } catch {}
      if (Date.now() >= deadline) {
        const timeout = new Error(`timed out waiting for CodeBuddy Hook state lock: ${lockPath}`);
        timeout.code = "JSON_FILE_LOCK_TIMEOUT";
        throw timeout;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  try { return await operation(); } finally { await rm(lockPath, { recursive: true, force: true }); }
}
function stringValue(value) { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
