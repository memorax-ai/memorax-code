export type JsonFileLockOptions = Readonly<{
  timeoutMs?: number;
  staleMs?: number;
  retryMs?: number;
}>;

export type AsyncJsonFileLockOptions = JsonFileLockOptions & Readonly<{
  signal?: AbortSignal;
}>;

export function readAdapterState(path: string): any;
export function readJsonFile(path: string): any;
export function readJsonValue(path: string): any;
export function readStdinJson(): Promise<any>;
export function injectClientHookInput(input: Record<string, unknown>): void;
export function sha256(value: string | NodeJS.ArrayBufferView): string;
export function stringOption(value: unknown): string | undefined;
export function atomicWriteJson(path: string, value: unknown): void;
export function atomicWriteText(path: string, value: string): void;

export function withJsonFileLock<T>(
  path: string,
  operation: () => T,
  options?: JsonFileLockOptions,
): T;

export function withJsonFileLockAsync<T>(
  path: string,
  operation: () => T | Promise<T>,
  options?: AsyncJsonFileLockOptions,
): Promise<T>;
