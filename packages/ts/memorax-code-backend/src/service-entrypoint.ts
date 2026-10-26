import { reportBackendStartupPhase } from "./lifecycle/backend/startup-diagnostics.js";

const markerIndex = process.argv.indexOf("--memorax-code-backend-instance");
const instanceId = markerIndex >= 0 ? process.argv[markerIndex + 1] : undefined;
if (!instanceId
  || instanceId !== process.env.MEMORAX_CODE_BACKEND_INSTANCE_ID
  || !/^[A-Za-z0-9_-]+$/.test(instanceId)) {
  console.error("invalid MemoraX Code Backend service instance marker");
  process.exit(1);
}

reportBackendStartupPhase("runtime_import", "start");
const { runBackendCli } = await import("./entrypoints/backend-cli.js");
reportBackendStartupPhase("runtime_import", "complete");
runBackendCli([process.execPath, "memorax-code-backend"]);
