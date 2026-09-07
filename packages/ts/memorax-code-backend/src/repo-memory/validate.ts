import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import {
  commandOutput,
  failedOutput,
  RepoMemoryError,
  type CommandOutput,
} from "./shared.js";

const BASELINE_FILES = [
  "PROFILE.md",
  "resources/commits.md",
  "resources/prs.md",
  "resources/issues.md",
  "raw/git-commits.json",
];
const PROVIDER_RAW_FILES = ["raw/github-facets.json", "raw/gitlab-facets.json"];
const PROVIDER_RESOURCE_FILES = ["resources/prs.md", "resources/issues.md"];
const DISABLED_RESOURCE_SOURCES = new Set([
  "history_disabled",
  "provider_skipped_local_only",
  "provider_unavailable",
  "github_resource_facets_unavailable",
  "gitlab_resource_facets_unavailable",
  "provider_unavailable_local_only",
]);
const USER_PROFILE_SIDECAR = "user-profile/preferences.md";
const PROCEDURE_SIDECAR_DIRECTORY = "procedure-memory";

export interface RepoMemoryValidationReport {
  ok: boolean;
  errors: string[];
  warnings: string[];
  checked: string[];
}

export function resolveMemoryRoot(path: string): string {
  const candidate = resolve(path);
  return basename(candidate) === ".repo_memory" ? candidate : join(candidate, ".repo_memory");
}

export function validateRepoMemory(memory: string): RepoMemoryValidationReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const checked: string[] = [];

  if (!existsSync(memory)) {
    errors.push(`${memory}: .repo_memory directory is missing`);
    return { ok: false, errors, warnings, checked };
  }
  if (!lstatSync(memory).isDirectory()) {
    errors.push(`${memory}: expected .repo_memory to be a directory`);
    return { ok: false, errors, warnings, checked };
  }

  for (const path of BASELINE_FILES) checkExists(memory, path, errors, checked);
  for (const path of markdownPaths(memory)) validateMarkdown(path, memory, errors, warnings, checked);

  const jsonPaths = filesUnder(join(memory, "raw"), ".json");
  const providerRaw = PROVIDER_RAW_FILES
    .map((path) => join(memory, path))
    .filter((path) => existsSync(path));
  if (providerRaw.length > 0) {
    for (const path of PROVIDER_RESOURCE_FILES) checkExists(memory, path, errors, checked);
  }
  for (const path of jsonPaths) validateJson(path, memory, errors, checked);

  const uniqueChecked = [...new Set(checked)].sort();
  return { ok: errors.length === 0, errors, warnings, checked: uniqueChecked };
}

export function executeValidate(args: string[]): CommandOutput {
  try {
    let path: string | undefined;
    let pretty = false;
    for (const arg of args) {
      if (arg === "--pretty") pretty = true;
      else if (arg === "--help" || arg === "-h") {
        return { exitCode: 0, stdout: `${validateUsage()}\n`, stderr: "" };
      } else if (arg.startsWith("-")) {
        throw new RepoMemoryError(`unrecognized arguments: ${arg}`, 2);
      } else if (path) {
        throw new RepoMemoryError(`unrecognized arguments: ${arg}`, 2);
      } else {
        path = arg;
      }
    }
    if (!path) throw new RepoMemoryError("PATH is required", 2);
    const report = validateRepoMemory(resolveMemoryRoot(path));
    return commandOutput(report, pretty, report.ok ? 0 : 1);
  } catch (error) {
    return failedOutput(error);
  }
}

export function validateUsage(): string {
  return "Usage: memorax-code repo-memory validate PATH [--pretty]";
}

function markdownPaths(memory: string): string[] {
  return filesUnder(memory, ".md").filter((path) => {
    const rel = relativePath(path, memory);
    return rel !== USER_PROFILE_SIDECAR && rel.split("/")[0] !== PROCEDURE_SIDECAR_DIRECTORY;
  });
}

function filesUnder(root: string, extension: string): string[] {
  if (!existsSync(root) || !lstatSync(root).isDirectory()) return [];
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(path, extension));
    else if (entry.isFile() && entry.name.endsWith(extension)) files.push(path);
  }
  return files.sort();
}

function parseFrontmatter(text: string): Record<string, unknown> {
  if (!text.startsWith("---\n")) return {};
  const end = text.indexOf("\n---", 4);
  if (end < 0) return {};
  const values: Record<string, unknown> = {};
  for (const line of text.slice(4, end).split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    const raw = line.slice(separator + 1).trim();
    if (!key) continue;
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
      values[key] = raw.slice(1, -1);
    } else if (/^-?\d+$/.test(raw)) {
      values[key] = Number(raw);
    } else if (raw.toLowerCase() === "true") {
      values[key] = true;
    } else if (raw.toLowerCase() === "false") {
      values[key] = false;
    } else {
      values[key] = raw;
    }
  }
  return values;
}

function bodyAfterFrontmatter(text: string): string {
  if (!text.startsWith("---\n")) return text;
  const end = text.indexOf("\n---", 4);
  if (end < 0) return text;
  return text.slice(end + 4).replace(/^\n+/, "");
}

function itemSectionCount(text: string): number {
  let titleSeen = false;
  let count = 0;
  for (const line of bodyAfterFrontmatter(text).split(/\r?\n/)) {
    if (line.startsWith("# ") && !titleSeen) {
      titleSeen = true;
      continue;
    }
    if (titleSeen && line.startsWith("## ")) count += 1;
  }
  return count;
}

function placeholderMatches(text: string): string[] {
  const withoutCode = text
    .replace(/```.*?```/gs, "")
    .replace(/`[^`\n]*`/g, "");
  const matches: string[] = [];
  const pattern = /\[([^\]\n]+)\]/g;
  for (const match of withoutCode.matchAll(pattern)) {
    const end = (match.index ?? 0) + match[0].length;
    if (/^[ \t\r\n]*\(/.test(withoutCode.slice(end))) continue;
    const value = match[1].trim();
    if (!value || value.startsWith("#")) continue;
    if (/[A-Za-z]/.test(value)) matches.push(`[${value}]`);
  }
  return matches;
}

function checkExists(memory: string, rel: string, errors: string[], checked: string[]): boolean {
  const path = join(memory, rel);
  checked.push(rel);
  if (!existsSync(path)) {
    errors.push(`${rel}: required file is missing`);
    return false;
  }
  if (!lstatSync(path).isFile()) {
    errors.push(`${rel}: expected a file`);
    return false;
  }
  return true;
}

function validateJson(path: string, memory: string, errors: string[], checked: string[]): void {
  const rel = relativePath(path, memory);
  checked.push(rel);
  try {
    JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      errors.push(`${rel}: invalid JSON: ${error.message}`);
    } else {
      errors.push(`${rel}: could not read JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function validateMarkdown(
  path: string,
  memory: string,
  errors: string[],
  _warnings: string[],
  checked: string[],
): void {
  const rel = relativePath(path, memory);
  checked.push(rel);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    errors.push(`${rel}: could not read Markdown: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const frontmatter = parseFrontmatter(text);
  if (!frontmatter.schema) errors.push(`${rel}: frontmatter field 'schema' is missing`);
  const placeholders = placeholderMatches(text);
  if (placeholders.length > 0) {
    errors.push(`${rel}: unresolved bracket placeholder(s): ${placeholders.join(", ")}`);
  }
  if (basename(resolve(path, "..")) !== "resources") return;

  for (const field of ["source", "resource_count", "trust_state", "raw_source"]) {
    if (!(field in frontmatter)) errors.push(`${rel}: frontmatter field '${field}' is missing`);
  }
  const expected = frontmatter.resource_count;
  const actual = itemSectionCount(text);
  if (typeof expected === "number" && Number.isInteger(expected)) {
    if (expected !== actual) errors.push(`${rel}: resource_count is ${expected}, but found ${actual} item section(s)`);
  } else if (expected !== undefined) {
    errors.push(`${rel}: resource_count must be an integer`);
  }

  const source = frontmatter.source;
  const rawSource = frontmatter.raw_source;
  if ("source" in frontmatter && !source) errors.push(`${rel}: frontmatter field 'source' must not be empty`);
  if ("trust_state" in frontmatter && !frontmatter.trust_state) {
    errors.push(`${rel}: frontmatter field 'trust_state' must not be empty`);
  }
  if (typeof source === "string" && DISABLED_RESOURCE_SOURCES.has(source)) {
    if (typeof expected === "number" && expected !== 0) {
      errors.push(`${rel}: disabled or unavailable resource source '${source}' must use resource_count 0`);
    }
    if (rawSource) errors.push(`${rel}: disabled or unavailable resource source '${source}' must use an empty raw_source`);
  }
  const resourceName = basename(path);
  if (["commits.md", "prs.md", "issues.md"].includes(resourceName)
    && !(typeof source === "string" && DISABLED_RESOURCE_SOURCES.has(source))
    && rawSource === "") {
    errors.push(`${rel}: empty raw_source requires a disabled or unavailable source`);
  }
  if (["prs.md", "issues.md"].includes(resourceName) && rawSourcePointsToProvider(rawSource)) {
    const providerPath = resolve(path, "..", rawSource);
    if (!existsSync(providerPath)) errors.push(`${rel}: provider raw evidence is missing for raw_source '${rawSource}'`);
  }
}

function rawSourcePointsToProvider(value: unknown): value is string {
  return typeof value === "string"
    && (value.endsWith("github-facets.json") || value.endsWith("gitlab-facets.json"));
}

function relativePath(path: string, memory: string): string {
  return relative(memory, path).split("\\").join("/");
}
