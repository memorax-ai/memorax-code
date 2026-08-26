export const MINIMUM_NODE_MAJOR = 20;

export function unsupportedNodeVersionMessage(version = process.versions.node) {
  const value = String(version ?? "").trim();
  const match = /^v?(\d+)(?:\.|$)/.exec(value);
  const major = match ? Number.parseInt(match[1], 10) : undefined;
  if (major !== undefined && major >= MINIMUM_NODE_MAJOR) return undefined;
  const current = value || "unknown";
  return `MemoraX Code requires Node.js ${MINIMUM_NODE_MAJOR} or newer; `
    + `the current runtime is Node.js ${current}. Upgrade Node.js and try again.`;
}
