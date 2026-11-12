import type { IncomingMessage, ServerResponse } from "node:http";
import type { MemoryReminderTraceRecorder } from "../../memory/reminder-trace-recorder.js";
import {
  parsePreCompactCommand,
  parseTurnStartCommand,
  parseWritebackCommand,
} from "../../memory/hook-command.js";
import type { MemoryService } from "../../memory/service.js";
import { readJson } from "./request.js";
import { json } from "./json.js";

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
  if (req.method === "GET" && url.pathname === "/memory/search-guidance") {
    json(res, 200, dependencies.memoryService.searchGuidanceStatus());
    return true;
  }
  if (req.method !== "POST") return false;
  if (
    url.pathname !== "/memory/turn-start"
    && url.pathname !== "/memory/pre-compact"
    && url.pathname !== "/memory/skill-reminder"
    && url.pathname !== "/memory/search-guidance"
    && url.pathname !== "/memory/writeback"
  ) return false;
  const body = await readJson(req);
  if (url.pathname === "/memory/search-guidance") {
    const parsed = parseTurnStartCommand(body);
    if (!parsed.ok) {
      json(res, 400, { ok: false, error: parsed.error });
      return true;
    }
    json(res, 200, await dependencies.memoryService.evaluateSearchGuidance(parsed.command));
    return true;
  }
  if (url.pathname === "/memory/pre-compact") {
    const parsed = parsePreCompactCommand(body);
    if (!parsed.ok) {
      json(res, 400, { ok: false, error: parsed.error });
      return true;
    }
    json(res, 200, await dependencies.memoryService.recordPreCompact(parsed.command));
    return true;
  }
  if (url.pathname === "/memory/skill-reminder") {
    json(res, 200, await dependencies.memoryReminderTraceRecorder.recordSkillReminder(body));
    return true;
  }
  if (url.pathname === "/memory/turn-start") {
    const parsed = parseTurnStartCommand(body);
    if (!parsed.ok) {
      json(res, 400, { ok: false, error: parsed.error });
      return true;
    }
    json(res, 200, await dependencies.memoryService.recordTurnStart(parsed.command));
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
