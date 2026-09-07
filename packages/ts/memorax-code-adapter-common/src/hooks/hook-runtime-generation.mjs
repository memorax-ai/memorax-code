import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { withJsonFileLock } from "../config-utils.mjs";
import {
  ensurePrivateDirectory,
  readJsonRuntimeRecord,
  writePrivateJsonRecord,
} from "../runtime-record.mjs";

export const CLIENT_HOOK_RUNTIME_ABI = 1;

const GENERATION_RECORD_VERSION = 1;
const CURRENT_RECORD_VERSION = 1;
const GENERATION_ID_PATTERN = /^[a-zA-Z0-9._-]{1,160}$/;
const CONTENT_DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const CLIENT_ADAPTER_DIRS = Object.freeze({
  codex: "memorax-code-codex-adapter",
  "claude-code": "memorax-code-claude-adapter",
});
const CLIENT_COMPONENTS = Object.freeze({
  codex: new Set([
    "capture-cwd",
    "ensure-backend",
    "memory-skill-reminder",
    "memory-writeback",
  ]),
  "claude-code": new Set([
    "capture-cwd",
    "ensure-backend",
    "memory-cli-session",
    "memory-skill-reminder",
    "memory-turn",
  ]),
});
const RUNTIME_SOURCE_TREES = Object.freeze([
  "lib/memorax-code-adapter-common/src",
  "lib/memorax-code-codex-adapter/src",
  "lib/memorax-code-codex-adapter/runtime-hooks",
  "lib/memorax-code-claude-adapter/src",
  "lib/memorax-code-claude-adapter/runtime-hooks",
]);

export function clientHookRuntimePaths(memoraxCodeHome) {
  const home = resolve(memoraxCodeHome);
  const root = join(home, "runtime", "client-hooks");
  return {
    home,
    root,
    currentPath: join(root, "current.json"),
    generationsRoot: join(root, "generations"),
    installLockPath: join(root, "install-state.json"),
  };
}

// Staging leaves current authority unchanged so failed lifecycle readiness
// checks cannot replace the active generation. Activation is a separate step.
export function stageClientHookRuntimeGeneration({
  packageRoot,
  memoraxCodeHome,
  now = () => new Date(),
  syncFile = syncRegularFile,
  syncDirectory: syncDir = syncDirectory,
} = {}) {
  const packagePath = resolveRequiredPath(packageRoot, "packageRoot");
  const paths = clientHookRuntimePaths(resolveRequiredPath(memoraxCodeHome, "memoraxCodeHome"));
  return withJsonFileLock(paths.installLockPath, () => {
    const packageVersion = readPackageVersion(packagePath);
    const sourceTrees = resolveRuntimeSourceTrees(packagePath);
    const contentDigest = digestRuntimeTrees(sourceTrees);
    const versionDigest = createHash("sha256").update(packageVersion).digest("hex").slice(0, 8);
    const generationId = `${safeGenerationPrefix(packageVersion)}-${versionDigest}-${contentDigest.slice(0, 16)}`;
    const generationPath = join(paths.generationsRoot, generationId);
    const record = {
      version: GENERATION_RECORD_VERSION,
      runtimeAbi: CLIENT_HOOK_RUNTIME_ABI,
      generationId,
      packageVersion,
      contentDigest,
      createdAt: now().toISOString(),
    };

    ensurePrivateDirectory(paths.generationsRoot, { durableBoundary: paths.home });
    if (existsSync(generationPath)) {
      const existing = readGenerationRecord(generationPath);
      assertSameGeneration(existing, record);
      assertGenerationContent(generationPath, contentDigest);
      syncRegularTree(generationPath, { syncFile, syncDirectory: syncDir });
      syncDir(paths.generationsRoot);
      return { ...existing, generationPath, reused: true };
    }

    const temporaryPath = join(
      paths.generationsRoot,
      `.staging-${generationId}-${process.pid}-${randomUUID()}`,
    );
    try {
      mkdirSync(temporaryPath, { recursive: false, mode: 0o700 });
      if (process.platform !== "win32") chmodSync(temporaryPath, 0o700);
      for (const { boundary, relativePath, source } of sourceTrees) {
        assertRegularTree(source, boundary);
        const destination = join(temporaryPath, ...relativePath.split("/"));
        mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
        cpSync(source, destination, { recursive: true, force: false, errorOnExist: true });
      }
      assertGenerationContent(temporaryPath, contentDigest);
      writePrivateJsonRecord(join(temporaryPath, "generation.json"), record, {
        durableBoundary: paths.home,
      });
      syncRegularTree(temporaryPath, { syncFile, syncDirectory: syncDir });
      renameSync(temporaryPath, generationPath);
      syncDir(paths.generationsRoot);
      return { ...record, generationPath, reused: false };
    } catch (error) {
      rmSync(temporaryPath, { recursive: true, force: true });
      if (existsSync(generationPath)) {
        const existing = readGenerationRecord(generationPath);
        assertSameGeneration(existing, record);
        assertGenerationContent(generationPath, contentDigest);
        syncRegularTree(generationPath, { syncFile, syncDirectory: syncDir });
        syncDir(paths.generationsRoot);
        return { ...existing, generationPath, reused: true };
      }
      throw error;
    }
  });
}

export function activateClientHookRuntimeGeneration({
  memoraxCodeHome,
  generation,
  now = () => new Date(),
} = {}) {
  if (!generation || typeof generation !== "object") {
    throw new TypeError("generation is required");
  }
  const paths = clientHookRuntimePaths(resolveRequiredPath(memoraxCodeHome, "memoraxCodeHome"));
  return withJsonFileLock(paths.currentPath, () => {
    const generationPath = clientHookGenerationPath(
      paths.generationsRoot,
      generation.generationId,
    );
    const verified = readGenerationRecord(generationPath);
    assertSameGeneration(verified, generation);
    assertGenerationContent(generationPath, verified.contentDigest);
    const current = {
      version: CURRENT_RECORD_VERSION,
      runtimeAbi: verified.runtimeAbi,
      generationId: verified.generationId,
      packageVersion: verified.packageVersion,
      contentDigest: verified.contentDigest,
      activatedAt: now().toISOString(),
    };
    const write = writePrivateJsonRecord(paths.currentPath, current, {
      durableBoundary: paths.home,
    });
    return {
      ...current,
      generationPath,
      durability: write.durability,
      ...(write.durabilityErrorCode
        ? { durabilityErrorCode: write.durabilityErrorCode }
        : {}),
    };
  });
}

export function prepareClientHookRuntimeGeneration(options = {}) {
  const generation = stageClientHookRuntimeGeneration(options);
  const current = activateClientHookRuntimeGeneration({
    memoraxCodeHome: options.memoraxCodeHome,
    generation,
    now: options.now,
  });
  return { generation, current };
}

// Full-tree digests are checked at stage/activation, not on each Hook lookup.
// Reads validate metadata and rely on published generations staying unchanged.
export function readCurrentClientHookRuntime(memoraxCodeHome) {
  const paths = clientHookRuntimePaths(memoraxCodeHome);
  const state = readJsonRuntimeRecord(paths.currentPath);
  if (state.status !== "present") return state;
  const value = parseCurrentRecord(state.value);
  if (!value.ok) return { status: "invalid", reason: value.reason };
  try {
    const generationPath = clientHookGenerationPath(
      paths.generationsRoot,
      value.record.generationId,
    );
    const generation = readGenerationRecord(generationPath);
    assertSameGeneration(generation, value.record);
    return {
      status: "valid",
      record: value.record,
      generation,
      generationPath,
    };
  } catch {
    return { status: "invalid", reason: "generation_invalid" };
  }
}

export function resolveClientHookRuntimeModule({
  memoraxCodeHome,
  client,
  component,
  generationId,
} = {}) {
  if (!Object.prototype.hasOwnProperty.call(CLIENT_ADAPTER_DIRS, client)) return undefined;
  if (!CLIENT_COMPONENTS[client].has(component)) return undefined;
  if (!validGenerationId(generationId)) return undefined;
  const paths = clientHookRuntimePaths(memoraxCodeHome);
  const generationPath = clientHookGenerationPath(paths.generationsRoot, generationId);
  let generation;
  try {
    generation = readGenerationRecord(generationPath);
    if (generation.generationId !== generationId) return undefined;
  } catch {
    return undefined;
  }
  const modulePath = join(
    generationPath,
    "lib",
    CLIENT_ADAPTER_DIRS[client],
    "runtime-hooks",
    `${component}.mjs`,
  );
  return isContainedRegularPath(generationPath, modulePath)
    ? { generation, generationPath, modulePath }
    : undefined;
}

function readGenerationRecord(generationPath) {
  const state = readJsonRuntimeRecord(join(generationPath, "generation.json"));
  if (state.status !== "present") throw new Error("client Hook generation manifest is missing");
  const parsed = parseGenerationRecord(state.value);
  if (!parsed.ok) throw new Error(`client Hook generation manifest is invalid: ${parsed.reason}`);
  return parsed.record;
}

function parseGenerationRecord(value) {
  if (!isRecord(value)) return { ok: false, reason: "invalid_record" };
  if (value.version !== GENERATION_RECORD_VERSION) return { ok: false, reason: "unsupported_version" };
  if (value.runtimeAbi !== CLIENT_HOOK_RUNTIME_ABI) return { ok: false, reason: "unsupported_runtime_abi" };
  if (!validGenerationId(value.generationId)) return { ok: false, reason: "invalid_generation_id" };
  if (!nonEmpty(value.packageVersion)) return { ok: false, reason: "invalid_package_version" };
  if (!CONTENT_DIGEST_PATTERN.test(value.contentDigest)) return { ok: false, reason: "invalid_content_digest" };
  if (!validTimestamp(value.createdAt)) return { ok: false, reason: "invalid_created_at" };
  return {
    ok: true,
    record: {
      version: value.version,
      runtimeAbi: value.runtimeAbi,
      generationId: value.generationId,
      packageVersion: value.packageVersion,
      contentDigest: value.contentDigest,
      createdAt: value.createdAt,
    },
  };
}

function parseCurrentRecord(value) {
  if (!isRecord(value)) return { ok: false, reason: "invalid_record" };
  if (value.version !== CURRENT_RECORD_VERSION) return { ok: false, reason: "unsupported_version" };
  if (value.runtimeAbi !== CLIENT_HOOK_RUNTIME_ABI) return { ok: false, reason: "unsupported_runtime_abi" };
  if (!validGenerationId(value.generationId)) return { ok: false, reason: "invalid_generation_id" };
  if (!nonEmpty(value.packageVersion)) return { ok: false, reason: "invalid_package_version" };
  if (!CONTENT_DIGEST_PATTERN.test(value.contentDigest)) return { ok: false, reason: "invalid_content_digest" };
  if (!validTimestamp(value.activatedAt)) return { ok: false, reason: "invalid_activated_at" };
  return {
    ok: true,
    record: {
      version: value.version,
      runtimeAbi: value.runtimeAbi,
      generationId: value.generationId,
      packageVersion: value.packageVersion,
      contentDigest: value.contentDigest,
      activatedAt: value.activatedAt,
    },
  };
}

function assertSameGeneration(left, right) {
  for (const key of ["runtimeAbi", "generationId", "packageVersion", "contentDigest"]) {
    if (left?.[key] !== right?.[key]) {
      throw new Error(`client Hook generation ${key} mismatch`);
    }
  }
}

function assertGenerationContent(generationPath, expectedDigest) {
  const actual = digestRuntimeTrees(packagedRuntimeSourceTrees(generationPath));
  if (actual !== expectedDigest) throw new Error("client Hook generation content digest mismatch");
  for (const [client, components] of Object.entries(CLIENT_COMPONENTS)) {
    const adapter = CLIENT_ADAPTER_DIRS[client];
    for (const component of components) {
      const modulePath = join(
        generationPath,
        "lib",
        adapter,
        "runtime-hooks",
        `${component}.mjs`,
      );
      if (!isContainedRegularPath(generationPath, modulePath)) {
        throw new Error(`client Hook generation is missing runtime component: ${client}/${component}`);
      }
    }
  }
}

function digestRuntimeTrees(sourceTrees) {
  const hash = createHash("sha256");
  for (const { boundary, relativePath: relativeRoot, source } of sourceTrees) {
    assertRegularTree(source, boundary);
    for (const file of regularFiles(source)) {
      const relativePath = normalize(join(
        relativeRoot,
        relative(source, file),
      ));
      hash.update(relativePath);
      hash.update("\0");
      hash.update(readFileSync(file));
      hash.update("\0");
    }
  }
  return hash.digest("hex");
}

function resolveRuntimeSourceTrees(packageRoot) {
  const packaged = packagedRuntimeSourceTrees(packageRoot);
  if (packaged.every(({ source }) => existsSync(source))) return packaged;
  throw new Error("MemoraX Code package is missing the complete client Hook runtime source trees");
}

function packagedRuntimeSourceTrees(root) {
  return RUNTIME_SOURCE_TREES.map((relativePath) => ({
    boundary: root,
    relativePath,
    source: join(root, ...relativePath.split("/")),
  }));
}

function regularFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink()) throw new Error(`client Hook runtime contains a symbolic link: ${path}`);
    if (metadata.isDirectory()) files.push(...regularFiles(path));
    else if (metadata.isFile()) files.push(path);
    else throw new Error(`client Hook runtime contains a non-regular entry: ${path}`);
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function assertRegularTree(path, boundary) {
  if (!isContainedPath(boundary, path)) throw new Error("client Hook runtime path escapes its boundary");
  const root = resolve(boundary);
  const target = resolve(path);
  const parts = relative(root, target).split(sep).filter(Boolean);
  let current = root;
  for (const part of ["", ...parts]) {
    if (part) current = join(current, part);
    const metadata = lstatSync(current);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error(`client Hook runtime source is not a regular directory: ${current}`);
    }
  }
}

function isContainedRegularPath(boundary, path) {
  if (!isContainedPath(boundary, path)) return false;
  const root = resolve(boundary);
  const target = resolve(path);
  const parts = relative(root, target).split(sep).filter(Boolean);
  let current = root;
  try {
    const rootMetadata = lstatSync(current);
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) return false;
    for (let index = 0; index < parts.length; index += 1) {
      current = join(current, parts[index]);
      const metadata = lstatSync(current);
      if (metadata.isSymbolicLink()) return false;
      if (index === parts.length - 1) return metadata.isFile();
      if (!metadata.isDirectory()) return false;
    }
  } catch {
    return false;
  }
  return false;
}

function isContainedPath(boundary, path) {
  const root = resolve(boundary);
  const target = resolve(path);
  const child = relative(root, target);
  return child === ""
    || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function clientHookGenerationPath(generationsRoot, generationId) {
  if (!validGenerationId(generationId)) {
    throw new Error("client Hook generation ID is invalid");
  }
  const path = join(generationsRoot, generationId);
  if (!isContainedPath(generationsRoot, path) || resolve(path) === resolve(generationsRoot)) {
    throw new Error("client Hook generation path escapes its boundary");
  }
  return path;
}

function validGenerationId(value) {
  return typeof value === "string"
    && value !== "."
    && value !== ".."
    && GENERATION_ID_PATTERN.test(value);
}

function readPackageVersion(packageRoot) {
  const parsed = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  if (!nonEmpty(parsed?.version)) throw new Error("MemoraX Code package version is missing");
  return parsed.version;
}

function safeGenerationPrefix(version) {
  const normalized = String(version).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return (normalized || "runtime").slice(0, 120);
}

function syncDirectory(path) {
  if (process.platform === "win32") return;
  let descriptor;
  try {
    descriptor = openSync(path, "r");
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function syncRegularFile(path) {
  let descriptor;
  try {
    descriptor = openSync(path, "r+");
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function syncRegularTree(root, { syncFile, syncDirectory: syncDir }) {
  const directories = [];
  const files = [];
  const visit = (directory) => {
    directories.push(directory);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink()) {
        throw new Error(`client Hook runtime contains a symbolic link: ${path}`);
      }
      if (metadata.isDirectory()) visit(path);
      else if (metadata.isFile()) files.push(path);
      else throw new Error(`client Hook runtime contains a non-regular entry: ${path}`);
    }
  };
  visit(root);
  for (const file of files) syncFile(file);
  for (const directory of directories.reverse()) syncDir(directory);
}

function resolveRequiredPath(value, name) {
  if (!nonEmpty(value)) throw new TypeError(`${name} is required`);
  return resolve(value);
}

function validTimestamp(value) {
  return nonEmpty(value) && Number.isFinite(Date.parse(value));
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalize(path) {
  return sep === "/" ? path : path.replaceAll(sep, "/");
}
