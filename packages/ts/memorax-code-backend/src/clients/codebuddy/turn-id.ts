import { createHash } from "node:crypto";

export type CodeBuddyTurnIdentity = Readonly<{
  boundary: number;
  promptDigest: string;
}>;

export function parseCodeBuddyTurnId(input: {
  sessionId: string;
  turnId: string;
}): CodeBuddyTurnIdentity | undefined {
  const prefix = `${input.sessionId}:`;
  if (!input.turnId.startsWith(prefix)) return undefined;
  const match = /^(0|[1-9]\d*):([0-9a-f]{64})$/.exec(input.turnId.slice(prefix.length));
  if (!match) return undefined;
  const boundary = Number(match[1]);
  if (!Number.isSafeInteger(boundary)) return undefined;
  return { boundary, promptDigest: match[2] };
}

export function codeBuddyPromptDigest(prompt: string): string {
  return createHash("sha256").update(prompt.trim()).digest("hex");
}
