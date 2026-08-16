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

const BACKEND = "macos-keychain";
const OSASCRIPT = "/usr/bin/osascript";
const KEYCHAIN_SERVICE = "net.memorax.memorax-code.trial";
const ITEM_NOT_FOUND_EXIT = 44;
const INVALID_SECRET_EXIT = 65;
const MACOS_ENVIRONMENT_NAMES = Object.freeze([
  "HOME",
  "LANG",
  "LC_ALL",
  "LOGNAME",
  "TMPDIR",
  "USER",
]);

const JXA_PREFIX = String.raw`
ObjC.import("Foundation");
ObjC.import("Security");
ObjC.bindFunction("exit", ["void", ["int"]]);
const errSecItemNotFound = -25300;
const errSecDuplicateItem = -25299;
const maxSecretBytes = 4096;
function quit(code) { $.exit(code); }
function utf8Length(value) {
  return Number(value.lengthOfBytesUsingEncoding($.NSUTF8StringEncoding));
}
function itemIdentity(argv) {
  if (!argv || argv.length !== 2) quit(70);
  const service = $(argv[0]);
  const account = $(argv[1]);
  if (utf8Length(service) < 1 || utf8Length(account) < 1) quit(70);
  return { service, account };
}
function findItem(identity, passwordLength, passwordData, item) {
  return $.SecKeychainFindGenericPassword(
    $.nil,
    utf8Length(identity.service),
    identity.service.UTF8String,
    utf8Length(identity.account),
    identity.account.UTF8String,
    passwordLength,
    passwordData,
    item
  );
}
`;

const LOAD_SCRIPT = `${JXA_PREFIX}
function run(argv) {
  const identity = itemIdentity(argv);
  const passwordLength = Ref();
  const passwordData = Ref();
  const item = Ref();
  const code = findItem(identity, passwordLength, passwordData, item);
  if (code === errSecItemNotFound) quit(${ITEM_NOT_FOUND_EXIT});
  if (code !== 0) quit(70);
  let invalidSecret = false;
  try {
    const length = Number(passwordLength[0]);
    if (length < 1 || length > maxSecretBytes) {
      invalidSecret = true;
    } else {
      const secret = $.NSData.alloc.initWithBytesLength(passwordData[0], length);
      $.NSFileHandle.fileHandleWithStandardOutput.writeData(secret);
    }
  } finally {
    $.SecKeychainItemFreeContent($.nil, passwordData[0]);
  }
  if (invalidSecret) quit(${INVALID_SECRET_EXIT});
}
`;

const SAVE_SCRIPT = `${JXA_PREFIX}
function run(argv) {
  const identity = itemIdentity(argv);
  const secret = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  const length = Number(secret.length);
  if (length < 1 || length > maxSecretBytes) quit(${INVALID_SECRET_EXIT});
  const item = Ref();
  let code = findItem(identity, null, null, item);
  if (code === 0) {
    code = $.SecKeychainItemModifyAttributesAndData(
      item[0],
      $.nil,
      length,
      secret.bytes
    );
  } else if (code === errSecItemNotFound) {
    code = $.SecKeychainAddGenericPassword(
      $.nil,
      utf8Length(identity.service),
      identity.service.UTF8String,
      utf8Length(identity.account),
      identity.account.UTF8String,
      length,
      secret.bytes,
      item
    );
    if (code === errSecDuplicateItem) {
      code = findItem(identity, null, null, item);
      if (code === 0) {
        code = $.SecKeychainItemModifyAttributesAndData(
          item[0],
          $.nil,
          length,
          secret.bytes
        );
      }
    }
  }
  if (code !== 0) quit(70);
}
`;

const DELETE_SCRIPT = `${JXA_PREFIX}
function run(argv) {
  const identity = itemIdentity(argv);
  const item = Ref();
  const found = findItem(identity, null, null, item);
  if (found === errSecItemNotFound) quit(${ITEM_NOT_FOUND_EXIT});
  if (found !== 0) quit(70);
  const deleted = $.SecKeychainItemDelete(item[0]);
  if (deleted !== 0) quit(70);
}
`;

export function createMacosKeychainBackend(options) {
  const namespace = validateSecureCredentialNamespace(options?.namespace, BACKEND);
  const runner = options?.runner ?? runSecureCommand;
  const environment = minimalEnvironment(
    options?.environment ?? process.env,
    MACOS_ENVIRONMENT_NAMES,
  );
  const timeoutMs = options?.timeoutMs ?? DEFAULT_SECURE_COMMAND_TIMEOUT_MS;
  const maxOutputBytes = options?.maxOutputBytes ?? DEFAULT_SECURE_COMMAND_OUTPUT_BYTES;
  const account = `credential-v1:${namespace}`;

  async function invoke(operation, script, input = undefined) {
    return executeSecureCommand(runner, {
      backend: BACKEND,
      operation,
      command: OSASCRIPT,
      args: ["-l", "JavaScript", "-e", script, "--", KEYCHAIN_SERVICE, account],
      input,
      env: environment,
      timeoutMs,
      maxOutputBytes,
    });
  }

  async function load() {
    const result = await invoke("load", LOAD_SCRIPT);
    try {
      if (isEmptyExit(result, ITEM_NOT_FOUND_EXIT)) return null;
      if (result.status === INVALID_SECRET_EXIT) {
        throw secureCredentialBackendError(BACKEND, "load", "invalid_response");
      }
      if (result.status !== 0 || result.signal !== null || result.stderr.length !== 0) {
        throw secureCredentialBackendError(BACKEND, "load", "command_failed");
      }
      return decodeSecureCredential(result.stdout, BACKEND, "load");
    } finally {
      wipeSecureCommandResult(result);
    }
  }

  return Object.freeze({
    load,

    async save(serialized) {
      const input = encodeSecureCredential(serialized, BACKEND, "save");
      try {
        const result = await invoke("save", SAVE_SCRIPT, input);
        try {
          if (result.status !== 0
            || result.signal !== null
            || result.stdout.length !== 0
            || result.stderr.length !== 0) {
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
      const result = await invoke("delete", DELETE_SCRIPT);
      try {
        if (isEmptyExit(result, ITEM_NOT_FOUND_EXIT)) return false;
        if (result.status !== 0
          || result.signal !== null
          || result.stdout.length !== 0
          || result.stderr.length !== 0) {
          throw secureCredentialBackendError(BACKEND, "delete", "command_failed");
        }
      } finally {
        wipeSecureCommandResult(result);
      }
      return true;
    },
  });
}

function isEmptyExit(result, status) {
  return result.status === status
    && result.signal === null
    && result.stdout.length === 0
    && result.stderr.length === 0;
}
