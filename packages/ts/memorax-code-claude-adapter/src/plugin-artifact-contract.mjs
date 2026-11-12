import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const ADAPTER_ARTIFACT_ENTRIES = [
  ".claude-plugin",
  "hooks",
  "runtime-hooks",
  "scripts",
  "src",
  "package.json",
];
const SOURCE_ONLY_FILE_NAMES = new Set([".gitignore"]);

export const CLAUDE_PLUGIN_HOOK_COMMAND_FILES = Object.freeze([
  "runtime-hook.mjs",
]);

export function collectClaudePluginArtifactSources({ adapterRoot }) {
  const resolvedAdapterRoot = resolve(adapterRoot);
  const sources = [];
  for (const entry of ADAPTER_ARTIFACT_ENTRIES) {
    collectRegularFiles(join(resolvedAdapterRoot, entry), entry, sources);
  }
  collectSharedSkill(resolvedAdapterRoot, sources);
  collectRegularFiles(
    join(resolvedAdapterRoot, "..", "memorax-code-adapter-common", "src"),
    "memorax-code-adapter-common/src",
    sources,
  );
  sources.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  assertUniqueDestinations(sources);
  return sources;
}

export function inspectClaudePluginArtifact(pluginRoot, sources) {
  const missing = new Set();
  const symbolicLinks = new Set();
  const nonFiles = new Set();
  for (const { relativePath } of sources) {
    const problem = inspectArtifactFile(pluginRoot, relativePath);
    if (problem?.kind === "missing") missing.add(relativePath);
    else if (problem?.kind === "symbolic_link") symbolicLinks.add(problem.path);
    else if (problem?.kind === "non_file") nonFiles.add(problem.path);
  }
  return {
    ok: missing.size === 0 && symbolicLinks.size === 0 && nonFiles.size === 0,
    missing: [...missing].sort(),
    symbolicLinks: [...symbolicLinks].sort(),
    nonFiles: [...nonFiles].sort(),
  };
}

export function describeClaudePluginArtifactProblems(inspection, limit = 12) {
  const problems = [
    ...inspection.missing.map((path) => `missing ${path}`),
    ...inspection.symbolicLinks.map((path) => `symbolic link ${path}`),
    ...inspection.nonFiles.map((path) => `non-file ${path}`),
  ];
  const visible = problems.slice(0, limit);
  if (problems.length > visible.length) visible.push(`and ${problems.length - visible.length} more`);
  return visible.join(", ");
}

function collectSharedSkill(adapterRoot, sources) {
  const skillPath = join(adapterRoot, "skills", "memorax-code");
  const metadata = lstatSync(skillPath);
  if (!metadata.isSymbolicLink()) {
    if (!metadata.isDirectory()) {
      throw new Error("Claude plugin skill source is not a directory: skills/memorax-code");
    }
    collectRegularFiles(skillPath, "skills/memorax-code", sources);
    return;
  }

  // Only the canonical shared Skill may be linked in source; artifact files are materialized.
  const expectedSkillPath = join(
    adapterRoot,
    "..",
    "memorax-code-codex-adapter",
    "skills",
    "memorax-code",
  );
  if (realpathSync(skillPath) !== realpathSync(expectedSkillPath)) {
    throw new Error("Claude plugin skill link does not resolve to the shared memorax-code source");
  }
  collectRegularFiles(realpathSync(skillPath), "skills/memorax-code", sources);
}

function collectRegularFiles(sourcePath, relativePath, sources) {
  const metadata = lstatSync(sourcePath);
  if (metadata.isSymbolicLink()) {
    throw new Error(`Claude plugin artifact source contains a symbolic link: ${normalize(relativePath)}`);
  }
  if (metadata.isFile()) {
    sources.push({
      sourcePath,
      relativePath: normalize(relativePath),
    });
    return;
  }
  if (!metadata.isDirectory()) {
    throw new Error(`Claude plugin artifact source is not a regular file or directory: ${normalize(relativePath)}`);
  }
  for (const entry of readdirSync(sourcePath, { withFileTypes: true })) {
    if (SOURCE_ONLY_FILE_NAMES.has(entry.name)) continue;
    collectRegularFiles(
      join(sourcePath, entry.name),
      join(relativePath, entry.name),
      sources,
    );
  }
}

function inspectArtifactFile(pluginRoot, relativePath) {
  const root = resolve(pluginRoot);
  const parts = relativePath.split("/");
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]);
    let metadata;
    try {
      metadata = lstatSync(current);
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return { kind: "missing" };
      throw error;
    }
    const currentRelative = normalize(relative(root, current));
    if (metadata.isSymbolicLink()) return { kind: "symbolic_link", path: currentRelative };
    const final = index === parts.length - 1;
    if ((final && !metadata.isFile()) || (!final && !metadata.isDirectory())) {
      return { kind: "non_file", path: currentRelative };
    }
  }
  return undefined;
}

function assertUniqueDestinations(sources) {
  const seen = new Set();
  for (const source of sources) {
    if (seen.has(source.relativePath)) {
      throw new Error(`duplicate Claude plugin artifact path: ${source.relativePath}`);
    }
    seen.add(source.relativePath);
  }
}

function normalize(path) {
  return sep === "/" ? path : path.replaceAll(sep, "/");
}
