import { commandAvailable, RepoMemoryError, runCommand, unique } from "./shared.js";

export type JsonObject = Record<string, unknown>;

export function textField(value: unknown, ...keys: string[]): string {
  if (typeof value === "string") return value.trim();
  if (!isObject(value)) return "";
  for (const key of keys) {
    const item = value[key];
    if (typeof item === "string" && item.trim()) return item.trim();
  }
  return "";
}

export function integerField(value: unknown, key = "number", allowString = false): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (!isObject(value)) return undefined;
  const item = value[key];
  if (typeof item === "number" && Number.isInteger(item)) return item;
  if (allowString && typeof item === "string" && /^\d+$/.test(item)) return Number(item);
  return undefined;
}

export function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function objectList(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter(isObject) : [];
}

export function uniqueStrings(values: Iterable<string>): string[] {
  return unique([...values].filter(Boolean));
}

export function uniqueNumbers(values: Iterable<number>): number[] {
  return unique([...values].filter((value) => Number.isInteger(value)));
}

export function boundedSummary(parts: Iterable<string>, maxChars: number): string {
  const text = [...parts].map((part) => part.trim()).filter(Boolean).join("\n\n");
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 3)}...`;
}

export function extractSymbols(text: string): string[] {
  const symbols: string[] = [];
  for (const match of text.matchAll(/\b[$A-Z_a-z][$\w]*\b/g)) {
    const value = match[0];
    if (/[a-z][A-Z]/.test(value) || /^[A-Z0-9_]{2,}$/.test(value) || value.includes("_") || value.includes("$")) {
      symbols.push(value);
    }
  }
  return uniqueStrings(symbols);
}

export function commitSha(value: unknown): string {
  if (isObject(value) && isObject(value.commit)) return textField(value.commit, "oid", "sha", "abbreviatedOid");
  return textField(value, "oid", "sha", "abbreviatedOid");
}

export function commitHeadline(value: unknown): string {
  if (isObject(value) && isObject(value.commit)) return textField(value.commit, "messageHeadline", "message", "title");
  return textField(value, "messageHeadline", "message", "title");
}

export function bodyText(value: unknown): string {
  return textField(value, "body", "title", "name");
}

export function resolveSnapshotSha(repoPath: string, snapshotRef: string, subject: string): string {
  requireGit(subject);
  const result = runCommand("git", ["-C", repoPath, "rev-parse", "--verify", `${snapshotRef}^{commit}`], { cwd: repoPath });
  if (result.status !== 0) {
    throw new RepoMemoryError(`git could not resolve snapshot ref '${snapshotRef}' in ${repoPath}:\n${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

export function isGitAncestor(repoPath: string, ancestorSha: string, descendantSha: string): boolean {
  const result = runCommand("git", ["-C", repoPath, "merge-base", "--is-ancestor", ancestorSha, descendantSha], { cwd: repoPath });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  const stderr = result.stderr.trim();
  const normalized = stderr.toLowerCase();
  if (normalized.includes("not a valid commit")
    || normalized.includes("no such commit")
    || normalized.includes("not a valid object name")) return false;
  throw new RepoMemoryError(`git could not compare ${ancestorSha} with snapshot ${descendantSha} in ${repoPath}:\n${stderr}`);
}

function requireGit(subject: string): void {
  if (!commandAvailable("git")) throw new RepoMemoryError(`git is required for ${subject} snapshot filtering`);
}
