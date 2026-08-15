import type { IncomingMessage, ServerResponse } from "node:http";
import type { MemoryReminderTraceRecorder } from "../../memory/reminder-trace-recorder.js";
import {
  parseTurnDiscardCommand,
  parseTurnStartCommand,
  parseWritebackCommand,
} from "../../memory/hook-command.js";
import type { MemoryService } from "../../memory/service.js";
import { readJson } from "./request.js";
import { json } from "./json.js";

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

// The DSH adapter dispatches to these exact paths (MEMORY_HOOK_PATHS in
// memorax-code-dsh-adapter/src/session-bridge.mjs). The cross-package
// contract test (test/memory/dsh-adapter-contract.test.mjs) fails when
// either side drifts, because a path mismatch would surface only as silent
// 404s swallowed by the fail-silent plugin.
export const MEMORY_HOOK_PATHS = {
  turnStart: "/memory/turn-start",
  skillReminder: "/memory/skill-reminder",
  writeback: "/memory/writeback",
  turnDiscard: "/memory/turn-discard",
} as const;

export type MemoryHookRequestDependencies = {
  memoryService: MemoryService;
  memoryReminderTraceRecorder: MemoryReminderTraceRecorder;
};

export async function handleMemoryHookRequest(
  dependencies: MemoryHookRequestDependencies,
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (req.method !== "POST") return false;
  if (
    url.pathname !== MEMORY_HOOK_PATHS.turnStart
    && url.pathname !== MEMORY_HOOK_PATHS.skillReminder
    && url.pathname !== MEMORY_HOOK_PATHS.writeback
    && url.pathname !== MEMORY_HOOK_PATHS.turnDiscard
  ) return false;
  // Hook commands come from local client processes over node fetch/http, which
  // never attach an Origin header. Browsers attach Origin to every cross-site
  // (and same-site) POST, so any Origin here means a web page is trying to
  // drive the local Hook surface (for example to poison cloud memory through
  // the victim's turn-start/writeback). Refuse it outright.
  if (req.headers.origin !== undefined) {
    json(res, 403, { ok: false, error: "cross-origin hook requests are not accepted" });
    return true;
  }
  // Require an explicit JSON content type. Browsers can send cross-site forms
  // and text/plain bodies that would otherwise be parsed here as JSON.
  const contentType = headerValue(req.headers["content-type"]);
  const mediaType = contentType?.split(";")[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    json(res, 415, { ok: false, error: "content-type must be application/json" });
    return true;
  }
  const body = await readJson(req);
  if (url.pathname === MEMORY_HOOK_PATHS.skillReminder) {
    json(res, 200, await dependencies.memoryReminderTraceRecorder.recordSkillReminder(body));
    return true;
  }
  if (url.pathname === MEMORY_HOOK_PATHS.turnStart) {
    const parsed = parseTurnStartCommand(body);
    if (!parsed.ok) {
      json(res, 400, { ok: false, error: parsed.error });
      return true;
    }
    json(res, 200, await dependencies.memoryService.recordTurnStart(parsed.command));
    return true;
  }
  if (url.pathname === MEMORY_HOOK_PATHS.turnDiscard) {
    const parsed = parseTurnDiscardCommand(body);
    if (!parsed.ok) {
      json(res, 400, { ok: false, error: parsed.error });
      return true;
    }
    json(res, 200, await dependencies.memoryService.discardTurn(parsed.command));
    return true;
  }
  const parsed = parseWritebackCommand(body);
  if (!parsed.ok) {
    json(res, 400, { ok: false, error: parsed.error });
    return true;
  }
  json(res, 200, await dependencies.memoryService.writebackTurn(parsed.command));
  return true;
}
