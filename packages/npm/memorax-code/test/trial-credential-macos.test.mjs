import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";
import {
  createMacosKeychainBackend,
} from "../../../ts/memorax-code-adapter-common/src/credentials/macos-keychain.mjs";
import {
  SecureCredentialBackendError,
} from "../../../ts/memorax-code-adapter-common/src/credentials/secure-command.mjs";

const API_KEY = `sk_${"M".repeat(43)}`;
const PLUGIN_MARK = `mk_${"b".repeat(32)}`;
const SERIALIZED_CREDENTIAL = JSON.stringify({
  version: 1,
  state: "provisioning",
  plugin_mark: PLUGIN_MARK,
  api_key: API_KEY,
});
const NAMESPACE = "test-macos-0123456789abcdef";
const RUN_REAL_KEYCHAIN_TEST = process.platform === "darwin"
  && process.env.MEMORAX_CODE_RUN_REAL_MACOS_KEYCHAIN_TESTS === "1";

test("macOS Keychain passes the credential only through osascript stdin and stdout", async () => {
  const calls = [];
  let stored;
  const runner = async (specification) => {
    calls.push(capture(specification));
    if (specification.operation === "save") {
      stored = Buffer.from(specification.input);
      return commandResult();
    }
    if (specification.operation === "load") {
      return stored === undefined
        ? commandResult({ status: 44 })
        : commandResult({ stdout: stored });
    }
    if (specification.operation === "delete") {
      if (stored === undefined) return commandResult({ status: 44 });
      stored.fill(0);
      stored = undefined;
      return commandResult();
    }
    throw new Error("unexpected Keychain operation");
  };
  const backend = createMacosKeychainBackend({
    namespace: NAMESPACE,
    runner,
    environment: {
      HOME: "/Users/test-user",
      TMPDIR: "/tmp/test-user/",
      MEMORAX_API_KEY: API_KEY,
      PRIVATE_CREDENTIAL: SERIALIZED_CREDENTIAL,
    },
  });

  await backend.save(SERIALIZED_CREDENTIAL);
  assert.equal(await backend.load(), SERIALIZED_CREDENTIAL);
  assert.equal(await backend.delete(), true);
  assert.equal(await backend.load(), null);
  assert.equal(await backend.delete(), false);

  assert.equal(calls[0].command, "/usr/bin/osascript");
  assert.deepEqual(calls[0].args.slice(0, 3), ["-l", "JavaScript", "-e"]);
  assert.deepEqual(calls[0].args.slice(-3), [
    "--",
    "net.memorax.memorax-code.trial",
    `credential-v1:${NAMESPACE}`,
  ]);
  assert.match(calls[0].args[3], /SecKeychainAddGenericPassword/);
  assert.match(calls[0].args[3], /SecKeychainItemModifyAttributesAndData/);
  assert.doesNotMatch(calls[0].args[3], /add-generic-password|find-generic-password/);
  const loadScript = calls.find((call) => call.operation === "load")?.args[3] ?? "";
  assert.match(
    loadScript,
    /try \{[\s\S]*\} finally \{\s*\$\.SecKeychainItemFreeContent\(\$\.nil, passwordData\[0\]\);\s*\}/,
  );
  assert.equal(loadScript.match(/SecKeychainItemFreeContent/g)?.length, 1);
  for (const call of calls) {
    assert.doesNotMatch(call.args[3], /CFRelease\s*\(\s*item\s*\[\s*0\s*\]\s*\)/);
  }
  assert.equal(calls[0].input.toString("utf8"), SERIALIZED_CREDENTIAL);
  for (const call of calls) assertInvocationContainsNoSecret(call);
  assert.deepEqual(Object.keys(calls[0].env).sort(), ["HOME", "TMPDIR"]);
});

test("macOS Keychain maps only an empty not-found result to absence", async () => {
  const absent = createMacosKeychainBackend({
    namespace: NAMESPACE,
    runner: async () => commandResult({ status: 44 }),
    environment: {},
  });
  assert.equal(await absent.load(), null);
  assert.equal(await absent.delete(), false);

  for (const result of [
    commandResult({ status: 44, stderr: "not actually absent" }),
    commandResult({ status: 70, stdout: SERIALIZED_CREDENTIAL }),
    commandResult({ status: 0, stderr: SERIALIZED_CREDENTIAL }),
  ]) {
    const failed = createMacosKeychainBackend({
      namespace: NAMESPACE,
      runner: async () => result,
      environment: {},
    });
    await assert.rejects(failed.load(), redactedError("load"));
  }
});

test("macOS Keychain verifies writes and deletes without leaking failed output", async () => {
  const echoed = createMacosKeychainBackend({
    namespace: NAMESPACE,
    runner: async () => commandResult({ stdout: SERIALIZED_CREDENTIAL }),
    environment: {},
  });
  await assert.rejects(echoed.save(SERIALIZED_CREDENTIAL), redactedError("save"));

  let operation;
  const notDeleted = createMacosKeychainBackend({
    namespace: NAMESPACE,
    runner: async (specification) => {
      operation = specification.operation;
      if (operation === "delete") return commandResult();
      return commandResult({ stdout: SERIALIZED_CREDENTIAL });
    },
    environment: {},
  });
  await assert.rejects(notDeleted.delete(), (error) => {
    assert.equal(operation, "load");
    assert.equal(error.reason, "storage_failed");
    return redactedError("delete")(error);
  });

  for (const outerOperation of ["save", "delete"]) {
    const failedVerification = createMacosKeychainBackend({
      namespace: NAMESPACE,
      runner: async (specification) => specification.operation === "load"
        ? commandResult({ status: 70 })
        : commandResult(),
      environment: {},
    });
    const operation = outerOperation === "save"
      ? failedVerification.save(SERIALIZED_CREDENTIAL)
      : failedVerification.delete();
    await assert.rejects(operation, (error) => {
      assert.equal(error.reason, "command_failed");
      return redactedError(outerOperation)(error);
    });
  }
});

test("macOS Keychain supports a real create-read-update-read-delete lifecycle", {
  skip: !RUN_REAL_KEYCHAIN_TEST,
}, async () => {
  const namespace = `real-macos-${randomBytes(16).toString("hex")}`;
  const backend = createMacosKeychainBackend({ namespace });
  const first = syntheticCredential();
  const updated = syntheticCredential();

  try {
    assert.equal(await backend.load(), null);
    await backend.save(first);
    assertCredentialEqual(await backend.load(), first);
    await backend.save(updated);
    assertCredentialEqual(await backend.load(), updated);
    assert.equal(await backend.delete(), true);
    assert.equal(await backend.load(), null);
  } finally {
    await backend.delete();
  }
});

function commandResult({ status = 0, stdout = Buffer.alloc(0), stderr = Buffer.alloc(0) } = {}) {
  return {
    status,
    signal: null,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
  };
}

function capture(specification) {
  return {
    operation: specification.operation,
    command: specification.command,
    args: [...specification.args],
    env: { ...specification.env },
    input: Buffer.from(specification.input ?? Buffer.alloc(0)),
  };
}

function syntheticCredential() {
  return `${JSON.stringify({
    version: 1,
    state: "provisioning",
    plugin_mark: `mk_${randomBytes(16).toString("hex")}`,
    api_key: `sk_${randomBytes(32).toString("base64url")}`,
  })}\n`;
}

function assertCredentialEqual(actual, expected) {
  assert.equal(typeof actual, "string");
  assert.equal(credentialDigest(actual), credentialDigest(expected));
}

function credentialDigest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertInvocationContainsNoSecret(call) {
  const publicInvocation = JSON.stringify({
    command: call.command,
    args: call.args,
    env: call.env,
  });
  assert.equal(publicInvocation.includes(API_KEY), false);
  assert.equal(publicInvocation.includes(PLUGIN_MARK), false);
  assert.equal(publicInvocation.includes(SERIALIZED_CREDENTIAL), false);
}

function redactedError(operation) {
  return (error) => {
    assert.ok(error instanceof SecureCredentialBackendError);
    assert.equal(error.code, "TRIAL_CREDENTIAL_BACKEND_ERROR");
    assert.equal(error.backend, "macos-keychain");
    assert.equal(error.operation, operation);
    const publicError = `${error.name} ${error.message} ${error.stack ?? ""}`;
    assert.equal(publicError.includes(API_KEY), false);
    assert.equal(publicError.includes(PLUGIN_MARK), false);
    assert.equal(publicError.includes(SERIALIZED_CREDENTIAL), false);
    return true;
  };
}
