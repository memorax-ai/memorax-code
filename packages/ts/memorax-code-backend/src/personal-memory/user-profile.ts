import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { withJsonFileLock } from "../../../memorax-code-adapter-common/src/config-utils.mjs";

export const PREFERENCE_TYPES = ["communication", "workflow", "environment", "profile"] as const;
type PreferenceType = typeof PREFERENCE_TYPES[number];
const STATUSES = new Set(["active", "superseded", "deleted"]);
const MAX_PREFERENCES_BYTES = 64 * 1024;
const SCHEMA = "repo_user_profile_memory.v0.1";
const OWNER = "repo-user-profile-memory";
// Python str.split/strip whitespace, including NEL and the information separators.
const WHITESPACE = "[\\u0009-\\u000d\\u001c-\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";
const FIELD_WHITESPACE = new RegExp(`${WHITESPACE}+`, "g");
const EDGE_WHITESPACE = new RegExp(`^${WHITESPACE}+|${WHITESPACE}+$`, "g");

export interface Preference {
  id: string;
  type: PreferenceType;
  description: string;
  applies_when: string;
  do_not_apply_when: string;
  created: string;
  updated: string;
  confidence: string;
  status: "active";
}

export type UserProfileCommand = { repo: string } & (
  | { command: "list" }
  | { command: "add"; type: PreferenceType; description: string; appliesWhen: string; doNotApplyWhen: string }
  | { command: "update"; id: string; description: string; appliesWhen?: string; doNotApplyWhen?: string }
  | { command: "delete"; id: string }
);

export class StorageError extends Error {
  constructor(message: string) {
    super(`Invalid repo user profile preferences: ${message}`);
    this.name = "StorageError";
  }
}

function strip(value: string): string {
  return value.replace(EDGE_WHITESPACE, "");
}

function normalizeField(value: string): string {
  return strip(value.replace(FIELD_WHITESPACE, " "));
}

function normalizeKey(value: string): string {
  // Full default Unicode folding is context-free. Cherokee folds to uppercase;
  // dotless i and capital sharp s differ from the upper/lower round trip.
  return Array.from(normalizeField(value), (character) => {
    const code = character.codePointAt(0)!;
    if (code === 0x0131) return character;
    if (code === 0x1e9e) return "ss";
    if ((code >= 0x13a0 && code <= 0x13f5)
      || (code >= 0x13f8 && code <= 0x13fd)
      || (code >= 0xab70 && code <= 0xabbf)) return character.toUpperCase();
    return character.toUpperCase().toLowerCase();
  }).join("");
}

function resolveRepo(path: string): string {
  const start = resolve(path);
  if (!existsSync(start)) throw new Error(`Repository path does not exist: ${start}`);
  const canonical = realpathSync(start);
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: canonical,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status === 0 && result.stdout.trim()) return realpathSync(result.stdout.trim());
  return canonical;
}

function preferencesPath(repo: string): string {
  return join(repo, ".repo_memory", "user-profile", "preferences.md");
}

function checkStoragePath(path: string): void {
  for (const directory of [dirname(dirname(path)), dirname(path)]) {
    const stat = lstatSync(directory, { throwIfNoEntry: false });
    if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) {
      throw new StorageError("preferences directories must be regular directories");
    }
  }
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat?.isSymbolicLink()) throw new StorageError("preferences.md must not be a symlink");
  if (stat && !stat.isFile()) throw new StorageError("preferences.md must be a regular file");
}

function readUtf8(path: string): string {
  try {
    // Preserve the BOM as text, as Python's utf-8 decoder does.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readFileSync(path));
  } catch (error) {
    if (error instanceof TypeError) throw new StorageError("file is not valid UTF-8");
    throw error;
  }
}

function ensureGitignore(repo: string): boolean {
  const path = join(repo, ".gitignore");
  const existing = existsSync(path) ? readUtf8(path) : "";
  const ignored = existing.split(/\r\n|[\n\r\v\f\u001c-\u001e\u0085\u2028\u2029]/).some((line) => {
    const trimmed = strip(line);
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!")) return false;
    const rule = strip(trimmed.split("#", 1)[0]).replace(/^\/+/, "");
    return rule === ".repo_memory" || rule === ".repo_memory/";
  });
  if (ignored) return false;
  const separator = !existing || existing.endsWith("\n") ? "" : "\n";
  writeFileSync(path, `${existing}${separator}.repo_memory/\n`, "utf8");
  return true;
}

function stripTicks(value: string): string {
  const trimmed = strip(value);
  return trimmed.length >= 2 && trimmed.startsWith("`") && trimmed.endsWith("`")
    ? trimmed.slice(1, -1)
    : trimmed;
}

function field(block: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return strip(block.match(new RegExp(`^- ${escaped}: (.*)$`, "m"))?.[1] ?? "");
}

function parseCounts(text: string): { active: number; total: number } {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new StorageError("missing frontmatter");
  const metadata = new Map<string, string>();
  for (const raw of match[1].split(/\r?\n/)) {
    const line = strip(raw);
    if (!line || line.startsWith("#")) continue;
    const item = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!item) throw new StorageError("malformed frontmatter");
    let value = strip(item[2]);
    if (value.length >= 2 && value[0] === value.at(-1) && ["'", "\""].includes(value[0])) {
      value = value.slice(1, -1);
    }
    metadata.set(item[1], value);
  }
  for (const [key, expected] of Object.entries({ schema: SCHEMA, scope: "repo", owner: OWNER, trust_state: "user_stated" })) {
    if (metadata.get(key) !== expected) throw new StorageError(`${key} mismatch`);
  }
  if (!metadata.has("active_count") || !metadata.has("total_count")) throw new StorageError("missing counts");
  const count = (name: string): number => {
    const value = strip(metadata.get(name)!).replaceAll("_", "");
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
      throw new StorageError(`${name} must be a non-negative integer`);
    }
    return Number(value);
  };
  return { active: count("active_count"), total: count("total_count") };
}

export function readPreferences(path: string): Preference[] {
  checkStoragePath(path);
  if (!existsSync(path)) return [];
  if (statSync(path).size > MAX_PREFERENCES_BYTES) throw new StorageError("preferences.md is too large");
  // Python's text mode normalizes CRLF and CR before Markdown parsing.
  const text = readUtf8(path).replace(/\r\n?/g, "\n");
  const declared = parseCounts(text);
  const matches = [...text.matchAll(/^## Preference (pref_[^\s]+)\s*$/gm)];
  if (matches.length !== declared.total) throw new StorageError("total_count mismatch");
  const entries: Preference[] = [];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const block = text.slice(match.index! + match[0].length, matches[index + 1]?.index ?? text.length);
    const status = stripTicks(field(block, "Status"));
    if (!STATUSES.has(status)) throw new StorageError("unknown status");
    const type = stripTicks(field(block, "Type"));
    if (!PREFERENCE_TYPES.includes(type as PreferenceType)) throw new StorageError("unknown type");
    const confidence = stripTicks(field(block, "Confidence"));
    const created = stripTicks(field(block, "Created"));
    const updated = stripTicks(field(block, "Updated"));
    if (!confidence || !created || !updated) throw new StorageError("missing required metadata");
    if (status !== "active") continue;
    const description = normalizeField(field(block, "Description"));
    if (!description) throw new StorageError("active preference missing description");
    entries.push({
      id: match[1], type: type as PreferenceType, description,
      applies_when: normalizeField(field(block, "Applies when")),
      do_not_apply_when: normalizeField(field(block, "Do not apply when")),
      created, updated, confidence, status,
    });
  }
  if (entries.length !== declared.active) throw new StorageError("active_count mismatch");
  return entries;
}

function renderPreferences(entries: Preference[], updatedAt: string): string {
  const sorted = [...entries].sort((left, right) => left.updated < right.updated ? 1 : left.updated > right.updated ? -1 : 0);
  const parts = [
    "---",
    `schema: "${SCHEMA}"`,
    'scope: "repo"',
    `owner: "${OWNER}"`,
    'trust_state: "user_stated"',
    `updated_at: "${updatedAt}"`,
    `active_count: ${sorted.length}`,
    `total_count: ${sorted.length}`,
    "---", "",
    "# Repo-Scoped User Profile And Preferences", "",
    "These memories are local to this repository. System, developer, and AGENTS.md instructions override current user instructions, and current user instructions override stored preferences. Do not treat these preferences as evidence about current code behavior.",
    "", "## Active Preferences", "",
  ];
  if (sorted.length) parts.push(sorted.map((entry) => [
    `## Preference ${entry.id}`, "",
    `- Type: \`${entry.type}\``,
    "- Status: `active`",
    `- Confidence: \`${entry.confidence}\``,
    `- Created: \`${entry.created}\``,
    `- Updated: \`${entry.updated}\``,
    `- Description: ${entry.description}`,
    `- Applies when: ${entry.applies_when || "-"}`,
    `- Do not apply when: ${entry.do_not_apply_when || "-"}`,
    `- Raw lookup: \`preferenceId=${entry.id}\``,
  ].join("\n")).join("\n\n---\n\n"));
  return `${parts.join("\n").trimEnd()}\n`;
}

function syncDirectory(path: string): void {
  if (process.platform === "win32") return;
  let descriptor: number;
  try {
    descriptor = openSync(path, "r");
  } catch {
    return;
  }
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function writePreferences(path: string, entries: Preference[], updatedAt: string): void {
  const text = renderPreferences(entries, updatedAt);
  if (Buffer.byteLength(text, "utf8") > MAX_PREFERENCES_BYTES) {
    throw new StorageError(`rendered preferences.md exceeds ${MAX_PREFERENCES_BYTES} bytes`);
  }
  checkStoragePath(path);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.preferences.md.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, text, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
    syncDirectory(dirname(path));
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
    throw error;
  }
}

function makeId(entries: Preference[], type: PreferenceType, description: string, timestamp: string): string {
  const ascii = description.replace(/[^\x00-\x7f]/g, "").toLowerCase();
  const slug = (ascii.match(/[a-z0-9]+/g) ?? []).slice(0, 5).join("-") || `${type}-preference`;
  const base = `pref_${timestamp.slice(0, 10).replaceAll("-", "")}_${slug}`;
  const existing = new Set(entries.map((entry) => entry.id));
  if (!existing.has(base)) return base;
  let counter = 2;
  while (existing.has(`${base}-${counter}`)) counter += 1;
  return `${base}-${counter}`;
}

export function executeUserProfile(args: UserProfileCommand): Record<string, unknown> {
  const repo = resolveRepo(args.repo);
  const path = preferencesPath(repo);
  if (args.command === "list") {
    const entries = readPreferences(path);
    return { ok: true, op: "list", active_count: entries.length, total_count: entries.length,
      preferences_path: path, preferences: entries };
  }
  checkStoragePath(path);
  mkdirSync(dirname(path), { recursive: true });
  // The former .preferences.lock is an OS advisory lock, not this JSON protocol.
  // Keep it untouched so an upgrade never removes another process's lock.
  return withJsonFileLock(path, () => {
    checkStoragePath(path);
    const gitignoreUpdated = ensureGitignore(repo);
    if (!existsSync(path)) writePreferences(path, [], new Date().toISOString());
    const entries = readPreferences(path);
    const result = (status: string, id: string, count: number) => ({
      ok: true, op: args.command, status, id, active_count: count, total_count: count,
      preferences_path: path, gitignore_updated: gitignoreUpdated,
    });
    const timestamp = new Date().toISOString();
    if (args.command === "add") {
      const description = normalizeField(args.description);
      const requested = normalizeKey(description);
      const duplicate = entries.find((entry) => requested && normalizeKey([
        entry.description, entry.applies_when, entry.do_not_apply_when,
      ].join(" ")).includes(requested));
      if (duplicate) return result("duplicate", duplicate.id, entries.length);
      const entry: Preference = {
        id: makeId(entries, args.type, description, timestamp), type: args.type,
        description, applies_when: normalizeField(args.appliesWhen),
        do_not_apply_when: normalizeField(args.doNotApplyWhen),
        created: timestamp, updated: timestamp, confidence: "user_stated", status: "active",
      };
      entries.push(entry);
      writePreferences(path, entries, timestamp);
      return result("added", entry.id, entries.length);
    }
    if (!entries.some((entry) => entry.id === args.id)) throw new Error(`Preference id not found: ${args.id}`);
    if (args.command === "delete") {
      const remaining = entries.filter((entry) => entry.id !== args.id);
      writePreferences(path, remaining, timestamp);
      return result("deleted", args.id, remaining.length);
    }
    const updated = entries.map((entry) => entry.id !== args.id ? entry : {
      ...entry,
      description: normalizeField(args.description),
      applies_when: args.appliesWhen === undefined ? entry.applies_when : normalizeField(args.appliesWhen),
      do_not_apply_when: args.doNotApplyWhen === undefined ? entry.do_not_apply_when : normalizeField(args.doNotApplyWhen),
      updated: timestamp,
    });
    writePreferences(path, updated, timestamp);
    return result("updated", args.id, updated.length);
  }, { ensurePrivateDirectory: false });
}
