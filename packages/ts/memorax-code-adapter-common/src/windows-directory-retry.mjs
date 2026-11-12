const RETRYABLE_ERRORS = new Set(["EPERM", "EACCES", "EBUSY", "ENOTEMPTY"]);
const RETRY_DELAYS_MS = [100, 200, 300, 400];
const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));

// Windows readers may briefly deny a file or directory removal or rename. Retry only
// that operation; rerunning an installation would repeat unrelated mutations.
export function withWindowsDirectoryRetry(operation) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      if (process.platform !== "win32" || !RETRYABLE_ERRORS.has(error?.code)
        || attempt >= RETRY_DELAYS_MS.length) {
        throw error;
      }
      Atomics.wait(SLEEP_BUFFER, 0, 0, RETRY_DELAYS_MS[attempt]);
    }
  }
}
