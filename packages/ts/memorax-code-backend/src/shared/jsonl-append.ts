import { open, type FileHandle } from "node:fs/promises";

const JSONL_TAIL_SCAN_CHUNK_BYTES = 8 * 1024;
const pathOperations = new Map<string, Promise<unknown>>();

export async function appendRepairingJsonl(path: string, text: string): Promise<void> {
  await serializePath(path, async () => {
    const handle = await open(path, "a+", 0o600);
    try {
      const { rollbackSize, separator } = await prepareTailForAppend(handle);
      try {
        await handle.writeFile(`${separator}${text}`, "utf8");
      } catch (error) {
        await handle.truncate(rollbackSize).catch(() => undefined);
        throw error;
      }
    } finally {
      await handle.close();
    }
  });
}

async function serializePath<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = pathOperations.get(path) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  pathOperations.set(path, current);
  try {
    return await current;
  } finally {
    if (pathOperations.get(path) === current) pathOperations.delete(path);
  }
}

async function prepareTailForAppend(
  handle: FileHandle,
): Promise<{ rollbackSize: number; separator: "" | "\n" }> {
  const size = (await handle.stat()).size;
  if (size === 0) return { rollbackSize: 0, separator: "" };

  const lastByte = Buffer.allocUnsafe(1);
  await readExactAt(handle, lastByte, size - 1);
  if (lastByte[0] === 0x0a) return { rollbackSize: size, separator: "" };

  const tailStart = await jsonlTailStart(handle, size);
  const tail = Buffer.allocUnsafe(size - tailStart);
  await readExactAt(handle, tail, tailStart);
  try {
    JSON.parse(tail.toString("utf8"));
    return { rollbackSize: size, separator: "\n" };
  } catch {
    await handle.truncate(tailStart);
    return { rollbackSize: tailStart, separator: "" };
  }
}

async function jsonlTailStart(handle: FileHandle, size: number): Promise<number> {
  let end = size;
  while (end > 0) {
    const start = Math.max(0, end - JSONL_TAIL_SCAN_CHUNK_BYTES);
    const buffer = Buffer.allocUnsafe(end - start);
    await readExactAt(handle, buffer, start);
    const newline = buffer.lastIndexOf(0x0a);
    if (newline >= 0) return start + newline + 1;
    end = start;
  }
  return 0;
}

async function readExactAt(handle: FileHandle, buffer: Buffer, position: number): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, position + offset);
    if (bytesRead === 0) throw new Error("failed to read JSONL tail");
    offset += bytesRead;
  }
}
