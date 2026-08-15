import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import * as fileSystem from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createLinuxSecretServiceBackend,
} from "../../../ts/memorax-code-adapter-common/src/credentials/linux-secret-service.mjs";
import {
  SecureCredentialBackendError,
  executeSecureCommand,
  runSecureCommand,
  wipeSecureCommandResult,
} from "../../../ts/memorax-code-adapter-common/src/credentials/secure-command.mjs";
import {
  createWindowsDpapiBackend,
} from "../../../ts/memorax-code-adapter-common/src/credentials/windows-dpapi.mjs";

const API_KEY = `sk_${"S".repeat(43)}`;
const PLUGIN_MARK = `mk_${"a".repeat(32)}`;
const SERIALIZED_CREDENTIAL = JSON.stringify({
  version: 1,
  state: "provisioning",
  plugin_mark: PLUGIN_MARK,
  api_key: API_KEY,
});
const NAMESPACE = "test-0123456789abcdef";
const RUN_REAL_LINUX_SECRET_SERVICE_TEST = process.platform === "linux"
  && process.env.MEMORAX_CODE_RUN_REAL_LINUX_SECRET_SERVICE_TESTS === "1";

test("Linux Secret Service keeps the credential in stdin/stdout only", async () => {
  const calls = [];
  let stored;
  const runner = async (specification) => {
    calls.push(capturedCall(specification));
    const action = specification.args[0];
    if (action === "store") {
      stored = Buffer.from(specification.input);
      return commandResult();
    }
    if (action === "lookup") {
      return stored === undefined
        ? commandResult({ status: 1 })
        : commandResult({ stdout: stored });
    }
    if (action === "clear") {
      if (stored === undefined) return commandResult({ status: 1 });
      stored.fill(0);
      stored = undefined;
      return commandResult();
    }
    throw new Error(`unexpected action: ${action}`);
  };
  const backend = createLinuxSecretServiceBackend({
    namespace: NAMESPACE,
    runner,
    environment: {
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      HOME: "/home/test-user",
      MEMORAX_API_KEY: API_KEY,
      PRIVATE_CREDENTIAL: SERIALIZED_CREDENTIAL,
    },
  });

  await backend.save(SERIALIZED_CREDENTIAL);
  assert.equal(await backend.load(), SERIALIZED_CREDENTIAL);
  assert.equal(await backend.delete(), true);
  assert.equal(await backend.load(), null);
  assert.equal(await backend.delete(), false);

  assert.equal(calls[0].command, "/usr/bin/secret-tool");
  assert.deepEqual(calls[0].args, [
    "store",
    "--label=MemoraX Code trial credentials",
    "--",
    "application",
    "memorax-code",
    "record",
    "trial-credentials",
    "namespace",
    NAMESPACE,
  ]);
  assert.equal(calls[0].input.toString("utf8"), SERIALIZED_CREDENTIAL);
  for (const call of calls) {
    assertPublicInvocationContainsNoSecret(call);
  }
  assert.deepEqual(Object.keys(calls[0].env).sort(), [
    "DBUS_SESSION_BUS_ADDRESS",
    "HOME",
  ]);
});

test("Linux Secret Service distinguishes absent records and sanitizes backend failures", async () => {
  const absent = createLinuxSecretServiceBackend({
    namespace: NAMESPACE,
    runner: async () => commandResult({ status: 1 }),
    environment: {},
  });
  assert.equal(await absent.load(), null);
  assert.equal(await absent.delete(), false);

  const failed = createLinuxSecretServiceBackend({
    namespace: NAMESPACE,
    runner: async () => commandResult({
      status: 1,
      stdout: SERIALIZED_CREDENTIAL,
      stderr: SERIALIZED_CREDENTIAL,
    }),
    environment: {},
  });
  await assert.rejects(failed.load(), redactedError("linux-secret-service", "load"));

  const contradictory = createLinuxSecretServiceBackend({
    namespace: NAMESPACE,
    runner: async () => commandResult({
      status: 1,
      stdout: SERIALIZED_CREDENTIAL,
    }),
    environment: {},
  });
  await assert.rejects(
    contradictory.load(),
    redactedError("linux-secret-service", "load"),
  );

  const thrown = createLinuxSecretServiceBackend({
    namespace: NAMESPACE,
    runner: async () => {
      throw new Error(SERIALIZED_CREDENTIAL);
    },
    environment: {},
  });
  await assert.rejects(
    thrown.save(SERIALIZED_CREDENTIAL),
    redactedError("linux-secret-service", "save"),
  );
});

test("Linux Secret Service supports a real create-read-delete lifecycle", {
  skip: !RUN_REAL_LINUX_SECRET_SERVICE_TEST,
}, async () => {
  const namespace = `real-linux-${randomBytes(16).toString("hex")}`;
  const serialized = `${SERIALIZED_CREDENTIAL}\n`;
  const backend = createLinuxSecretServiceBackend({ namespace });
  try {
    assert.equal(await backend.load(), null);
    await backend.save(serialized);
    assert.equal(
      credentialDigest(await backend.load()),
      credentialDigest(serialized),
    );
    assert.equal(await backend.delete(), true);
    assert.equal(await backend.load(), null);
  } finally {
    await backend.delete().catch(() => {});
  }
});

test("Windows DPAPI passes plaintext only through PowerShell stdin and stores only ciphertext", async () => {
  const localAppData = await fileSystem.mkdtemp(join(tmpdir(), "memorax-code-dpapi-"));
  const ciphertext = Buffer.from([0x44, 0x50, 0x41, 0x50, 0x49, 0, 1, 2, 3]);
  const calls = [];
  const runner = async (specification) => {
    calls.push(capturedCall(specification));
    const script = specification.args.at(-1);
    if (script.includes("ProtectedData]::Protect(")) {
      assert.equal(Buffer.from(specification.input).toString("utf8"), SERIALIZED_CREDENTIAL);
      return commandResult({ stdout: ciphertext });
    }
    if (script.includes("ProtectedData]::Unprotect(")) {
      assert.deepEqual(Buffer.from(specification.input), ciphertext);
      return commandResult({ stdout: SERIALIZED_CREDENTIAL });
    }
    throw new Error("unexpected PowerShell script");
  };

  try {
    const backend = createWindowsDpapiBackend({
      namespace: NAMESPACE,
      localAppData,
      systemRoot: "C:\\Windows",
      runner,
      randomBytes: () => Buffer.alloc(12, 0x2a),
      environment: {
        SystemRoot: "C:\\Windows",
        TEMP: "C:\\Temp",
        LOCALAPPDATA: localAppData,
        MEMORAX_API_KEY: API_KEY,
        PRIVATE_CREDENTIAL: SERIALIZED_CREDENTIAL,
      },
    });

    await backend.save(SERIALIZED_CREDENTIAL);
    const credentialPath = join(
      localAppData,
      "MemoraX Code",
      "credentials",
      NAMESPACE,
      "trial-credentials.v1.dpapi",
    );
    const diskBytes = await fileSystem.readFile(credentialPath);
    assert.deepEqual(diskBytes, ciphertext);
    assert.equal(diskBytes.includes(Buffer.from(API_KEY)), false);
    assert.equal(diskBytes.includes(Buffer.from(PLUGIN_MARK)), false);
    assert.equal(await backend.load(), SERIALIZED_CREDENTIAL);
    assert.equal(await backend.delete(), true);
    assert.equal(await backend.delete(), false);

    assert.equal(
      calls[0].command,
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    assert.deepEqual(calls[0].args.slice(0, 4), [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
    ]);
    assert.match(calls[0].args.at(-1), /DataProtectionScope]::CurrentUser/);
    assert.match(calls[0].args.at(-1), /\$memory\.GetBuffer\(\)/);
    for (const call of calls) {
      assert.match(
        call.args.at(-1),
        new RegExp(`MemoraX\\.Code\\.TrialCredentials\\.DPAPI\\.v1:${NAMESPACE}`),
      );
    }
    for (const call of calls) {
      assertPublicInvocationContainsNoSecret(call);
    }
    assert.deepEqual(Object.keys(calls[0].env).sort(), [
      "SystemRoot",
      "TEMP",
      "WINDIR",
    ]);
  } finally {
    await fileSystem.rm(localAppData, { recursive: true, force: true });
  }
});

test("Windows DPAPI treats only records below an existing LocalAppData root as absent", async () => {
  const localAppData = await fileSystem.mkdtemp(join(tmpdir(), "memorax-code-dpapi-absent-"));
  try {
    const absent = createWindowsDpapiBackend({
      namespace: NAMESPACE,
      localAppData,
      systemRoot: "C:\\Windows",
      runner: async () => {
        throw new Error("runner must not be called");
      },
      environment: {},
    });
    assert.equal(await absent.load(), null);
    assert.equal(await absent.delete(), false);
  } finally {
    await fileSystem.rm(localAppData, { recursive: true, force: true });
  }

  const missingParent = await fileSystem.mkdtemp(join(tmpdir(), "memorax-code-dpapi-root-"));
  try {
    const missingRoot = createWindowsDpapiBackend({
      namespace: NAMESPACE,
      localAppData: join(missingParent, "missing"),
      systemRoot: "C:\\Windows",
      runner: async () => {
        throw new Error("runner must not be called");
      },
      environment: {},
    });
    await assert.rejects(missingRoot.load(), (error) => {
      assert.equal(error.reason, "storage_failed");
      return redactedError("windows-dpapi", "load")(error);
    });
    await assert.rejects(missingRoot.delete(), (error) => {
      assert.equal(error.reason, "storage_failed");
      return redactedError("windows-dpapi", "delete")(error);
    });
  } finally {
    await fileSystem.rm(missingParent, { recursive: true, force: true });
  }
});

test("Windows DPAPI rejects unsafe credential paths and redacts storage failures", async () => {

  const unsafeFileSystem = {
    lstat: async (path) => path.endsWith("trial-credentials.v1.dpapi")
      ? {
          isFile: () => false,
          isDirectory: () => false,
          isSymbolicLink: () => true,
        }
      : directoryStatus(),
  };
  const unsafe = createWindowsDpapiBackend({
    namespace: NAMESPACE,
    localAppData: join(tmpdir(), "memorax-code-dpapi-unsafe"),
    systemRoot: "C:\\Windows",
    fileSystem: unsafeFileSystem,
    runner: async () => commandResult(),
    environment: {},
  });
  await assert.rejects(unsafe.load(), (error) => {
    assert.equal(error.reason, "unsafe_path");
    return redactedError("windows-dpapi", "load")(error);
  });

  const deniedFileSystem = {
    lstat: async () => {
      throw Object.assign(new Error(SERIALIZED_CREDENTIAL), { code: "EACCES" });
    },
  };
  const denied = createWindowsDpapiBackend({
    namespace: NAMESPACE,
    localAppData: join(tmpdir(), "memorax-code-dpapi-denied"),
    systemRoot: "C:\\Windows",
    fileSystem: deniedFileSystem,
    runner: async () => commandResult(),
    environment: {},
  });
  await assert.rejects(denied.load(), redactedError("windows-dpapi", "load"));
});

test("Windows DPAPI rejects an ancestor directory symlink or junction", async () => {
  const parent = await fileSystem.mkdtemp(join(tmpdir(), "memorax-code-dpapi-link-"));
  const localAppData = join(parent, "local-app-data");
  const linkedLocalAppData = join(parent, "linked-local-app-data");
  const outside = join(parent, "outside");
  await fileSystem.mkdir(localAppData);
  await fileSystem.mkdir(outside);
  await fileSystem.symlink(
    outside,
    join(localAppData, "MemoraX Code"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await fileSystem.symlink(
    outside,
    linkedLocalAppData,
    process.platform === "win32" ? "junction" : "dir",
  );

  try {
    const backend = createWindowsDpapiBackend({
      namespace: NAMESPACE,
      localAppData,
      systemRoot: "C:\\Windows",
      runner: async () => {
        throw new Error("runner must not be called");
      },
      environment: {},
    });
    await assert.rejects(backend.load(), (error) => {
      assert.equal(error.reason, "unsafe_path");
      return redactedError("windows-dpapi", "load")(error);
    });

    const linkedRootBackend = createWindowsDpapiBackend({
      namespace: NAMESPACE,
      localAppData: linkedLocalAppData,
      systemRoot: "C:\\Windows",
      runner: async () => {
        throw new Error("runner must not be called");
      },
      environment: {},
    });
    await assert.rejects(linkedRootBackend.load(), (error) => {
      assert.equal(error.reason, "unsafe_path");
      return redactedError("windows-dpapi", "load")(error);
    });
  } finally {
    await fileSystem.rm(parent, { recursive: true, force: true });
  }
});

test("Windows DPAPI does not turn a post-lstat ENOENT race into absence", async () => {
  const raceFileSystem = {
    lstat: async (path) => path.endsWith("trial-credentials.v1.dpapi")
      ? regularFileStatus()
      : directoryStatus(),
    readFile: async () => {
      throw Object.assign(new Error("removed after lstat"), { code: "ENOENT" });
    },
  };
  const backend = createWindowsDpapiBackend({
    namespace: NAMESPACE,
    localAppData: join(tmpdir(), "memorax-code-dpapi-race"),
    systemRoot: "C:\\Windows",
    fileSystem: raceFileSystem,
    runner: async () => {
      throw new Error("runner must not be called");
    },
    environment: {},
  });

  await assert.rejects(backend.load(), (error) => {
    assert.equal(error.reason, "storage_failed");
    return redactedError("windows-dpapi", "load")(error);
  });

  const deleteRace = createWindowsDpapiBackend({
    namespace: NAMESPACE,
    localAppData: join(tmpdir(), "memorax-code-dpapi-delete-race"),
    systemRoot: "C:\\Windows",
    fileSystem: {
      lstat: raceFileSystem.lstat,
      unlink: async () => {
        throw Object.assign(new Error("removed after lstat"), { code: "ENOENT" });
      },
    },
    runner: async () => {
      throw new Error("runner must not be called");
    },
    environment: {},
  });
  await assert.rejects(deleteRace.delete(), (error) => {
    assert.equal(error.reason, "storage_failed");
    return redactedError("windows-dpapi", "delete")(error);
  });
});

test("Windows DPAPI binds ciphertext protection to the credential namespace", async () => {
  const localAppData = await fileSystem.mkdtemp(join(tmpdir(), "memorax-code-dpapi-entropy-"));
  const protectedRecords = new Map();
  let ciphertextSequence = 0;
  const runner = async (specification) => {
    const script = specification.args.at(-1);
    const entropy = script.match(/GetBytes\('([^']+)'\)/)?.[1];
    assert.ok(entropy?.startsWith("MemoraX.Code.TrialCredentials.DPAPI.v1:"));
    if (script.includes("ProtectedData]::Protect(")) {
      const ciphertext = Buffer.from(`ciphertext-${ciphertextSequence += 1}`);
      protectedRecords.set(ciphertext.toString("hex"), {
        entropy,
        plaintext: Buffer.from(specification.input),
      });
      return commandResult({ stdout: ciphertext });
    }
    if (script.includes("ProtectedData]::Unprotect(")) {
      const record = protectedRecords.get(Buffer.from(specification.input).toString("hex"));
      if (record?.entropy !== entropy) return commandResult({ status: 21 });
      return commandResult({ stdout: record.plaintext });
    }
    throw new Error("unexpected PowerShell script");
  };
  const namespaceA = "credential-namespace-a";
  const namespaceB = "credential-namespace-b";

  try {
    const backendA = createWindowsDpapiBackend({
      namespace: namespaceA,
      localAppData,
      systemRoot: "C:\\Windows",
      runner,
      randomBytes: () => Buffer.alloc(12, 0x31),
      environment: {},
    });
    const backendB = createWindowsDpapiBackend({
      namespace: namespaceB,
      localAppData,
      systemRoot: "C:\\Windows",
      runner,
      environment: {},
    });

    await backendA.save(SERIALIZED_CREDENTIAL);
    assert.equal(await backendA.load(), SERIALIZED_CREDENTIAL);
    const sourcePath = windowsCredentialPath(localAppData, namespaceA);
    const transplantedPath = windowsCredentialPath(localAppData, namespaceB);
    await fileSystem.mkdir(join(transplantedPath, ".."), { recursive: true });
    await fileSystem.copyFile(sourcePath, transplantedPath);

    await assert.rejects(
      backendB.load(),
      (error) => {
        assert.equal(error.reason, "command_failed");
        return redactedError("windows-dpapi", "load")(error);
      },
    );
  } finally {
    for (const record of protectedRecords.values()) record.plaintext.fill(0);
    await fileSystem.rm(localAppData, { recursive: true, force: true });
  }
});

test("Windows DPAPI leaves the previous ciphertext intact when atomic replacement fails", async () => {
  const localAppData = await fileSystem.mkdtemp(join(tmpdir(), "memorax-code-dpapi-atomic-"));
  const firstCiphertext = Buffer.from("first-dpapi-ciphertext");
  const secondCiphertext = Buffer.from("second-dpapi-ciphertext");
  let protectedValue = firstCiphertext;
  const runner = async () => commandResult({ stdout: protectedValue });
  const wrappedFileSystem = {
    ...fileSystem,
    rename: async (source, destination) => {
      if (protectedValue === secondCiphertext) {
        throw new Error(SERIALIZED_CREDENTIAL);
      }
      return fileSystem.rename(source, destination);
    },
  };

  try {
    const backend = createWindowsDpapiBackend({
      namespace: NAMESPACE,
      localAppData,
      systemRoot: "C:\\Windows",
      runner,
      fileSystem: wrappedFileSystem,
      randomBytes: () => Buffer.alloc(12, protectedValue === firstCiphertext ? 1 : 2),
      environment: {},
    });
    await backend.save(SERIALIZED_CREDENTIAL);
    protectedValue = secondCiphertext;
    await assert.rejects(
      backend.save(SERIALIZED_CREDENTIAL),
      redactedError("windows-dpapi", "save"),
    );

    const credentialPath = join(
      localAppData,
      "MemoraX Code",
      "credentials",
      NAMESPACE,
      "trial-credentials.v1.dpapi",
    );
    assert.deepEqual(await fileSystem.readFile(credentialPath), firstCiphertext);
    const names = await fileSystem.readdir(join(credentialPath, ".."));
    assert.equal(names.some((name) => name.endsWith(".tmp")), false);
  } finally {
    await fileSystem.rm(localAppData, { recursive: true, force: true });
  }
});

test("Windows DPAPI refuses a successful command that echoes plaintext", async () => {
  const localAppData = await fileSystem.mkdtemp(join(tmpdir(), "memorax-code-dpapi-echo-"));
  try {
    const backend = createWindowsDpapiBackend({
      namespace: NAMESPACE,
      localAppData,
      systemRoot: "C:\\Windows",
      runner: async () => commandResult({ stdout: SERIALIZED_CREDENTIAL }),
      environment: {},
    });
    await assert.rejects(
      backend.save(SERIALIZED_CREDENTIAL),
      redactedError("windows-dpapi", "save"),
    );
    await assert.rejects(
      fileSystem.access(join(
        localAppData,
        "MemoraX Code",
        "credentials",
        NAMESPACE,
        "trial-credentials.v1.dpapi",
      )),
      { code: "ENOENT" },
    );
  } finally {
    await fileSystem.rm(localAppData, { recursive: true, force: true });
  }
});

test("secure command runner redacts timeout and output-limit failures", async () => {
  await assert.rejects(runSecureCommand({
    backend: "test-backend",
    operation: "save",
    command: process.execPath,
    args: ["-e", "setTimeout(() => {}, 1000)"],
    input: SERIALIZED_CREDENTIAL,
    env: {},
    timeoutMs: 20,
    maxOutputBytes: 64,
  }), (error) => {
    assert.equal(error.reason, "command_timeout");
    return redactedError("test-backend", "save")(error);
  });

  await assert.rejects(runSecureCommand({
    backend: "test-backend",
    operation: "load",
    command: process.execPath,
    args: ["-e", "process.stdout.write('x'.repeat(128))"],
    input: SERIALIZED_CREDENTIAL,
    env: {},
    timeoutMs: 5000,
    maxOutputBytes: 64,
  }), (error) => {
    assert.equal(error.reason, "output_limit");
    return redactedError("test-backend", "load")(error);
  });
});

test("secure command normalization wipes runner-owned and consumed output buffers", async () => {
  const rawStdout = Buffer.from(SERIALIZED_CREDENTIAL);
  const rawStderr = Buffer.from("diagnostic");
  const result = await executeSecureCommand(async () => ({
    status: 0,
    signal: null,
    stdout: rawStdout,
    stderr: rawStderr,
  }), {
    backend: "test-backend",
    operation: "load",
    maxOutputBytes: 4096,
  });

  assert.equal(rawStdout.every((value) => value === 0), true);
  assert.equal(rawStderr.every((value) => value === 0), true);
  assert.equal(result.stdout.toString("utf8"), SERIALIZED_CREDENTIAL);
  assert.equal(result.stderr.toString("utf8"), "diagnostic");
  wipeSecureCommandResult(result);
  assert.equal(result.stdout.every((value) => value === 0), true);
  assert.equal(result.stderr.every((value) => value === 0), true);

  const rejectedOutput = Buffer.from(SERIALIZED_CREDENTIAL);
  await assert.rejects(executeSecureCommand(async () => ({
    status: "invalid",
    signal: null,
    stdout: rejectedOutput,
    stderr: Buffer.alloc(0),
  }), {
    backend: "test-backend",
    operation: "load",
  }), (error) => {
    assert.equal(error.reason, "invalid_response");
    return redactedError("test-backend", "load")(error);
  });
  assert.equal(rejectedOutput.every((value) => value === 0), true);
});

test("secure command timeout is bounded when a descendant inherits its stdio", async () => {
  const testDirectory = await fileSystem.mkdtemp(join(tmpdir(), "memorax-code-command-timeout-"));
  const pidPath = join(testDirectory, "descendant.pid");
  const startedAt = process.hrtime.bigint();
  try {
    await assert.rejects(runSecureCommand({
      backend: "test-backend",
      operation: "save",
      command: process.execPath,
      args: ["-e", inheritedStdioDescendantScript(false), pidPath],
      input: SERIALIZED_CREDENTIAL,
      env: {},
      timeoutMs: 300,
      maxOutputBytes: 64,
    }), (error) => {
      assert.equal(error.reason, "command_timeout");
      return redactedError("test-backend", "save")(error);
    });
    assert.ok(
      elapsedMilliseconds(startedAt) < 3_000,
      "timeout rejection waited for the inherited stdio descendant",
    );
  } finally {
    await terminateProcessFromPidFile(pidPath);
    await fileSystem.rm(testDirectory, { recursive: true, force: true });
  }
});

test("secure command output limit is bounded when a descendant inherits its stdio", async () => {
  const testDirectory = await fileSystem.mkdtemp(join(tmpdir(), "memorax-code-command-output-"));
  const pidPath = join(testDirectory, "descendant.pid");
  const startedAt = process.hrtime.bigint();
  try {
    await assert.rejects(runSecureCommand({
      backend: "test-backend",
      operation: "load",
      command: process.execPath,
      args: ["-e", inheritedStdioDescendantScript(true), pidPath],
      input: SERIALIZED_CREDENTIAL,
      env: {},
      timeoutMs: 5_000,
      maxOutputBytes: 64,
    }), (error) => {
      assert.equal(error.reason, "output_limit");
      return redactedError("test-backend", "load")(error);
    });
    assert.ok(
      elapsedMilliseconds(startedAt) < 3_000,
      "output-limit rejection waited for the inherited stdio descendant",
    );
  } finally {
    await terminateProcessFromPidFile(pidPath);
    await fileSystem.rm(testDirectory, { recursive: true, force: true });
  }
});

test("platform backends reject records larger than 4096 bytes without invoking commands", async () => {
  let invoked = false;
  const backend = createLinuxSecretServiceBackend({
    namespace: NAMESPACE,
    runner: async () => {
      invoked = true;
      return commandResult();
    },
    environment: {},
  });
  await assert.rejects(backend.save("x".repeat(4097)), (error) => {
    assert.equal(error.reason, "secret_too_large");
    return redactedError("linux-secret-service", "save")(error);
  });
  assert.equal(invoked, false);
});

function commandResult({ status = 0, stdout = Buffer.alloc(0), stderr = Buffer.alloc(0) } = {}) {
  return {
    status,
    signal: null,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
  };
}

function capturedCall(specification) {
  return {
    command: specification.command,
    args: [...specification.args],
    env: { ...specification.env },
    input: Buffer.from(specification.input ?? Buffer.alloc(0)),
  };
}

function windowsCredentialPath(localAppData, namespace) {
  return join(
    localAppData,
    "MemoraX Code",
    "credentials",
    namespace,
    "trial-credentials.v1.dpapi",
  );
}

function directoryStatus() {
  return {
    isDirectory: () => true,
    isFile: () => false,
    isSymbolicLink: () => false,
  };
}

function regularFileStatus() {
  return {
    isDirectory: () => false,
    isFile: () => true,
    isSymbolicLink: () => false,
  };
}

function inheritedStdioDescendantScript(exceedOutputLimit) {
  return `
    const { spawn } = require("node:child_process");
    const { writeFileSync } = require("node:fs");
    const descendant = spawn(
      process.execPath,
      ["-e", "setTimeout(() => {}, 6000)"],
      { stdio: "inherit" },
    );
    writeFileSync(process.argv[1], String(descendant.pid));
    ${exceedOutputLimit ? "process.stdout.write('x'.repeat(128));" : ""}
    setTimeout(() => {}, 6000);
  `;
}

function elapsedMilliseconds(startedAt) {
  return Number(process.hrtime.bigint() - startedAt) / 1_000_000;
}

async function terminateProcessFromPidFile(pidPath) {
  let pid;
  try {
    pid = Number.parseInt(await fileSystem.readFile(pidPath, "utf8"), 10);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function assertPublicInvocationContainsNoSecret(call) {
  const publicInvocation = JSON.stringify({
    command: call.command,
    args: call.args,
    env: call.env,
  });
  assert.equal(publicInvocation.includes(API_KEY), false);
  assert.equal(publicInvocation.includes(PLUGIN_MARK), false);
  assert.equal(publicInvocation.includes(SERIALIZED_CREDENTIAL), false);
}

function credentialDigest(value) {
  return createHash("sha256").update(value ?? "").digest("hex");
}

function redactedError(backend, operation) {
  return (error) => {
    assert.ok(error instanceof SecureCredentialBackendError);
    assert.equal(error.code, "TRIAL_CREDENTIAL_BACKEND_ERROR");
    assert.equal(error.backend, backend);
    assert.equal(error.operation, operation);
    const publicError = `${error.name} ${error.message} ${error.stack ?? ""}`;
    assert.equal(publicError.includes(API_KEY), false);
    assert.equal(publicError.includes(PLUGIN_MARK), false);
    assert.equal(publicError.includes(SERIALIZED_CREDENTIAL), false);
    return true;
  };
}
