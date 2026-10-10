import { open } from "node:fs/promises";

export async function readNativeTranscriptSnapshot(input: {
  transcriptPath: string;
  endBytes?: number;
}): Promise<{ text: string; endBytes: number }> {
  if (input.endBytes !== undefined && (!Number.isSafeInteger(input.endBytes) || input.endBytes < 1)) {
    throw new Error("Invalid native transcript boundary");
  }
  const file = await open(input.transcriptPath, "r");
  try {
    let bytes: Buffer;
    if (input.endBytes === undefined) {
      bytes = await file.readFile();
    } else {
      if ((await file.stat()).size < input.endBytes) throw new Error("Native transcript was truncated");
      bytes = Buffer.alloc(input.endBytes);
      let offset = 0;
      while (offset < bytes.length) {
        const result = await file.read(bytes, offset, bytes.length - offset, offset);
        if (result.bytesRead === 0) throw new Error("Native transcript was truncated");
        offset += result.bytesRead;
      }
    }
    // The boundary belongs to these exact bytes, not a later file-size observation.
    return { text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes), endBytes: bytes.length };
  } finally {
    await file.close();
  }
}
