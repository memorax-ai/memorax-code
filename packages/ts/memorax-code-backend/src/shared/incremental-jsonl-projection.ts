import { createHash, type Hash } from "node:crypto";
import { open, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export type IncrementalJsonlEntry<T> = {
  value: T;
  retryKey?: string;
};

type FileProjection<T> = {
  byteLength: number;
  modifiedAtMs: number;
  changedAtMs: number;
  inode: number;
  contentHash: string;
  complete: boolean;
  consumedComplete: boolean;
  entries: IncrementalJsonlEntry<T>[];
  retryEntries: IncrementalJsonlEntry<T>[];
};

type JsonlProjection<T> = {
  identity?: unknown;
  files: Map<string, FileProjection<T>>;
  values: T[];
  refresh?: Promise<IncrementalJsonlProjectionSnapshot<T>>;
};

export type IncrementalJsonlProjectionSnapshot<T> = Readonly<{
  values: T[];
  complete: boolean;
}>;

export type IncrementalJsonlProjectionOptions<T> = Readonly<{
  namespace?: string;
  root: string;
  filename: string;
  identity?: unknown;
  project: (value: unknown, directory: string) => IncrementalJsonlEntry<T> | undefined;
  // Called only while an entry retains a non-empty retryKey.
  refreshEntry?: (entry: IncrementalJsonlEntry<T>) => boolean;
  compare: (left: T, right: T) => number;
}>;

const projections = new Map<string, JsonlProjection<unknown>>();
const HASH_CHUNK_BYTES = 64 * 1024;

export async function readIncrementalJsonlProjection<T>(
  options: IncrementalJsonlProjectionOptions<T>,
): Promise<T[]> {
  return (await readIncrementalJsonlProjectionSnapshot(options)).values;
}

export async function readIncrementalJsonlProjectionSnapshot<T>(
  options: IncrementalJsonlProjectionOptions<T>,
): Promise<IncrementalJsonlProjectionSnapshot<T>> {
  const projectionKey = options.namespace
    ? `${options.namespace}\u0000${options.root}\u0000${options.filename}`
    : `${options.root}\u0000${options.filename}`;
  let projection = projections.get(projectionKey) as JsonlProjection<T> | undefined;
  if (projection && projection.identity !== options.identity) projection = undefined;
  if (!projection) {
    projection = { identity: options.identity, files: new Map(), values: [] };
    projections.set(projectionKey, projection as JsonlProjection<unknown>);
  }
  if (projection.refresh) return projection.refresh;
  const refresh = refreshProjection(projection, options);
  projection.refresh = refresh;
  try {
    return await refresh;
  } finally {
    if (projection.refresh === refresh) projection.refresh = undefined;
  }
}

export function clearIncrementalJsonlProjections(): void {
  projections.clear();
}

async function refreshProjection<T>(
  projection: JsonlProjection<T>,
  options: IncrementalJsonlProjectionOptions<T>,
): Promise<IncrementalJsonlProjectionSnapshot<T>> {
  let directories: string[];
  try {
    directories = (await readdir(options.root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if (projection.files.size > 0 || projection.values.length > 0) {
      projection.files.clear();
      projection.values = [];
    }
    return {
      values: projection.values,
      complete: (error as NodeJS.ErrnoException).code === "ENOENT",
    };
  }

  const activeDirectories = new Set(directories);
  let rebuild = false;
  let complete = true;
  for (const cachedDirectory of projection.files.keys()) {
    if (activeDirectories.has(cachedDirectory)) continue;
    projection.files.delete(cachedDirectory);
    rebuild = true;
  }
  if (options.refreshEntry) {
    for (const file of projection.files.values()) {
      const retryEntries: IncrementalJsonlEntry<T>[] = [];
      for (const entry of file.retryEntries) {
        if (options.refreshEntry(entry)) rebuild = true;
        if (entry.retryKey) retryEntries.push(entry);
      }
      file.retryEntries = retryEntries;
    }
  }

  const appended: T[] = [];
  for (const directory of directories) {
    const path = join(options.root, directory, options.filename);
    const cached = projection.files.get(directory);
    let metadata: Awaited<ReturnType<typeof stat>>;
    try {
      metadata = await stat(path);
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      if (cached && missing) {
        projection.files.delete(directory);
        rebuild = true;
      }
      if (!missing) complete = false;
      continue;
    }
    if (!metadata.isFile()) {
      complete = false;
      continue;
    }
    if (cached
      && metadata.size === cached.byteLength
      && metadata.mtimeMs === cached.modifiedAtMs
      && metadata.ctimeMs === cached.changedAtMs
      && metadata.ino === cached.inode) {
      if (!cached.complete) complete = false;
      continue;
    }

    let buffer: Buffer;
    let verifiedPrefixHash: Hash | undefined;
    let rangeStart: number;
    let appendOnly = false;
    try {
      if (cached && metadata.ino === cached.inode && metadata.size > cached.byteLength) {
        verifiedPrefixHash = await hashFilePrefix(path, cached.byteLength);
        appendOnly = verifiedPrefixHash.copy().digest("hex") === cached.contentHash;
        if (appendOnly) {
          buffer = await readFileRange(path, cached.byteLength, metadata.size);
          rangeStart = cached.byteLength;
        } else {
          buffer = await readFile(path);
          rangeStart = 0;
        }
      } else {
        buffer = await readFile(path);
        rangeStart = 0;
      }
    } catch {
      complete = false;
      continue;
    }

    const parsed = parseJsonlChunk(buffer, directory, options.project);
    const readComplete = buffer.length === metadata.size - rangeStart;
    const consumedComplete = (appendOnly ? cached!.consumedComplete : true)
      && parsed.consumedComplete
      && readComplete;
    const fileComplete = (appendOnly ? cached!.consumedComplete : true)
      && parsed.complete
      && readComplete;
    if (!fileComplete) complete = false;
    const entries = appendOnly ? [...cached!.entries, ...parsed.entries] : parsed.entries;
    const parsedRetryEntries = parsed.entries.filter((entry) => entry.retryKey);
    const retryEntries = appendOnly
      ? [...cached!.retryEntries, ...parsedRetryEntries]
      : parsedRetryEntries;
    const byteLength = rangeStart + parsed.consumedByteLength;
    projection.files.set(directory, {
      byteLength,
      modifiedAtMs: metadata.mtimeMs,
      changedAtMs: metadata.ctimeMs,
      inode: metadata.ino,
      contentHash: appendOnly
        ? verifiedPrefixHash!.update(buffer.subarray(0, parsed.consumedByteLength)).digest("hex")
        : hashBuffer(buffer.subarray(0, parsed.consumedByteLength)),
      complete: fileComplete,
      consumedComplete,
      entries,
      retryEntries,
    });
    if (appendOnly || !cached) appended.push(...parsed.entries.map(({ value }) => value));
    else rebuild = true;
  }

  if (rebuild) {
    projection.values = [...projection.files.values()]
      .flatMap((file) => file.entries.map(({ value }) => value))
      .sort(options.compare);
  } else if (appended.length > 0) {
    const chronological = appended.sort(options.compare);
    const last = projection.values.at(-1);
    projection.values = !last || options.compare(last, chronological[0]) <= 0
      ? [...projection.values, ...chronological]
      : [...projection.values, ...chronological].sort(options.compare);
  }
  return { values: projection.values, complete };
}

async function readFileRange(path: string, start: number, end: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(end - start);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, start + offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

function parseJsonlChunk<T>(
  buffer: Buffer,
  directory: string,
  project: IncrementalJsonlProjectionOptions<T>["project"],
): {
  entries: IncrementalJsonlEntry<T>[];
  consumedByteLength: number;
  complete: boolean;
  consumedComplete: boolean;
} {
  const entries: IncrementalJsonlEntry<T>[] = [];
  let consumedByteLength = 0;
  let complete = true;
  let consumedComplete = true;
  let lineStart = 0;
  while (lineStart < buffer.length) {
    const newline = buffer.indexOf(0x0a, lineStart);
    const lineComplete = newline !== -1;
    const lineEnd = lineComplete ? newline : buffer.length;
    const line = buffer.subarray(lineStart, lineEnd).toString("utf8");
    if (lineComplete) consumedByteLength = lineEnd + 1;
    if (!line.trim()) {
      if (!lineComplete) consumedByteLength = buffer.length;
      lineStart = lineEnd + 1;
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      complete = false;
      if (lineComplete) consumedComplete = false;
      if (!lineComplete) break;
      lineStart = lineEnd + 1;
      continue;
    }
    if (!lineComplete) consumedByteLength = buffer.length;
    try {
      const entry = project(value, directory);
      if (entry) entries.push(entry);
    } catch {
      complete = false;
      consumedComplete = false;
    }
    if (!lineComplete) break;
    lineStart = lineEnd + 1;
  }
  return {
    entries,
    consumedByteLength,
    complete,
    consumedComplete,
  };
}

async function hashFilePrefix(path: string, end: number): Promise<Hash> {
  const handle = await open(path, "r");
  const hash = createHash("sha256");
  try {
    const buffer = Buffer.allocUnsafe(Math.min(HASH_CHUNK_BYTES, end));
    let position = 0;
    while (position < end) {
      const length = Math.min(buffer.length, end - position);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return hash;
  } finally {
    await handle.close();
  }
}

function hashBuffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}
