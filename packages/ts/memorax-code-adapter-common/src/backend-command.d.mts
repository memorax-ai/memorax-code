export type BackendCommandRequest = {
  connection: { url: string; token?: string; memoraxCodeHome?: string };
  memoraxCodeHome?: string;
  path: string;
  body: unknown;
  timeoutMs: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
};

export function postBackendCommand(request: BackendCommandRequest): Promise<Response>;
