export type BackendCommandRequest = {
  connection: { url: string; token?: string };
  path: string;
  body: unknown;
  timeoutMs: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
};

export function postBackendCommand(request: BackendCommandRequest): Promise<Response>;
