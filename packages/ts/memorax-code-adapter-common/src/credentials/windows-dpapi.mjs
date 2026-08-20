import { randomBytes as nodeRandomBytes } from "node:crypto";
import * as nodeFs from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, win32 } from "node:path";
import {
  DEFAULT_SECURE_COMMAND_OUTPUT_BYTES,
  DEFAULT_SECURE_COMMAND_TIMEOUT_MS,
  SecureCredentialBackendError,
  decodeSecureCredential,
  encodeSecureCredential,
  environmentValue,
  executeSecureCommand,
  minimalEnvironment,
  runSecureCommand,
  secureCredentialBackendError,
  validateSecureCredentialNamespace,
  wipeSecureCommandResult,
} from "./secure-command.mjs";

const BACKEND = "windows-dpapi";
const CIPHERTEXT_LIMIT_BYTES = DEFAULT_SECURE_COMMAND_OUTPUT_BYTES;
const WINDOWS_ENVIRONMENT_NAMES = Object.freeze([
  "COMSPEC",
  "TEMP",
  "TMP",
  "USERPROFILE",
]);
const CREDENTIAL_FILE_NAME = "trial-credentials.v1.dpapi";
const DPAPI_ENTROPY_PREFIX = "MemoraX.Code.TrialCredentials.DPAPI.v1";
const DPAPI_ENTROPY_PLACEHOLDER = "__MEMORAX_DPAPI_ENTROPY__";
const CREDENTIAL_DIRECTORY_NAMES = Object.freeze([
  "MemoraX Code",
  "credentials",
]);

const PROTECT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$exitCode = 0
$sourceBytes = $null
$protectedBytes = $null
$entropyBytes = $null
$memoryBytes = $null
$memory = $null
$inputStream = $null
try {
  Add-Type -AssemblyName System.Security
  $memory = New-Object System.IO.MemoryStream
  $inputStream = [Console]::OpenStandardInput()
  $inputStream.CopyTo($memory)
  [byte[]]$sourceBytes = $memory.ToArray()
  [byte[]]$entropyBytes = [Text.Encoding]::UTF8.GetBytes('${DPAPI_ENTROPY_PLACEHOLDER}')
  [byte[]]$protectedBytes = [Security.Cryptography.ProtectedData]::Protect(
    $sourceBytes,
    $entropyBytes,
    [Security.Cryptography.DataProtectionScope]::CurrentUser
  )
  $output = [Console]::OpenStandardOutput()
  $output.Write($protectedBytes, 0, $protectedBytes.Length)
  $output.Flush()
} catch {
  [Console]::Error.Write('dpapi_protect_failed')
  $exitCode = 20
} finally {
  if ($null -ne $sourceBytes) { [Array]::Clear($sourceBytes, 0, $sourceBytes.Length) }
  if ($null -ne $protectedBytes) { [Array]::Clear($protectedBytes, 0, $protectedBytes.Length) }
  if ($null -ne $entropyBytes) { [Array]::Clear($entropyBytes, 0, $entropyBytes.Length) }
  if ($null -ne $memory) {
    try {
      [byte[]]$memoryBytes = $memory.GetBuffer()
      [Array]::Clear($memoryBytes, 0, $memoryBytes.Length)
    } finally {
      $memory.Dispose()
    }
  }
}
exit $exitCode
`;

const UNPROTECT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$exitCode = 0
$sourceBytes = $null
$plainBytes = $null
$entropyBytes = $null
$memoryBytes = $null
$memory = $null
$inputStream = $null
try {
  Add-Type -AssemblyName System.Security
  $memory = New-Object System.IO.MemoryStream
  $inputStream = [Console]::OpenStandardInput()
  $inputStream.CopyTo($memory)
  [byte[]]$sourceBytes = $memory.ToArray()
  [byte[]]$entropyBytes = [Text.Encoding]::UTF8.GetBytes('${DPAPI_ENTROPY_PLACEHOLDER}')
  [byte[]]$plainBytes = [Security.Cryptography.ProtectedData]::Unprotect(
    $sourceBytes,
    $entropyBytes,
    [Security.Cryptography.DataProtectionScope]::CurrentUser
  )
  $output = [Console]::OpenStandardOutput()
  $output.Write($plainBytes, 0, $plainBytes.Length)
  $output.Flush()
} catch {
  [Console]::Error.Write('dpapi_unprotect_failed')
  $exitCode = 21
} finally {
  if ($null -ne $sourceBytes) { [Array]::Clear($sourceBytes, 0, $sourceBytes.Length) }
  if ($null -ne $plainBytes) { [Array]::Clear($plainBytes, 0, $plainBytes.Length) }
  if ($null -ne $entropyBytes) { [Array]::Clear($entropyBytes, 0, $entropyBytes.Length) }
  if ($null -ne $memory) {
    try {
      [byte[]]$memoryBytes = $memory.GetBuffer()
      [Array]::Clear($memoryBytes, 0, $memoryBytes.Length)
    } finally {
      $memory.Dispose()
    }
  }
}
exit $exitCode
`;

export function createWindowsDpapiBackend(options) {
  const namespace = validateSecureCredentialNamespace(options?.namespace, BACKEND);
  const sourceEnvironment = options?.environment ?? process.env;
  const systemRoot = options?.systemRoot
    ?? environmentValue(sourceEnvironment, "SystemRoot")
    ?? environmentValue(sourceEnvironment, "WINDIR");
  if (typeof systemRoot !== "string" || !win32.isAbsolute(systemRoot)) {
    throw secureCredentialBackendError(BACKEND, "initialize", "backend_unavailable");
  }
  const localAppData = options?.localAppData
    ?? environmentValue(sourceEnvironment, "LOCALAPPDATA");
  if (typeof localAppData !== "string" || !isAbsolute(localAppData)) {
    throw secureCredentialBackendError(BACKEND, "initialize", "unsafe_path");
  }
  const storageRoot = normalizeLocalAppData(localAppData);

  const runner = options?.runner ?? runSecureCommand;
  const fileSystem = options?.fileSystem ?? nodeFs;
  const randomBytes = options?.randomBytes ?? nodeRandomBytes;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_SECURE_COMMAND_TIMEOUT_MS;
  const maxOutputBytes = options?.maxOutputBytes ?? DEFAULT_SECURE_COMMAND_OUTPUT_BYTES;
  const powerShell = win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const environment = minimalEnvironment(
    sourceEnvironment,
    WINDOWS_ENVIRONMENT_NAMES,
    { SystemRoot: systemRoot, WINDIR: systemRoot },
  );
  const credentialDirectoryNames = [...CREDENTIAL_DIRECTORY_NAMES, namespace];
  const credentialDirectory = join(storageRoot, ...credentialDirectoryNames);
  const credentialPath = join(credentialDirectory, CREDENTIAL_FILE_NAME);
  const protectScript = bindDpapiEntropy(PROTECT_SCRIPT, namespace);
  const unprotectScript = bindDpapiEntropy(UNPROTECT_SCRIPT, namespace);

  async function invoke(operation, script, input) {
    return executeSecureCommand(runner, {
      backend: BACKEND,
      operation,
      command: powerShell,
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      input,
      env: environment,
      timeoutMs,
      maxOutputBytes,
    });
  }

  return Object.freeze({
    async load() {
      const ciphertext = await readCiphertext(
        fileSystem,
        storageRoot,
        credentialDirectoryNames,
        credentialPath,
      );
      if (ciphertext === null) return null;
      try {
        const result = await invoke("load", unprotectScript, ciphertext);
        try {
          if (result.status !== 0 || result.signal !== null) {
            throw secureCredentialBackendError(BACKEND, "load", "command_failed");
          }
          return decodeSecureCredential(result.stdout, BACKEND, "load");
        } finally {
          wipeSecureCommandResult(result);
        }
      } finally {
        ciphertext.fill(0);
      }
    },

    async save(serialized) {
      const plaintext = encodeSecureCredential(serialized, BACKEND, "save");
      let ciphertext;
      try {
        const result = await invoke("save", protectScript, plaintext);
        try {
          if (result.status !== 0
            || result.signal !== null
            || result.stdout.length === 0
            || result.stdout.includes(plaintext)) {
            throw secureCredentialBackendError(BACKEND, "save", "command_failed");
          }
          if (result.stdout.length > CIPHERTEXT_LIMIT_BYTES) {
            throw secureCredentialBackendError(BACKEND, "save", "output_limit");
          }
          ciphertext = Buffer.from(result.stdout);
        } finally {
          wipeSecureCommandResult(result);
        }
      } finally {
        plaintext.fill(0);
      }
      try {
        await writeCiphertextAtomically(
          fileSystem,
          storageRoot,
          credentialDirectoryNames,
          credentialPath,
          ciphertext,
          randomBytes,
        );
      } finally {
        ciphertext.fill(0);
      }
    },

    async delete() {
      const directoryPresent = await requireSafeCredentialDirectory(
        fileSystem,
        storageRoot,
        credentialDirectoryNames,
        "delete",
        false,
      );
      if (!directoryPresent) return false;
      const present = await requireRegularFileOrMissing(fileSystem, credentialPath, "delete");
      if (!present) return false;
      try {
        await fileSystem.unlink(credentialPath);
        return true;
      } catch (error) {
        throw sanitizeStorageFailure(error, "delete");
      }
    },
  });
}

async function readCiphertext(
  fileSystem,
  storageRoot,
  credentialDirectoryNames,
  path,
) {
  const directoryPresent = await requireSafeCredentialDirectory(
    fileSystem,
    storageRoot,
    credentialDirectoryNames,
    "load",
    false,
  );
  if (!directoryPresent) return null;
  const present = await requireRegularFileOrMissing(fileSystem, path, "load");
  if (!present) return null;
  let ciphertext;
  try {
    ciphertext = await fileSystem.readFile(path);
  } catch (error) {
    throw sanitizeStorageFailure(error, "load");
  }
  const bytes = Buffer.from(ciphertext);
  if (bytes.length === 0 || bytes.length > CIPHERTEXT_LIMIT_BYTES) {
    bytes.fill(0);
    throw secureCredentialBackendError(BACKEND, "load", "invalid_response");
  }
  return bytes;
}

async function writeCiphertextAtomically(
  fileSystem,
  storageRoot,
  credentialDirectoryNames,
  path,
  ciphertext,
  randomBytes,
) {
  const directory = dirname(path);
  await requireSafeCredentialDirectory(
    fileSystem,
    storageRoot,
    credentialDirectoryNames,
    "save",
    true,
  );
  await requireRegularFileOrMissing(fileSystem, path, "save");

  let suffix;
  try {
    suffix = Buffer.from(randomBytes(12)).toString("hex");
  } catch (error) {
    throw sanitizeStorageFailure(error, "save");
  }
  if (!/^[0-9a-f]{24}$/.test(suffix)) {
    throw secureCredentialBackendError(BACKEND, "save", "storage_failed");
  }
  const temporaryPath = join(directory, `.${basename(path)}.${process.pid}.${suffix}.tmp`);
  let handle;
  try {
    handle = await fileSystem.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(ciphertext);
    await handle.sync();
    await handle.close();
    handle = undefined;
    const directoryStillPresent = await requireSafeCredentialDirectory(
      fileSystem,
      storageRoot,
      credentialDirectoryNames,
      "save",
      false,
    );
    if (!directoryStillPresent) {
      throw secureCredentialBackendError(BACKEND, "save", "storage_failed");
    }
    await requireRegularFileOrMissing(fileSystem, path, "save");
    await fileSystem.rename(temporaryPath, path);
  } catch (error) {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        // Preserve the original, redacted storage failure.
      }
    }
    try {
      await fileSystem.unlink(temporaryPath);
    } catch {
      // Best-effort cleanup; the original failure remains authoritative.
    }
    throw sanitizeStorageFailure(error, "save");
  }
}

async function requireSafeCredentialDirectory(
  fileSystem,
  storageRoot,
  childNames,
  operation,
  create,
) {
  await requireRealDirectory(fileSystem, storageRoot, operation, false);
  let currentPath = storageRoot;
  for (const name of childNames) {
    currentPath = join(currentPath, name);
    const present = await requireRealDirectory(
      fileSystem,
      currentPath,
      operation,
      true,
    );
    if (present) continue;
    if (!create) return false;
    try {
      await fileSystem.mkdir(currentPath, { mode: 0o700 });
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) {
        throw sanitizeStorageFailure(error, operation);
      }
    }
    await requireRealDirectory(fileSystem, currentPath, operation, false);
  }
  return true;
}

async function requireRealDirectory(fileSystem, path, operation, allowMissing) {
  let status;
  try {
    status = await fileSystem.lstat(path);
  } catch (error) {
    if (allowMissing && isMissing(error)) return false;
    throw sanitizeStorageFailure(error, operation);
  }
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw secureCredentialBackendError(BACKEND, operation, "unsafe_path");
  }
  return true;
}

async function requireRegularFileOrMissing(fileSystem, path, operation) {
  let status;
  try {
    status = await fileSystem.lstat(path);
  } catch (error) {
    if (isMissing(error)) return false;
    throw sanitizeStorageFailure(error, operation);
  }
  if (status.isSymbolicLink() || !status.isFile()) {
    throw secureCredentialBackendError(BACKEND, operation, "unsafe_path");
  }
  return true;
}

function sanitizeStorageFailure(error, operation) {
  if (error instanceof SecureCredentialBackendError) return error;
  return secureCredentialBackendError(BACKEND, operation, "storage_failed");
}

function bindDpapiEntropy(script, namespace) {
  return script.replace(
    DPAPI_ENTROPY_PLACEHOLDER,
    `${DPAPI_ENTROPY_PREFIX}:${namespace}`,
  );
}

function normalizeLocalAppData(localAppData) {
  const normalized = normalize(localAppData);
  if (process.platform === "win32") {
    const root = win32.parse(normalized).root;
    if (!/^[A-Za-z]:\\$/.test(root)
      || normalized.toLowerCase() === root.toLowerCase()) {
      throw secureCredentialBackendError(BACKEND, "initialize", "unsafe_path");
    }
  }
  return normalized;
}

function isMissing(error) {
  return hasErrorCode(error, "ENOENT");
}

function hasErrorCode(error, code) {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === code;
}
