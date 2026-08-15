import type { IncomingMessage, ServerResponse } from "node:http";
import type { BackendState } from "../../app/state.js";
import { json } from "./json.js";
import { authorized } from "./request.js";

export function handleHealthRequest(
  state: BackendState,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): void {
  const response = {
    ok: true,
    service: "memorax-code-backend",
    instanceId: process.env.MEMORAX_CODE_BACKEND_INSTANCE_ID,
    authRequired: Boolean(state.authToken),
    security: {
      mode: state.security.mode,
      allowExternalAccess: state.security.allowExternalAccess,
    },
  };
  return json(res, 200, authorized(state, req, url)
    ? { ...response, state: { sessionHome: state.sessionHome } }
    : response);
}
