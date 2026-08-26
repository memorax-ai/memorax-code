import type { IncomingMessage } from "node:http";
import type { BackendState } from "../../app/state.js";
import { backendEnv } from "../../config/backend-env.js";

const DEFAULT_MAX_JSON_BODY_BYTES = 16 * 1024 * 1024;

export class HttpRequestError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
    this.name = "HttpRequestError";
  }
}

function maxJsonBodyBytes(): number {
  const configured = Number(backendEnv("MAX_JSON_BODY_BYTES"));
  if (Number.isFinite(configured) && configured > 0) return Math.floor(configured);
  return DEFAULT_MAX_JSON_BODY_BYTES;
}

export async function readJson(req: IncomingMessage, maxBytes = maxJsonBodyBytes()): Promise<unknown> {
  const rawContentEncoding = Array.isArray(req.headers["content-encoding"])
    ? req.headers["content-encoding"].join(",")
    : req.headers["content-encoding"];
  const unsupportedEncoding = (rawContentEncoding ?? "identity")
    .split(",")
    .map((encoding) => encoding.trim().toLowerCase())
    .find((encoding) => encoding && encoding !== "identity");
  if (unsupportedEncoding) {
    throw new HttpRequestError(415, `unsupported content-encoding: ${unsupportedEncoding}`);
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > maxBytes) {
      throw new HttpRequestError(413, `request body exceeds ${maxBytes} bytes`);
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return text ? JSON.parse(text) : {};
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new HttpRequestError(400, "request body must be valid JSON");
    }
    throw error;
  }
}

export function authorized(state: BackendState, req: IncomingMessage, url: URL): boolean {
  if (!state.authToken) return true;
  const authorization = req.headers.authorization;
  const bearer = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined;
  const headerToken = req.headers["x-memorax-code-backend-token"];
  const token = bearer
    ?? (typeof headerToken === "string" ? headerToken : undefined)
    ?? url.searchParams.get("token")
    ?? undefined;
  return token === state.authToken;
}

export function statusCodeFromError(error: unknown): number {
  if (error instanceof HttpRequestError) return error.statusCode;
  return error instanceof Error && "statusCode" in error && typeof error.statusCode === "number"
    ? error.statusCode
    : 500;
}

export function publicErrorMessage(error: unknown): string {
  return error instanceof HttpRequestError
    ? error.message
    : "internal server error";
}
