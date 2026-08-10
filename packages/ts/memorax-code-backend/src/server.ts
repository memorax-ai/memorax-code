#!/usr/bin/env node
import { isMainEntrypoint } from "./entrypoints/main.js";

export { createBackendServer } from "./app/backend-server.js";
export type { BackendServer, BackendServerOptions } from "./app/backend-server.js";

if (isMainEntrypoint(import.meta.url)) {
  import("./entrypoints/backend-cli.js")
    .then(({ runBackendCli }) => runBackendCli(process.argv))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
