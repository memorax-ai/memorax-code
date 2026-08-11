import { delimiter } from "node:path";
import { readAdapterState } from "../../memorax-code-adapter-common/src/config-utils.mjs";

export function createMemoraxOpenCodePlugin(options = {}) {
  return async () => ({
    "shell.env": async (input, output) => {
      if (!pluginEnabled(options)) return;
      output.env.MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT = "opencode";
      const sessionId = stringValue(input?.sessionID);
      if (sessionId) {
        output.env.MEMORAX_CODE_MEMORY_CLI_TRACE_SESSION_ID = sessionId;
        output.env.MEMORAX_CODE_MEMORY_CLI_SESSION_ID = sessionId;
      }
      const cliBinDir = stringValue(options.cliBinDir);
      if (cliBinDir) {
        const currentPath = output.env.PATH ?? process.env.PATH ?? "";
        const pathEntries = currentPath.split(delimiter).filter(Boolean);
        output.env.PATH = pathEntries.includes(cliBinDir)
          ? currentPath
          : [cliBinDir, ...pathEntries].join(delimiter);
      }
    },
  });
}

export const MemoraxOpenCodePlugin = createMemoraxOpenCodePlugin();
export default MemoraxOpenCodePlugin;

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function pluginEnabled(options) {
  const statePath = stringValue(options.statePath);
  if (!statePath) return true;
  const state = readAdapterState(statePath);
  return state?.unreadable !== true
    && state?.version === 1
    && state?.runtime === "opencode"
    && state?.integration === "plugin"
    && state?.enabled === true;
}
