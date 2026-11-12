import { writeFileSync } from "node:fs";
import { basename } from "node:path";
import {
  assertRange,
  canonicalPath,
  commandAvailable,
  commandOutput,
  failedOutput,
  parseInteger,
  RepoMemoryError,
  requiredValue,
  runCommand,
  unique,
  type CommandOutput,
} from "./shared.js";
import { parseRemoteUrl } from "./prepare.js";

export interface GitCommitFacetOptions {
  repoPath: string;
  snapshotRef: string;
  limit: number;
  summaryChars: number;
}

export function fetchGitCommitFacets(options: GitCommitFacetOptions): Record<string, unknown>[] {
  const repoPath = canonicalPath(options.repoPath);
  const snapshotSha = resolveSnapshotSha(repoPath, options.snapshotRef);
  const shas = gitStdout(
    repoPath,
    ["rev-list", "--max-count", String(options.limit), snapshotSha],
    `git could not list commits from '${options.snapshotRef}' in ${repoPath}`,
  ).split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  const name = repoName(repoPath);
  return shas.map((sha) => commitFacet(name, repoPath, sha, options.summaryChars));
}

export function executeGitCommitFacets(args: string[]): CommandOutput {
  try {
    const options: GitCommitFacetOptions & { pretty: boolean; out?: string } = {
      repoPath: ".",
      snapshotRef: "HEAD",
      limit: 30,
      summaryChars: 4000,
      pretty: false,
    };
    for (let index = 0; index < args.length; index += 1) {
      const value = args[index];
      if (value === "--repo-path") options.repoPath = requiredValue(args, index++, value);
      else if (value === "--snapshot-ref") options.snapshotRef = requiredValue(args, index++, value);
      else if (value === "--limit") options.limit = parseInteger(requiredValue(args, index++, value), value);
      else if (value === "--summary-chars") options.summaryChars = parseInteger(requiredValue(args, index++, value), value);
      else if (value === "--out") options.out = requiredValue(args, index++, value);
      else if (value === "--pretty") options.pretty = true;
      else if (value === "--help" || value === "-h") {
        return { exitCode: 0, stdout: `${gitCommitFacetsUsage()}\n`, stderr: "" };
      } else {
        throw new RepoMemoryError(`unrecognized arguments: ${value}`, 2);
      }
    }
    assertRange("--limit", options.limit, 1, 500);
    if (options.summaryChars < 100) throw new RepoMemoryError("--summary-chars must be at least 100", 2);
    const facets = fetchGitCommitFacets(options);
    const output = commandOutput(facets, options.pretty);
    if (options.out) {
      writeFileSync(canonicalPath(options.out), output.stdout, "utf8");
      return { ...output, stdout: "" };
    }
    return output;
  } catch (error) {
    return failedOutput(error);
  }
}

export function gitCommitFacetsUsage(): string {
  return "Usage: memorax-code repo-memory git-commits [--repo-path PATH] [--snapshot-ref REF] [--limit N] [--summary-chars N] [--pretty] [--out PATH]";
}

function gitStdout(repoPath: string, args: string[], message: string): string {
  if (!commandAvailable("git")) throw new RepoMemoryError("git is required for local commit facets");
  const result = runCommand("git", ["-C", repoPath, ...args], { cwd: repoPath });
  if (result.status !== 0) throw new RepoMemoryError(`${message}:\n${result.stderr.trim()}`);
  return result.stdout;
}

function resolveSnapshotSha(repoPath: string, snapshotRef: string): string {
  return gitStdout(
    repoPath,
    ["rev-parse", "--verify", `${snapshotRef}^{commit}`],
    `git could not resolve snapshot ref '${snapshotRef}' in ${repoPath}`,
  ).trim();
}

function repoName(repoPath: string): string {
  const result = runCommand("git", ["-C", repoPath, "remote", "get-url", "origin"], { cwd: repoPath });
  const parsed = result.status === 0 ? parseRemoteUrl(result.stdout.trim()).repo : "";
  return parsed || basename(repoPath);
}

function commitFacet(repo: string, repoPath: string, sha: string, summaryChars: number): Record<string, unknown> {
  const fields = gitStdout(
    repoPath,
    ["show", "-s", "--date=iso-strict", "--format=%H%x1f%h%x1f%P%x1f%an%x1f%ad%x1f%s", sha],
    `git could not read commit metadata for ${sha}`,
  ).replace(/\r?\n$/, "").split("\x1f");
  while (fields.length < 6) fields.push("");
  const [fullSha, shortSha, parents, author, authoredAt, title] = fields;
  const body = gitStdout(repoPath, ["show", "-s", "--format=%B", sha], `git could not read commit body for ${sha}`);
  const stats = parseNumstat(gitStdout(
    repoPath,
    ["show", "--format=", "--numstat", "--no-renames", sha],
    `git could not read commit diff for ${sha}`,
  ));
  const modules = pathModules(stats.files);
  const keys = keyFiles(stats.files);
  const summary = boundedSummary([body], summaryChars) || title;
  const evidence = unique([
    shortSha && title ? `commit ${shortSha}: ${title}` : "",
    shortSha && keys.length ? `commit ${shortSha} changed ${keys.join(", ")}` : "",
  ].filter(Boolean));
  const parentList = parents.split(/\s+/).filter(Boolean);
  return {
    facetId: `commit.${shortSha || fullSha.slice(0, 12)}`,
    sourceType: "commit",
    provider: "local_git",
    repo,
    sha: fullSha,
    short_sha: shortSha,
    parents: parentList,
    is_merge: parentList.length > 1,
    title,
    summary,
    author,
    authoredAt,
    updatedAt: authoredAt,
    files: stats.files,
    path_modules: modules,
    key_files: keys,
    changed_files: stats.files.length,
    additions: stats.additions,
    deletions: stats.deletions,
    symbols: extractSymbols([title, summary, ...stats.files].join("\n")),
    evidence,
  };
}

function parseNumstat(text: string): { files: string[]; additions: number; deletions: number } {
  const files: string[] = [];
  let additions = 0;
  let deletions = 0;
  for (const line of text.split(/\r?\n/)) {
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    if (/^\d+$/.test(parts[0])) additions += Number(parts[0]);
    if (/^\d+$/.test(parts[1])) deletions += Number(parts[1]);
    if (parts[2]) files.push(parts[2]);
  }
  return { files: unique(files), additions, deletions };
}

function pathModule(path: string): string {
  const parts = path.split("/").filter((part) => part && part !== "." && part !== "..");
  if (!parts.length) return "";
  if (parts[0] === ".github") return ".github/workflows";
  if (parts.length === 1 && parts[0].includes(".")) return "";
  return parts[0];
}

function pathModules(files: string[]): string[] {
  return unique(files.map(pathModule).filter(Boolean));
}

function keyFiles(files: string[], limit = 8): string[] {
  return [...files].sort((left, right) => {
    const leftScore = pathScore(left);
    const rightScore = pathScore(right);
    if (leftScore !== rightScore) return rightScore - leftScore;
    if (left.length !== right.length) return left.length - right.length;
    return left.localeCompare(right);
  }).slice(0, limit);
}

function pathScore(path: string): number {
  const lower = path.toLowerCase();
  let score = 0;
  if (lower.includes("readme") || lower.endsWith(".md") || lower.endsWith(".rst")) score += 2;
  if (["/src/", "/core/", "/server", "/api", "/train", "/rollout", "/loss", "/model", "/actor", "/data"]
    .some((token) => lower.includes(token))) score += 4;
  if ([".py", ".ts", ".tsx", ".rs", ".go", ".sh", ".yaml", ".yml", ".toml", ".json"]
    .some((extension) => lower.endsWith(extension))) score += 1;
  return score;
}

function boundedSummary(parts: string[], maxChars: number): string {
  const text = parts.map((part) => part.trim()).filter(Boolean).join("\n\n");
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 3)}...`;
}

function extractSymbols(text: string): string[] {
  const symbols: string[] = [];
  for (const match of text.matchAll(/\b[$A-Z_a-z][$\w]*\b/g)) {
    const value = match[0];
    if (/[a-z][A-Z]/.test(value) || /^[A-Z0-9_]{2,}$/.test(value) || value.includes("_") || value.includes("$")) {
      symbols.push(value);
    }
  }
  return unique(symbols);
}
