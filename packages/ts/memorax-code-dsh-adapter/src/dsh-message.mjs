import { randomUUID } from "node:crypto";

/** Create the same detached, identified, deeply frozen UserMessage as DSH. */
export function createDshUserMessage(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("DSH UserMessage input must be an object");
  }
  if (Object.hasOwn(input, "id") || Object.hasOwn(input, "role")) {
    throw new TypeError("DSH UserMessage input must not supply id or role");
  }
  return deepFreeze(structuredClone({
    ...input,
    role: "user",
    id: randomUUID(),
  }));
}

// Kept package-local because an out-of-tree DSH bundle cannot resolve in-box
// package imports from its profile dependency tree. This mirrors DSH's public
// createUserMessage -> freezeMessage -> deepFreeze construction contract.
function deepFreeze(value) {
  const seen = new WeakSet();
  const pending = [value];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === null || typeof node !== "object" || node instanceof AbortSignal) continue;
    if (seen.has(node)) continue;
    seen.add(node);
    Object.freeze(node);
    for (const key of Object.keys(node)) pending.push(node[key]);
  }
  return value;
}
