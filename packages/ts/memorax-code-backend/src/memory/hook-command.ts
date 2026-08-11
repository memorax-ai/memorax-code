import { isRecord } from "../shared/record.js";

export const MEMORY_HOOK_COMMAND_VERSION = 1 as const;
export const INVALID_MEMORY_HOOK_COMMAND = "invalid memory Hook command";

export type MemoryHookClient = "codex" | "claude-code" | "opencode";

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
  opencode: new Set([...BASE_COMMAND_KEYS, "userMessageId", "prompt"]),
};
const WRITEBACK_KEYS: Readonly<Partial<Record<MemoryHookClient, ReadonlySet<string>>>> = {
  codex: new Set([...BASE_COMMAND_KEYS, "turnId", "lastAssistantMessage", "transcriptPath"]),
  "claude-code": new Set([
    ...BASE_COMMAND_KEYS,
    "promptId",
    "lastAssistantMessage",
    "transcriptPath",
  ]),
};
const SKILL_REMINDER_KEYS: Readonly<Partial<Record<MemoryHookClient, ReadonlySet<string>>>> = {
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

export type OpenCodeTurnStartCommand = MemoryHookCommandBase<"opencode"> & Readonly<{
  userMessageId: string;
  prompt: string;
}>;

export type TurnStartCommand = CodexTurnStartCommand | ClaudeTurnStartCommand | OpenCodeTurnStartCommand;

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
  if (!prompt) return invalidCommand();
  if (base.client === "codex") {
    const transcriptPath = requiredStringField(value, "transcriptPath");
    const turnId = optionalStringField(value, "turnId");
    if (!transcriptPath || !turnId.ok) return invalidCommand();
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
  if (base.client === "opencode") {
    const userMessageId = requiredStringField(value, "userMessageId");
    if (!userMessageId) return invalidCommand();
    return {
      ok: true,
      command: {
        ...base,
        client: "opencode",
        userMessageId,
        prompt,
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
  if (base.client !== "claude-code") return invalidCommand();
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
  allowedKeys: Readonly<Partial<Record<MemoryHookClient, ReadonlySet<string>>>>,
): MemoryHookCommandBase<MemoryHookClient> | undefined {
  if (value.version !== MEMORY_HOOK_COMMAND_VERSION) return undefined;
  const client = value.client;
  if (client !== "codex" && client !== "claude-code" && client !== "opencode") return undefined;
  const clientKeys = allowedKeys[client];
  if (!clientKeys || Object.keys(value).some((key) => !clientKeys.has(key))) return undefined;
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
