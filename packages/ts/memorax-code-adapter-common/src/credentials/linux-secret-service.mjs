import {
  DEFAULT_SECURE_COMMAND_OUTPUT_BYTES,
  DEFAULT_SECURE_COMMAND_TIMEOUT_MS,
  decodeSecureCredential,
  encodeSecureCredential,
  executeSecureCommand,
  minimalEnvironment,
  runSecureCommand,
  secureCredentialBackendError,
  validateSecureCredentialNamespace,
  wipeSecureCommandResult,
} from "./secure-command.mjs";

const BACKEND = "linux-secret-service";
const SECRET_TOOL = "/usr/bin/secret-tool";
const LINUX_ENVIRONMENT_NAMES = Object.freeze([
  "DBUS_SESSION_BUS_ADDRESS",
  "XDG_RUNTIME_DIR",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "HOME",
  "LANG",
  "LC_ALL",
]);

export function createLinuxSecretServiceBackend(options) {
  const namespace = validateSecureCredentialNamespace(options?.namespace, BACKEND);
  const runner = options?.runner ?? runSecureCommand;
  const environment = minimalEnvironment(options?.environment ?? process.env, LINUX_ENVIRONMENT_NAMES);
  const timeoutMs = options?.timeoutMs ?? DEFAULT_SECURE_COMMAND_TIMEOUT_MS;
  const maxOutputBytes = options?.maxOutputBytes ?? DEFAULT_SECURE_COMMAND_OUTPUT_BYTES;
  const attributes = Object.freeze([
    "application",
    "memorax-code",
    "record",
    "trial-credentials",
    "namespace",
    namespace,
  ]);

  async function invoke(operation, args, input = undefined) {
    return executeSecureCommand(runner, {
      backend: BACKEND,
      operation,
      command: SECRET_TOOL,
      args,
      input,
      env: environment,
      timeoutMs,
      maxOutputBytes,
    });
  }

  return Object.freeze({
    async load() {
      const result = await invoke("load", ["lookup", "--", ...attributes]);
      try {
        if (result.status === 1
          && result.stdout.length === 0
          && result.stderr.length === 0) return null;
        if (result.status !== 0 || result.signal !== null) {
          throw secureCredentialBackendError(BACKEND, "load", "command_failed");
        }
        return decodeSecureCredential(result.stdout, BACKEND, "load");
      } finally {
        wipeSecureCommandResult(result);
      }
    },

    async save(serialized) {
      const input = encodeSecureCredential(serialized, BACKEND, "save");
      try {
        const result = await invoke(
          "save",
          [
            "store",
            "--label=MemoraX Code trial credentials",
            "--",
            ...attributes,
          ],
          input,
        );
        try {
          if (result.status !== 0 || result.signal !== null) {
            throw secureCredentialBackendError(BACKEND, "save", "command_failed");
          }
        } finally {
          wipeSecureCommandResult(result);
        }
      } finally {
        input.fill(0);
      }
    },

    async delete() {
      const result = await invoke("delete", ["clear", "--", ...attributes]);
      try {
        if (result.status === 1
          && result.stdout.length === 0
          && result.stderr.length === 0) return false;
        if (result.status !== 0 || result.signal !== null) {
          throw secureCredentialBackendError(BACKEND, "delete", "command_failed");
        }
        return true;
      } finally {
        wipeSecureCommandResult(result);
      }
    },
  });
}
