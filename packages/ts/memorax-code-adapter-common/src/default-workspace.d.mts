export type DefaultWorkspaceOptions = Readonly<{
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  readFile?: (path: string) => string;
  realpath?: (path: string) => string;
  execFile?: typeof import("node:child_process").execFileSync;
}>;

export function resolveWorkBuddyWorkspaceKind(
  input: { cwd?: unknown; workspace_kind?: unknown; workspaceKind?: unknown },
  options?: DefaultWorkspaceOptions,
): string | undefined;

export function isOpenCodeDefaultWorkspace(cwd: string | undefined, options?: DefaultWorkspaceOptions): boolean;

export function isQoderManagedTaskWorkspace(value: string | undefined, options?: DefaultWorkspaceOptions): boolean;

export type CodexWorkspaceOptions = Readonly<{
  env?: NodeJS.ProcessEnv;
  path?: typeof import("node:path").posix;
  managedRoots?: readonly string[];
  canonicalize?: (path: string) => string | undefined;
}>;

export function resolveCodexWorkspaceKind(
  input: { cwd?: unknown; workspace_kind?: unknown; workspaceKind?: unknown },
  options?: CodexWorkspaceOptions,
): string | undefined;

export function isCodexManagedTaskWorkspace(value: string | undefined, options?: CodexWorkspaceOptions): boolean;
