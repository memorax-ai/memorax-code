import { constants } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import { isAbsolute, join, win32 } from "node:path";

const steps = ["sessionStart", "beforeSubmitPrompt", "preCompact", "afterAgentResponse", "stop"];
const statuses = ["present", "absent", "invalid", "unsafe", "oversized", "unavailable"];
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const maxBytes = 2 * 1024 * 1024, maxFiles = 16, maxExecutions = 32;
const directories = [/^logs$/, /^\d{8}T\d{6}$/, /^window\d+(?:_wb\d+)?$/, /^output_\d{8}T\d{6}$/];
const filename = /^cursor\.hooks(?:\.workspaceId-[a-zA-Z0-9_-]{1,128})?\.log$/;
const record = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value));
const count = (value, maximum) => Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : 0;
const choice = (value, values, fallback) => values.includes(value) ? value : fallback;

export function projectCursorAppHookDiagnostics(value) {
  return {
    readStatus: choice(value?.readStatus, statuses, "unavailable"), filesRead: count(value?.filesRead, maxFiles),
    // Request lines have no native identity; they are never evidence for this Turn.
    unscopedRequests: Object.fromEntries(steps.map((step) => [step, count(value?.unscopedRequests?.[step], 4096)])),
    executions: (Array.isArray(value?.executions) ? value.executions.slice(0, maxExecutions) : [])
      .filter((item) => record(item) && steps.includes(item.step) && ["turn", "session"].includes(item.scope))
      .map((item) => ({
        step: item.step, scope: item.scope,
        generation: choice(item.generation, ["matched", "absent", "invalid"], "invalid"),
        sessionAliasMatched: item.sessionAliasMatched === true,
        workspaceKind: choice(item.workspaceKind, ["single", "projectless", "invalid"], "invalid"),
        promptKind: choice(item.promptKind, ["string", "absent", "other"], "other"),
        exitCode: Number.isInteger(item.exitCode) && item.exitCode >= 0 && item.exitCode <= 0xffff_ffff ? item.exitCode : null,
        responseKind: choice(item.responseKind, ["empty", "json", "invalid"], "invalid"),
        continue: choice(item.continue, ["allow", "deny", "absent"], "absent"),
        additionalContextPresent: item.additionalContextPresent === true, stderrPresent: item.stderrPresent === true,
      })),
  };
}

function ownedCommand(command) {
  const encoded = /(?:^|\s)-EncodedCommand\s+([A-Za-z0-9+/]+={0,2})\s*$/.exec(command)?.[1];
  const text = encoded && encoded.length % 4 === 0 ? Buffer.from(encoded, "base64").toString("utf16le") : command;
  return text.includes("--memorax-code-cursor-hook-v1");
}

function collectLog(text, sessionId, turnId, result) {
  text = text.replaceAll("\r\n", "\n");
  for (const match of text.matchAll(/^\[[0-9T:.Z-]+\] Hook step requested: (\w+)$/gm)) {
    if (steps.includes(match[1])) {
      if (result.unscopedRequests[match[1]] >= 4096) throw "oversized";
      result.unscopedRequests[match[1]] += 1;
    }
  }
  // Cursor's Hooks output channel frames INPUT/OUTPUT JSON with 87 double rules.
  const block = /(?:^|\n)\u2550{87}\n(\w+)\n\u2550{87}\nCommand: ([^\n]+) \(\d+ms\) exit code: (\d+|N\/A)\n\nINPUT:\n([\s\S]*?)\n\nOUTPUT:\n([\s\S]*?)\n\u2550{87}(?=\n|$)/g;
  for (const match of text.matchAll(block)) {
    const [, step, command, exit, input, output] = match;
    if (!steps.includes(step) || !ownedCommand(command)) continue;
    let request;
    try { request = JSON.parse(input); } catch { continue; }
    if (!record(request) || request.hook_event_name !== step
      || (request.conversation_id ?? request.session_id) !== sessionId) continue;
    const generation = request.generation_id === undefined ? "absent"
      : typeof request.generation_id === "string" && uuid.test(request.generation_id) ? "matched" : "invalid";
    if (generation === "matched" && request.generation_id !== turnId) continue;
    const split = output.indexOf("\n\nSTDERR:\n"), responseText = split < 0 ? output : output.slice(0, split);
    let response, responseKind = responseText === "(empty)" ? "empty" : "invalid";
    if (responseKind !== "empty") {
      try { response = JSON.parse(responseText); if (record(response)) responseKind = "json"; } catch {}
    }
    const roots = request.workspace_roots;
    result.executions.push({ step, scope: generation === "matched" ? "turn" : "session", generation,
      sessionAliasMatched: request.session_id === undefined || request.session_id === sessionId,
      workspaceKind: Array.isArray(roots) && roots.length === 0 ? "projectless"
        : Array.isArray(roots) && roots.length === 1 && typeof roots[0] === "string"
          && !/[\0\r\n]/.test(roots[0]) && (isAbsolute(roots[0]) || win32.isAbsolute(roots[0])) ? "single" : "invalid",
      promptKind: typeof request.prompt === "string" ? "string" : request.prompt === undefined ? "absent" : "other",
      exitCode: exit === "N/A" ? null : Number(exit), responseKind,
      continue: response?.continue === true ? "allow" : response?.continue === false ? "deny" : "absent",
      additionalContextPresent: typeof response?.additional_context === "string" && response.additional_context.length > 0,
      stderrPresent: split >= 0 && output.slice(split + "\n\nSTDERR:\n".length).trim().length > 0 });
    if (result.executions.length > maxExecutions) throw "oversized";
  }
}

export async function collectCursorAppHookDiagnostics({ home, sessionId, turnId } = {}) {
  const result = projectCursorAppHookDiagnostics({ readStatus: "absent" });
  if (typeof home !== "string" || !isAbsolute(home) || /[\0\r\n]/.test(home)
    || typeof sessionId !== "string" || sessionId.length !== 36 || !uuid.test(sessionId)
    || typeof turnId !== "string" || turnId.length !== 36 || !uuid.test(turnId)) {
    return projectCursorAppHookDiagnostics({ readStatus: "invalid" });
  }
  let bytes = 0, entries = 0;
  async function walk(path, depth) {
    const before = await lstat(path);
    if (before.isSymbolicLink() || !before.isDirectory()) throw "unsafe";
    for await (const entry of await opendir(path)) {
      if (++entries > 512) throw "oversized";
      if (depth < directories.length) {
        if (directories[depth].test(entry.name)) await walk(join(path, entry.name), depth + 1);
      } else if (filename.test(entry.name)) {
        if (result.filesRead >= maxFiles) throw "oversized";
        const filePath = join(path, entry.name), info = await lstat(filePath);
        if (info.isSymbolicLink() || !info.isFile()) throw "unsafe";
        if ((bytes += info.size) > maxBytes) throw "oversized";
        const file = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
        try {
          const opened = await file.stat();
          if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size) throw "unsafe";
          const buffer = Buffer.alloc(info.size);
          let position = 0;
          while (position < buffer.length) {
            const { bytesRead } = await file.read(buffer, position, buffer.length - position, position);
            if (!bytesRead) throw "unavailable";
            position += bytesRead;
          }
          let text;
          try { text = new TextDecoder("utf-8", { fatal: true }).decode(buffer); } catch { throw "invalid"; }
          result.filesRead += 1;
          result.readStatus = "present";
          collectLog(text, sessionId, turnId, result);
        } finally { await file.close(); }
      }
    }
    const after = await lstat(path);
    if (after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino) throw "unsafe";
  }
  try { await walk(home, 0); }
  catch (error) { result.readStatus = statuses.includes(error) ? error : error?.code === "ENOENT" ? "absent" : "unavailable"; }
  return projectCursorAppHookDiagnostics(result);
}
