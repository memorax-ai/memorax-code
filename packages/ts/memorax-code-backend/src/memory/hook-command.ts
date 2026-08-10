import { isRecord } from "../shared/record.js";

export const MEMORY_HOOK_COMMAND_VERSION = 1 as const;
export const INVALID_MEMORY_HOOK_COMMAND = "invalid memory Hook command";

export type MemoryHookClient = "codex" | "claude-code";

const BASE_COMMAND_KEYS = [
  "version",
  "client",
  "sessionId",
  "cwd",
  "workspaceKind",
] as const;
const TURN_START_KEYS: Readonly<Record<MemoryHookClient, ReadonlySet<string>>> = {
  codex: new Set([...BASE_COMMAND_KEYS, "turnId", "prompt", "transcriptPath"]),
  "claude-code": new Set([...BASE_COMMAND_KEYS, "promptId", "prompt", "transcriptPath"]),
};
const WRITEBACK_KEYS: Readonly<Record<MemoryHookClient, ReadonlySet<string>>> = {
  codex: new Set([...BASE_COMMAND_KEYS, "turnId", "lastAssistantMessage", "transcriptPath"]),
  "claude-code": new Set([
    ...BASE_COMMAND_KEYS,
    "promptId",
    "lastAssistantMessage",
    "transcriptPath",
  ]),
};
const SKILL_REMINDER_KEYS: Readonly<Record<MemoryHookClient, ReadonlySet<string>>> = {
  codex: new Set([...BASE_COMMAND_KEYS, "turnId", "transcriptPath", "content", "triggers"]),
  "claude-code": new Set([...BASE_COMMAND_KEYS, "promptId", "transcriptPath", "content", "triggers"]),
};

type MemoryHookCommandBase<Client extends MemoryHookClient> = Readonly<{
  version: typeof MEMORY_HOOK_COMMAND_VERSION;
  client: Client;
  sessionId: string;
  cwd?: string;
  workspaceKind?: string;
}>;

export type CodexTurnStartCommand = MemoryHookCommandBase<"codex"> & Readonly<{
  turnId?: string;
  prompt: string;
  transcriptPath: string;
}>;

export type ClaudeTurnStartCommand = MemoryHookCommandBase<"claude-code"> & Readonly<{
  promptId: string;
  prompt: string;
  transcriptPath: string;
}>;

export type TurnStartCommand = CodexTurnStartCommand | ClaudeTurnStartCommand;

export type MemoryHookTurnStartResult = Readonly<{
  ok: true;
  additionalContext?: string;
  repoMemoryWorktree?: string;
}>;

export type CodexWritebackCommand = MemoryHookCommandBase<"codex"> & Readonly<{
  turnId?: string;
  lastAssistantMessage: string;
  transcriptPath?: string;
}>;

export type ClaudeWritebackCommand = MemoryHookCommandBase<"claude-code"> & Readonly<{
  promptId: string;
  lastAssistantMessage: string;
  transcriptPath: string;
}>;

export type WritebackCommand = CodexWritebackCommand | ClaudeWritebackCommand;

export type SkillReminderTrigger = "cadence" | "post_compaction";

export type CodexSkillReminderCommand = MemoryHookCommandBase<"codex"> & Readonly<{
  turnId: string;
  transcriptPath: string;
  content: string;
  triggers: SkillReminderTrigger[];
}>;

export type ClaudeSkillReminderCommand = MemoryHookCommandBase<"claude-code"> & Readonly<{
  promptId: string;
  transcriptPath: string;
  content: string;
  triggers: SkillReminderTrigger[];
}>;

export type SkillReminderCommand = CodexSkillReminderCommand | ClaudeSkillReminderCommand;

export type MemoryHookCommandParseResult<Command> =
  | { ok: true; command: Command }
  | { ok: false; error: typeof INVALID_MEMORY_HOOK_COMMAND };

export function parseTurnStartCommand(
  value: unknown,
): MemoryHookCommandParseResult<TurnStartCommand> {
  if (!isRecord(value)) return invalidCommand();
  const base = parseCommandBase(value, TURN_START_KEYS);
  if (!base) return invalidCommand();
  const prompt = requiredStringField(value, "prompt");
  const transcriptPath = requiredStringField(value, "transcriptPath");
  if (!prompt || !transcriptPath) return invalidCommand();
  if (base.client === "codex") {
    const turnId = optionalStringField(value, "turnId");
    if (!turnId.ok) return invalidCommand();
    return {
      ok: true,
      command: {
        ...base,
        client: "codex",
        prompt,
        transcriptPath,
        ...(turnId.value ? { turnId: turnId.value } : {}),
      },
    };
  }
  const promptId = requiredStringField(value, "promptId");
  if (!promptId) return invalidCommand();
  return {
    ok: true,
    command: {
      ...base,
      client: "claude-code",
      promptId,
      prompt,
      transcriptPath,
    },
  };
}

export function parseWritebackCommand(
  value: unknown,
): MemoryHookCommandParseResult<WritebackCommand> {
  if (!isRecord(value)) return invalidCommand();
  const base = parseCommandBase(value, WRITEBACK_KEYS);
  if (!base) return invalidCommand();
  const lastAssistantMessage = requiredStringField(value, "lastAssistantMessage");
  if (!lastAssistantMessage) return invalidCommand();
  if (base.client === "codex") {
    const turnId = optionalStringField(value, "turnId");
    const transcriptPath = optionalStringField(value, "transcriptPath");
    if (!turnId.ok || !transcriptPath.ok) return invalidCommand();
    return {
      ok: true,
      command: {
        ...base,
        client: "codex",
        lastAssistantMessage,
        ...(turnId.value ? { turnId: turnId.value } : {}),
        ...(transcriptPath.value ? { transcriptPath: transcriptPath.value } : {}),
      },
    };
  }
  const promptId = requiredStringField(value, "promptId");
  const transcriptPath = requiredStringField(value, "transcriptPath");
  if (!promptId || !transcriptPath) return invalidCommand();
  return {
    ok: true,
    command: {
      ...base,
      client: "claude-code",
      promptId,
      lastAssistantMessage,
      transcriptPath,
    },
  };
}

export function parseSkillReminderCommand(
  value: unknown,
): MemoryHookCommandParseResult<SkillReminderCommand> {
  if (!isRecord(value)) return invalidCommand();
  const base = parseCommandBase(value, SKILL_REMINDER_KEYS);
  if (!base) return invalidCommand();
  const transcriptPath = requiredStringField(value, "transcriptPath");
  const content = requiredContentField(value, "content");
  const triggers = skillReminderTriggers(value.triggers);
  if (!transcriptPath || !content || !triggers) return invalidCommand();
  if (base.client === "codex") {
    const turnId = requiredStringField(value, "turnId");
    if (!turnId) return invalidCommand();
    return {
      ok: true,
      command: {
        ...base,
        client: "codex",
        turnId,
        transcriptPath,
        content,
        triggers,
      },
    };
  }
  const promptId = requiredStringField(value, "promptId");
  if (!promptId) return invalidCommand();
  return {
    ok: true,
    command: {
      ...base,
      client: "claude-code",
      promptId,
      transcriptPath,
      content,
      triggers,
    },
  };
}

function parseCommandBase(
  value: Record<string, unknown>,
  allowedKeys: Readonly<Record<MemoryHookClient, ReadonlySet<string>>>,
): MemoryHookCommandBase<MemoryHookClient> | undefined {
  if (value.version !== MEMORY_HOOK_COMMAND_VERSION) return undefined;
  const client = value.client;
  if (client !== "codex" && client !== "claude-code") return undefined;
  if (Object.keys(value).some((key) => !allowedKeys[client].has(key))) return undefined;
  const sessionId = requiredStringField(value, "sessionId");
  if (!sessionId) return undefined;
  const cwd = optionalStringField(value, "cwd");
  const workspaceKind = optionalStringField(value, "workspaceKind");
  if (!cwd.ok || !workspaceKind.ok) return undefined;
  return {
    version: MEMORY_HOOK_COMMAND_VERSION,
    client,
    sessionId,
    ...(cwd.value ? { cwd: cwd.value } : {}),
    ...(workspaceKind.value ? { workspaceKind: workspaceKind.value } : {}),
  };
}

function requiredStringField(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const field = value[key];
  return typeof field === "string" && field.trim() ? field.trim() : undefined;
}

function requiredContentField(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const field = value[key];
  return typeof field === "string" && field.trim() ? field : undefined;
}

function skillReminderTriggers(value: unknown): SkillReminderTrigger[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const triggers: SkillReminderTrigger[] = [];
  for (const trigger of value) {
    if (trigger !== "cadence" && trigger !== "post_compaction") return undefined;
    if (!triggers.includes(trigger)) triggers.push(trigger);
  }
  return triggers;
}

function optionalStringField(
  value: Record<string, unknown>,
  key: string,
): { ok: true; value?: string } | { ok: false } {
  if (!Object.prototype.hasOwnProperty.call(value, key)) return { ok: true };
  const field = requiredStringField(value, key);
  return field ? { ok: true, value: field } : { ok: false };
}

function invalidCommand<Command>(): MemoryHookCommandParseResult<Command> {
  return { ok: false, error: INVALID_MEMORY_HOOK_COMMAND };
}
