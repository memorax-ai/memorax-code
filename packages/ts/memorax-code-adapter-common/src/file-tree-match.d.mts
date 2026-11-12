import type { Buffer } from "node:buffer";

export function fileTreeMatches(source: string, target: string, options?: {
  ignore?: (relativePath: string) => boolean;
  transform?: (relativePath: string, content: Buffer) => Buffer;
}): Promise<boolean>;
