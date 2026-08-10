import type { ServerResponse } from "node:http";
import type { BackendState } from "../../app/state.js";
import { json } from "./json.js";

export function handleHealthRequest(state: BackendState, res: ServerResponse): void {
  return json(res, 200, {
    ok: true,
    service: "memorax-code-backend",
    instanceId: process.env.MEMORAX_CODE_BACKEND_INSTANCE_ID,
    authRequired: Boolean(state.authToken),
    security: {
      mode: state.security.mode,
      allowExternalAccess: state.security.allowExternalAccess,
    },
    state: {
      sessionHome: state.sessionHome,
    },
  });
}
