import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function isMainEntrypoint(importMetaUrl: string, argv = process.argv): boolean {
  const script = argv[1];
  if (!script) return false;
  const modulePath = fileURLToPath(importMetaUrl);
  try {
    return realpathSync(modulePath) === realpathSync(script);
  } catch {
    return modulePath === script;
  }
}
