import { createHash } from "node:crypto";

export type TraeTurnIdentity = Readonly<{
  createdAt: number;
  promptDigest: string;
}>;

export function traePromptDigest(prompt: string): string {
  return createHash("sha256").update(prompt.trim()).digest("hex");
}

export function parseTraeTurnId(input: {
  sessionId: string;
  turnId: string;
}): TraeTurnIdentity | undefined {
  const prefix = `${input.sessionId}:`;
  if (!input.turnId.startsWith(prefix)) return undefined;
  const match = /^([1-9]\d*):([a-f0-9]{64})$/.exec(input.turnId.slice(prefix.length));
  if (!match) return undefined;
  const createdAt = Number(match[1]);
  if (!Number.isSafeInteger(createdAt)) return undefined;
  return { createdAt, promptDigest: match[2] };
}
