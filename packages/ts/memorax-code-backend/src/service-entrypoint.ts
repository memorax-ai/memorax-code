import { runBackendCli } from "./entrypoints/backend-cli.js";

const markerIndex = process.argv.indexOf("--memorax-code-backend-instance");
const instanceId = markerIndex >= 0 ? process.argv[markerIndex + 1] : undefined;
if (!instanceId
  || instanceId !== process.env.MEMORAX_CODE_BACKEND_INSTANCE_ID
  || !/^[A-Za-z0-9_-]+$/.test(instanceId)) {
  console.error("invalid MemoraX Code Backend service instance marker");
  process.exit(1);
}

runBackendCli([process.execPath, "memorax-code-backend"]);
