import { createAutomaticMemoryWritebackRuntime } from "./automatic-writeback.js";
import {
  createCodexMemoryHookRuntime,
  type CodexMemoryHookRuntimeOptions,
  type CodexMemoryHookWritebackResult,
} from "../clients/codex/memory-hook-runtime.js";
import {
  createClaudeMemoryHookRuntime,
  type ClaudeMemoryHookRuntimeOptions,
  type ClaudeMemoryHookWritebackResult,
} from "../clients/claude/memory-hook-runtime.js";
import {
  createOpenCodeMemoryHookRuntime,
  type OpenCodeMemoryHookWritebackResult,
} from "../clients/opencode/memory-hook-runtime.js";
import { createMemoryTurnCoordinator } from "./turn-coordinator.js";
import {
  createRepositoryMemorySessionRuntime,
} from "./repository-session.js";
import type {
  MemoryHookTurnStartResult,
  TurnStartCommand,
  WritebackCommand,
} from "./hook-command.js";

export type MemoryServiceOptions = Omit<
  CodexMemoryHookRuntimeOptions,
  "automaticWriteback" | "repositoryMemorySession" | "turnCoordinator"
> & Pick<ClaudeMemoryHookRuntimeOptions, "transcriptReadAttempts" | "transcriptRetryDelayMs">;

type MemoryHookWritebackResult =
  | CodexMemoryHookWritebackResult
  | ClaudeMemoryHookWritebackResult
  | OpenCodeMemoryHookWritebackResult;

export type MemoryService = {
  recordTurnStart(command: TurnStartCommand): Promise<MemoryHookTurnStartResult>;
  writebackTurn(command: WritebackCommand): Promise<MemoryHookWritebackResult>;
  drain(): Promise<void>;
  close(): void;
};

export function createMemoryService(options: MemoryServiceOptions = {}): MemoryService {
  const automaticWriteback = createAutomaticMemoryWritebackRuntime({
    diagnosticLogger: options.diagnosticLogger,
  });
  const repositoryMemorySession = createRepositoryMemorySessionRuntime({
    onScopeUpgrade: automaticWriteback.discardForScopeUpgrade,
  });
  const turnCoordinator = createMemoryTurnCoordinator({
    automaticWriteback: automaticWriteback.enqueue,
    now: options.now,
    ttlMs: options.ttlMs,
    maxEntries: options.maxEntries,
    cleanupIntervalMs: options.cleanupIntervalMs,
  });
  const codexHook = createCodexMemoryHookRuntime({
    ...options,
    repositoryMemorySession,
    turnCoordinator,
  });
  const claudeHook = createClaudeMemoryHookRuntime({
    ...options,
    repositoryMemorySession,
    turnCoordinator,
  });
  const openCodeHook = createOpenCodeMemoryHookRuntime({
    ...options,
    repositoryMemorySession,
    turnCoordinator,
  });
  let closed = false;
  return {
    async recordTurnStart(command) {
      switch (command.client) {
        case "codex":
          return await codexHook.recordTurnStart(command);
        case "claude-code":
          return await claudeHook.recordTurnStart(command);
        case "opencode":
          return await openCodeHook.recordTurnStart(command);
      }
      return unsupportedMemoryHookCommand(command);
    },
    async writebackTurn(command) {
      switch (command.client) {
        case "codex":
          return await codexHook.writeback(command);
        case "claude-code":
          return await claudeHook.writeback(command);
        case "opencode":
          return await openCodeHook.writeback(command);
      }
      return unsupportedMemoryHookCommand(command);
    },
    async drain() {
      await automaticWriteback.drain();
    },
    close() {
      if (closed) return;
      closed = true;
      codexHook.close();
      claudeHook.close();
      openCodeHook.close();
      turnCoordinator.close();
      repositoryMemorySession.close();
      automaticWriteback.close();
    },
  };
}

function unsupportedMemoryHookCommand(command: never): never {
  void command;
  throw new Error("unsupported memory Hook command");
}
