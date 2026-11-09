import { isRecord } from "../../shared/record.js";

export type MemoraxContentPart =
  | { type: "text"; text: string }
  | { type: "input_image"; image_url: string; detail?: "auto" | "low" | "high" | "original"; caption?: string }
  | { type: "file"; file: { file_id: string } | { filename: string; file_data: string } };

export type MemoraxMessageContent = string | MemoraxContentPart[];

function reject(): never {
  // Never include user data, filenames or URLs in validation diagnostics.
  throw new Error("Invalid message content part; supported types are text, input_text, input_image, and file");
}

function onlyKeys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) reject();
}

function nonblank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
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
    if (part.type === "file") {
      onlyKeys(part, ["type", "file"]);
      if (!isRecord(part.file)) reject();
      const file = part.file;
      if (file.file_id !== undefined) {
        onlyKeys(file, ["file_id"]);
        if (typeof file.file_id !== "string" || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(file.file_id)) reject();
        return { type: "file", file: { file_id: file.file_id } };
      }
      onlyKeys(file, ["filename", "file_data"]);
      if (!nonblank(file.filename) || !nonblank(file.file_data)) reject();
      return { type: "file", file: { filename: file.filename, file_data: file.file_data } };
    }
    return reject();
  });
}

/** Local observability keeps text but never inline media or attachment URLs. */
export function observedMessageContent(content: MemoraxMessageContent): unknown {
  if (typeof content === "string") return content;
  return content.map((part) => part.type === "text" ? part : { type: part.type, redacted: true });
}
