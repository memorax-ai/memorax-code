import { spawn } from "node:child_process";
import { TextDecoder } from "node:util";

export const MAX_SECURE_CREDENTIAL_BYTES = 4096;
export const DEFAULT_SECURE_COMMAND_TIMEOUT_MS = 30_000;
export const DEFAULT_SECURE_COMMAND_OUTPUT_BYTES = 8192;

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const NAMESPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ERROR_REASONS = new Set([
  "backend_unavailable",
  "command_failed",
  "command_timeout",
  "invalid_namespace",
  "invalid_response",
  "invalid_secret",
  "output_limit",
  "secret_too_large",
  "storage_failed",
  "unsafe_path",
]);

export class SecureCredentialBackendError extends Error {
  constructor({ backend, operation, reason }) {
    super("Secure credential backend operation failed.");
    this.name = "SecureCredentialBackendError";
    this.code = "TRIAL_CREDENTIAL_BACKEND_ERROR";
    this.backend = safeIdentifier(backend, "unknown");
    this.operation = safeIdentifier(operation, "unknown");
    this.reason = ERROR_REASONS.has(reason) ? reason : "command_failed";
  }
}

export function secureCredentialBackendError(backend, operation, reason) {
  return new SecureCredentialBackendError({ backend, operation, reason });
}

export function validateSecureCredentialNamespace(namespace, backend, operation = "initialize") {
  if (typeof namespace !== "string" || !NAMESPACE_PATTERN.test(namespace)) {
    throw secureCredentialBackendError(backend, operation, "invalid_namespace");
  }
  return namespace;
}

export function encodeSecureCredential(serialized, backend, operation = "save") {
  if (typeof serialized !== "string" || serialized.length === 0 || serialized.includes("\0")) {
    throw secureCredentialBackendError(backend, operation, "invalid_secret");
  }
  const encoded = Buffer.from(serialized, "utf8");
  if (encoded.length > MAX_SECURE_CREDENTIAL_BYTES) {
    encoded.fill(0);
    throw secureCredentialBackendError(backend, operation, "secret_too_large");
  }
  return encoded;
}

export function decodeSecureCredential(encoded, backend, operation = "load") {
  const bytes = bufferFrom(encoded);
  try {
    if (bytes.length === 0 || bytes.length > MAX_SECURE_CREDENTIAL_BYTES) {
      throw secureCredentialBackendError(
        backend,
        operation,
        bytes.length > MAX_SECURE_CREDENTIAL_BYTES ? "secret_too_large" : "invalid_response",
      );
    }
    let decoded;
    try {
      decoded = UTF8_DECODER.decode(bytes);
    } catch {
      throw secureCredentialBackendError(backend, operation, "invalid_response");
    }
    if (!decoded || decoded.includes("\0")) {
      throw secureCredentialBackendError(backend, operation, "invalid_response");
    }
    return decoded;
  } finally {
    bytes.fill(0);
  }
}

export async function executeSecureCommand(runner, specification) {
  const backend = safeIdentifier(specification?.backend, "unknown");
  const operation = safeIdentifier(specification?.operation, "unknown");
  let result;
  try {
    result = await runner(specification);
  } catch (error) {
    if (error instanceof SecureCredentialBackendError) {
      throw secureCredentialBackendError(backend, operation, error.reason);
    }
    throw secureCredentialBackendError(backend, operation, "command_failed");
  }
  if (!result || typeof result !== "object") {
    throw secureCredentialBackendError(backend, operation, "invalid_response");
  }
  let rawStdout;
  let rawStderr;
  let stdout;
  let stderr;
  let returned = false;
  try {
    rawStdout = result.stdout;
    rawStderr = result.stderr;
    const rawStatus = result.status;
    const status = rawStatus === null || Number.isInteger(rawStatus)
      ? rawStatus
      : undefined;
    if (status === undefined) {
      throw secureCredentialBackendError(backend, operation, "invalid_response");
    }
    stdout = resultBuffer(rawStdout);
    stderr = resultBuffer(rawStderr);
    if (stdout === undefined || stderr === undefined) {
      throw secureCredentialBackendError(backend, operation, "invalid_response");
    }
    const outputLimit = positiveInteger(
      specification.maxOutputBytes,
      DEFAULT_SECURE_COMMAND_OUTPUT_BYTES,
    );
    if (stdout.length > outputLimit || stderr.length > outputLimit) {
      throw secureCredentialBackendError(backend, operation, "output_limit");
    }
    const signal = result.signal;
    returned = true;
    return {
      status,
      signal: typeof signal === "string" ? signal : null,
      stdout,
      stderr,
    };
  } catch (error) {
    if (error instanceof SecureCredentialBackendError) {
      throw secureCredentialBackendError(backend, operation, error.reason);
    }
    throw secureCredentialBackendError(backend, operation, "invalid_response");
  } finally {
    wipeByteArray(rawStdout);
    wipeByteArray(rawStderr);
    if (!returned) {
      stdout?.fill(0);
      stderr?.fill(0);
    }
  }
}

export function wipeSecureCommandResult(result) {
  if (!result || typeof result !== "object") return;
  try {
    wipeByteArray(result.stdout);
  } catch {
    // Best-effort cleanup must not replace the operation result.
  }
  try {
    wipeByteArray(result.stderr);
  } catch {
    // Best-effort cleanup must not replace the operation result.
  }
}

export function runSecureCommand(specification) {
  const backend = safeIdentifier(specification?.backend, "unknown");
  const operation = safeIdentifier(specification?.operation, "unknown");
  const timeoutMs = positiveInteger(
    specification?.timeoutMs,
    DEFAULT_SECURE_COMMAND_TIMEOUT_MS,
  );
  const maxOutputBytes = positiveInteger(
    specification?.maxOutputBytes,
    DEFAULT_SECURE_COMMAND_OUTPUT_BYTES,
  );
  const input = bufferFrom(specification?.input);
  let child;
  try {
    child = spawn(specification.command, specification.args ?? [], {
      env: specification.env ?? Object.create(null),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch {
    input.fill(0);
    return Promise.reject(secureCredentialBackendError(
      backend,
      operation,
      "backend_unavailable",
    ));
  }

  return new Promise((resolve, reject) => {
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timer;

    const wipeInput = () => input.fill(0);
    const wipeOutput = () => {
      for (const chunk of stdout) chunk.fill(0);
      for (const chunk of stderr) chunk.fill(0);
    };
    const closePipes = () => {
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const finishError = (reason, { terminate = false } = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (terminate) stopChild();
      closePipes();
      child.unref?.();
      wipeInput();
      wipeOutput();
      reject(secureCredentialBackendError(backend, operation, reason));
    };
    const stopChild = () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Best effort; the caller still receives the bounded, redacted failure.
      }
    };
    const collect = (chunk, chunks, currentBytes, setBytes) => {
      const bytes = Buffer.from(chunk);
      if (settled) {
        bytes.fill(0);
        return;
      }
      if (currentBytes + bytes.length > maxOutputBytes) {
        bytes.fill(0);
        finishError("output_limit", { terminate: true });
        return;
      }
      chunks.push(bytes);
      setBytes(currentBytes + bytes.length);
    };

    timer = setTimeout(
      () => finishError("command_timeout", { terminate: true }),
      timeoutMs,
    );
    timer.unref?.();

    child.stdout.on("data", (chunk) => collect(
      chunk,
      stdout,
      stdoutBytes,
      (value) => { stdoutBytes = value; },
    ));
    child.stderr.on("data", (chunk) => collect(
      chunk,
      stderr,
      stderrBytes,
      (value) => { stderrBytes = value; },
    ));
    child.stdout.on("error", () => finishError("command_failed", { terminate: true }));
    child.stderr.on("error", () => finishError("command_failed", { terminate: true }));
    child.stdin.on("error", () => {
      // A non-zero child result remains the authority for a closed stdin.
    });
    child.once("error", () => finishError("backend_unavailable"));
    child.once("close", (status, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      wipeInput();
      const collectedStdout = Buffer.concat(stdout, stdoutBytes);
      const collectedStderr = Buffer.concat(stderr, stderrBytes);
      wipeOutput();
      resolve({
        status: Number.isInteger(status) ? status : null,
        signal: typeof signal === "string" ? signal : null,
        stdout: collectedStdout,
        stderr: collectedStderr,
      });
    });
    child.stdin.end(input);
  });
}

export function minimalEnvironment(source, names, overrides = undefined) {
  const environment = Object.create(null);
  for (const name of names) {
    const value = environmentValue(source, name);
    if (value !== undefined) environment[name] = value;
  }
  if (overrides) {
    for (const [name, value] of Object.entries(overrides)) {
      if (typeof value === "string" && value) environment[name] = value;
    }
  }
  return environment;
}

export function environmentValue(source, requestedName) {
  if (!source || typeof source !== "object") return undefined;
  const exact = source[requestedName];
  if (typeof exact === "string" && exact) return exact;
  const requested = requestedName.toLowerCase();
  const matchingName = Object.keys(source).find((name) => name.toLowerCase() === requested);
  const matching = matchingName === undefined ? undefined : source[matchingName];
  return typeof matching === "string" && matching ? matching : undefined;
}

function bufferFrom(value) {
  if (value === undefined || value === null) return Buffer.alloc(0);
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }
  if (typeof value === "string") return Buffer.from(value, "utf8");
  return Buffer.alloc(0);
}

function resultBuffer(value) {
  if (value === undefined || value === null) return Buffer.alloc(0);
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }
  if (typeof value === "string") return Buffer.from(value, "utf8");
  return undefined;
}

function wipeByteArray(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) value.fill(0);
}

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function safeIdentifier(value, fallback) {
  return typeof value === "string" && /^[a-z0-9_-]{1,64}$/.test(value)
    ? value
    : fallback;
}
