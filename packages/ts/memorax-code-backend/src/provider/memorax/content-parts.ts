import { isRecord } from "../../shared/record.js";

export type MemoraxContentPart =
  | { type: "text"; text: string }
  | { type: "input_image"; image_url: string; detail?: "auto" | "low" | "high" | "original"; caption?: string }
  | { type: "input_file"; file_id: string }
  | { type: "input_file"; filename: string; file_data: string };

export type MemoraxMessageContent = string | MemoraxContentPart[];

function reject(): never {
  // Never include user data, filenames or URLs in validation diagnostics.
  throw new Error("Invalid message content part; supported types are text, input_text, input_image, input_file, and file");
}

function onlyKeys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) reject();
}

function nonblank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

// A file source is exactly one scoped stored file ID or one inline file.
// `frameKeys` are the enclosing part's own keys, empty for a nested `file` object.
function normalizeFileSource(source: Record<string, unknown>, frameKeys: string[]): MemoraxContentPart {
  if (source.file_id !== undefined) {
    onlyKeys(source, [...frameKeys, "file_id"]);
    if (typeof source.file_id !== "string" || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(source.file_id)) reject();
    return { type: "input_file", file_id: source.file_id };
  }
  onlyKeys(source, [...frameKeys, "filename", "file_data"]);
  if (!nonblank(source.filename) || !nonblank(source.file_data)) reject();
  return { type: "input_file", filename: source.filename, file_data: source.file_data };
}

export function normalizeContentParts(value: unknown[]): MemoraxContentPart[] {
  if (!value.length || value.length > 100) reject();
  return value.map((part): MemoraxContentPart => {
    if (!isRecord(part)) reject();
    if (part.type === "text" || part.type === "input_text") {
      onlyKeys(part, ["type", "text"]);
      if (!nonblank(part.text)) reject();
      return { type: "text", text: part.text };
    }
    if (part.type === "input_image") {
      onlyKeys(part, ["type", "image_url", "detail", "caption"]);
      if (!nonblank(part.image_url)) reject();
      const imageUrl = part.image_url;
      if (imageUrl.startsWith("data:")) {
        if (!/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(imageUrl)) reject();
      } else {
        try {
          const url = new URL(imageUrl);
          if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || imageUrl.length > 4096) reject();
        } catch { reject(); }
      }
      if (part.detail !== undefined && (typeof part.detail !== "string"
        || !["auto", "low", "high", "original"].includes(part.detail))) reject();
      if (part.caption !== undefined && (!nonblank(part.caption) || part.caption.length > 4000)) reject();
      return {
        type: "input_image", image_url: imageUrl,
        ...(part.detail === undefined ? {} : { detail: part.detail as "auto" | "low" | "high" | "original" }),
        ...(part.caption === undefined ? {} : { caption: part.caption as string }),
      };
    }
    if (part.type === "input_file") return normalizeFileSource(part, ["type"]);
    if (part.type === "file") {
      // Nested input from earlier releases is still accepted but sent as flat input_file.
      onlyKeys(part, ["type", "file"]);
      if (!isRecord(part.file)) reject();
      return normalizeFileSource(part.file, []);
    }
    return reject();
  });
}

/** Local observability keeps text but never inline media or attachment URLs. */
export function observedMessageContent(content: MemoraxMessageContent): unknown {
  if (typeof content === "string") return content;
  return content.map((part) => part.type === "text" ? part : { type: part.type, redacted: true });
}
