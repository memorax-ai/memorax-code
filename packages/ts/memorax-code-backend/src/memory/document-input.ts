import { openAsBlob } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";

export type DocumentUploadInput = {
  path: string;
  document_id: string;
  input_id: string;
  expected_revision: number;
  sha256?: string;
};
export type PreparedDocumentUpload = Omit<DocumentUploadInput, "path"> & { file: Blob; filename: string };
const MAX_UPLOAD_BYTES = 150 * 1024 * 1024;
const MIME_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export function validateDocumentUploadInput(value: unknown): value is DocumentUploadInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return Object.keys(input).every(key => ["path", "document_id", "input_id", "expected_revision", "sha256"].includes(key))
    && typeof input.path === "string" && Boolean(input.path.trim())
    && typeof input.document_id === "string" && Boolean(input.document_id.trim())
    && input.document_id === input.document_id.trim() && [...input.document_id].length <= 200
    && typeof input.input_id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.input_id)
    && Number.isSafeInteger(input.expected_revision) && Number(input.expected_revision) >= 0
    && (input.sha256 === undefined || (typeof input.sha256 === "string" && /^[0-9a-f]{64}$/.test(input.sha256)));
}

export async function prepareDocumentUpload(input: DocumentUploadInput): Promise<PreparedDocumentUpload> {
  if (!validateDocumentUploadInput(input)) throw new Error("Document upload requires a file, document ID, input UUID and nonnegative revision");
  const extension = extname(input.path).toLowerCase();
  // The service owns format and text validation; MIME is only a transport hint.
  const type = MIME_TYPES[extension] ?? "application/octet-stream";
  try {
    const info = await stat(input.path);
    if (!info.isFile()) throw new Error("not_regular");
    if (info.size === 0 || info.size > MAX_UPLOAD_BYTES) throw new Error("invalid_size");
    // File-backed Blob streams bytes and rejects mutation after this snapshot.
    const file = await openAsBlob(input.path, { type });
    if (file.size === 0 || file.size > MAX_UPLOAD_BYTES) throw new Error("invalid_size");
    const { path: _path, ...identity } = input;
    return { ...identity, file, filename: basename(input.path).replace(/[\r\n]/g, "_") };
  } catch {
    throw new Error("Document file must be a readable, nonempty regular file of at most 150 MiB");
  }
}

export async function readDocumentManifest(path: string): Promise<unknown[]> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > 1_000_000) throw new Error("invalid_manifest");
    const values: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!Array.isArray(values) || values.length === 0 || values.length > 100) throw new Error("invalid_manifest");
    return values.map(value => validateDocumentUploadInput(value)
      ? { ...value, input_id: value.input_id.toLowerCase(), path: resolve(dirname(path), value.path) }
      : value);
  } catch {
    throw new Error("Document manifest must be a readable JSON array of 1 to 100 explicit file identities");
  }
}
