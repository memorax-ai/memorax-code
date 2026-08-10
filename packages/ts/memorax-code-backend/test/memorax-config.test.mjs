import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  MEMORY_CLI_DEFAULT_SESSION_ID,
  MEMORAX_DEFAULT_BASE_URL,
  memoryCliSessionId,
  memoryWritebackBufferConfig,
  memoryWritebackEnabled,
  loadMemoraxCodeConfig,
  memoryConfigStatus,
  memoraxAddOptionsFromContext,
  memoraxConfigFromEnv,
  seedMissingMemoraxCodeConfig,
  startupRetrieveTimeoutMs,
} from "../dist/provider/memorax/config.js";
import {
  normalizeMemoraxBaseUrl,
} from "../../memorax-code-adapter-common/src/memorax-defaults.mjs";

test("memory CLI uses its executable name as the default session identity", () => {
  assert.equal(MEMORY_CLI_DEFAULT_SESSION_ID, "memorax-cli");
  assert.equal(memoryCliSessionId([], {}), "memorax-cli");
});

test("MemoraX config resolver uses the platform endpoint by default", () => {
  const result = memoraxConfigFromEnv({
    MEMORAX_CODE_MEMORAX_API_KEY: "secret",
    MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
  }, {});

  assert.equal(MEMORAX_DEFAULT_BASE_URL, "https://platform.memorax.net");
  assert.equal(result.ok, true);
  assert.equal(result.config.baseUrl, "https://platform.memorax.net");
  assert.equal(result.config.memoryOutputLanguage, "zh");
});

test("MemoraX endpoint helper normalizes trailing slashes", () => {
  assert.equal(
    normalizeMemoraxBaseUrl(" https://platform.memorax.net/// "),
    "https://platform.memorax.net",
  );
});

test("MemoraX config resolver reads credentials from config.toml", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-memorax-file-creds-"));
  await writeFile(join(root, "config.toml"), [
    "[memorax]",
    'endpoint = "http://file-memorax.test/"',
    'api_key = "file-secret"',
    'user_id = "file-user"',
  ].join("\n"), "utf8");

  const result = memoraxConfigFromEnv({ MEMORAX_CODE_HOME: root });

  assert.equal(result.ok, true);
  assert.equal(result.config.baseUrl, "http://file-memorax.test");
  assert.equal(result.config.apiKey, "file-secret");
  assert.equal(result.config.userId, "file-user");
});

test("seeded MemoraX Code config exposes high-signal choices without a tuning catalog", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-memorax-default-config-"));
  if (process.platform !== "win32") await chmod(root, 0o755);

  const seeded = await seedMissingMemoraxCodeConfig(root);

  assert.equal(seeded, true);
  if (process.platform !== "win32") {
    assert.equal((await stat(root)).mode & 0o777, 0o700);
    assert.equal((await stat(join(root, "config.toml"))).mode & 0o777, 0o600);
  }
  const config = await readFile(join(root, "config.toml"), "utf8");
  assert.match(config, /\[clients\]\ncodex = true\nclaude = true/);
  assert.match(config, /\[memorax\]/);
  assert.match(config, /# endpoint = "https:\/\/platform\.memorax\.net" # MemoraX service URL\./);
  assert.match(config, /# api_key = "" # MemoraX API key used by the local Backend\./);
  assert.match(config, /# user_id = "" # MemoraX base user ID; requests derive a workspace-scoped namespace\./);
  assert.match(config, /\[memory\.retrieval\]\nenabled = false # Auto-inject retrieved memories into supported client prompts\./);
  assert.match(config, /\[memory\.writeback\]/);
  assert.match(config, /enabled = true # Allow supported client sessions to write memories after replies\./);
  assert.match(config, /\[memory\.add\]\noutput_language = "zh" # Language for newly generated MemoraX memories\./);
  assert.match(config, /interval_turns = 5 # Show the MemoraX Code skill reminder every N native client turns, starting on the first turn\./);
  assert.match(config, /\[memory\.repo_update\]/);
  assert.match(config, /\[trace\.codex\]/);
  assert.match(config, /enabled = true # Enable local Codex session memory trace collection\./);
  assert.match(config, /capture_content = true # Store content in local Codex trace events\./);
  assert.match(config, /\[trace\.claude\]/);
  assert.match(config, /capture_content = true # Store content in local Claude trace events\./);
  assert.doesNotMatch(
    config,
    /\[memory\]\s|provider\s*=|top_k|k_dense|k_sparse|min_score|max_context_chars|max_item_chars|buffer_|chunk_|max_message_chars|timeout_ms|retention_days|max_event_chars|max_file_bytes/,
  );
});

test("MemoraX config resolver centralizes defaults and clamps env values", () => {
  const result = memoraxConfigFromEnv({
    MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test/",
    MEMORAX_CODE_MEMORAX_API_KEY: "secret",
    MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
    MEMORAX_CODE_MEMORAX_TOP_K: "200",
    MEMORAX_CODE_MEMORAX_K_DENSE: "101",
    MEMORAX_CODE_MEMORAX_K_SPARSE: "abc",
    MEMORAX_CODE_MEMORAX_TIMEOUT_MS: "250",
    MEMORAX_CODE_MEMORAX_MAX_CONTEXT_CHARS: "10",
    MEMORAX_CODE_MEMORAX_MAX_ITEM_CHARS: "10",
  });

  assert.equal(result.ok, true);
  assert.equal(result.config.baseUrl, "http://memorax.test");
  assert.equal(result.config.topK, 100);
  assert.equal(result.config.kDense, 100);
  assert.equal(result.config.kSparse, 100);
  assert.equal(result.config.timeoutMs, 1000);
  assert.equal(result.config.maxContextChars, 256);
  assert.equal(result.config.maxItemChars, 64);
});

test("MemoraX Code config loader reads config.toml from the configured MemoraX Code home", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-config-loader-"));
  await writeFile(join(root, "config.toml"), [
    "[clients]",
    "codex = false",
    "claude = true",
    "",
    "[memorax]",
    'endpoint = "http://file-memorax.test/"',
    'user_id = "file-user"',
    'api_key = "file-secret"',
    "timeout_ms = 7000",
    "",
    "[memory.retrieval]",
    "memory_type_order = [\"project_fact\", \"core\"]",
    "",
    "[memory.add]",
    'content_type = "code"',
    'mode = "default"',
    'output_language = "en"',
    "",
    "[memory.skill_reminder]",
    "interval_turns = 3",
  ].join("\n"), "utf8");

  const config = loadMemoraxCodeConfig(root);

  assert.deepEqual(config.clients, { codex: false, claude: true });
  assert.equal(config.memorax?.endpoint, "http://file-memorax.test/");
  assert.equal(config.memorax?.user_id, "file-user");
  assert.equal(config.memorax?.api_key, "file-secret");
  assert.equal(config.memorax?.timeout_ms, 7000);
  assert.deepEqual(config.memory?.add, {
    content_type: "code",
    mode: "default",
    output_language: "en",
  });
  assert.deepEqual(config.memory?.retrieval?.memory_type_order, ["project_fact", "core"]);
  assert.equal(config.memory?.skill_reminder?.interval_turns, 3);
});

test("memory config status merges explicit config fields and env overrides", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-config-status-"));
  await writeFile(join(root, "config.toml"), [
    "[memorax]",
    'endpoint = "http://file-memorax.test/"',
    'user_id = "file-user"',
    'api_key = "file-secret"',
    "timeout_ms = 7000",
    "startup_timeout_ms = 2500",
    "",
    "[memory.retrieval]",
    "enabled = false",
    "top_k = 4",
    "k_dense = 3",
    "k_sparse = 2",
    "min_score = 0.25",
    "max_context_chars = 5000",
    "max_item_chars = 500",
    "render_by_memory_type = false",
    'memory_type_order = ["project_fact", "core"]',
    "",
    "[memory.writeback]",
    "enabled = false",
    "buffer_enabled = false",
    "buffer_max_turns = 3",
    "buffer_max_age_ms = 120000",
    "buffer_max_chars = 90000",
    "max_message_chars = 32000",
    "chunk_enabled = false",
    "chunk_max_chars = 4000",
    "chunk_overlap_ratio = 0.1",
    "",
    "[memory.add]",
    'content_type = "code"',
    'mode = "default"',
    "",
    "[memory.cli]",
    "add_enabled = true",
    "max_memory_chars = 3333",
  ].join("\n"), "utf8");

  const env = {
    MEMORAX_CODE_HOME: root,
    MEMORAX_CODE_MEMORAX_TOP_K: "9",
    MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED: "true",
  };
  const status = await memoryConfigStatus(env);

  assert.equal(status.configured, true);
  assert.equal(status.baseUrl, "http://file-memorax.test");
  assert.equal(status.userId, "file-user");
  assert.equal(status.search.topK, 9);
  assert.equal(status.search.kDense, 3);
  assert.equal(status.search.kSparse, 2);
  assert.equal(status.search.timeoutMs, 7000);
  assert.equal(status.search.startupTimeoutMs, 2500);
  assert.equal(status.search.minScore, 0.25);
  assert.equal(status.search.maxContextChars, 5000);
  assert.equal(status.search.maxItemChars, 500);
  assert.deepEqual(status.search.memoryTypeOrder, ["project_fact", "core"]);
  assert.equal(status.search.renderByMemoryType, false);
  assert.equal(status.search.retrievalEnabled, false);
  assert.equal(status.writeback.writebackEnabled, true);
  assert.equal(status.writeback.writebackBufferEnabled, false);
  assert.deepEqual(status.writeback.writebackBuffer, {
    maxTurns: 3,
    maxAgeMs: 120000,
    maxChars: 90000,
  });
  assert.equal(status.writeback.writebackMaxMessageChars, 32000);
  assert.equal(status.writeback.writebackChunkEnabled, false);
  assert.deepEqual(status.writeback.writebackChunk, {
    maxChars: 4000,
    overlapRatio: 0.1,
  });
  assert.equal(status.cli.addEnabled, true);
  assert.equal(status.cli.maxMemoryChars, 3333);
});

test("explicit memory config supplies writeback and code add defaults", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-config-add-defaults-"));
  await writeFile(join(root, "config.toml"), [
    "[memorax]",
    'user_id = "file-user"',
    'api_key = "secret"',
    "",
    "[memory.writeback]",
    "enabled = true",
    "",
    "[memory.add]",
    'content_type = "code"',
    'mode = "default"',
  ].join("\n"), "utf8");

  const status = await memoryConfigStatus({ MEMORAX_CODE_HOME: root });
  const options = await memoraxAddOptionsFromContext({}, {
    MEMORAX_CODE_HOME: root,
  });

  assert.equal(status.configured, true);
  assert.equal(status.search.enabled, true);
  assert.equal(status.search.retrievalEnabled, false);
  assert.equal(status.writeback.writebackEnabled, true);
  assert.equal(status.cli.addEnabled, true);
  assert.equal(options.ok, true);
  assert.equal(options.options.contentType, "code");
  assert.equal(options.options.mode, "default");
});

test("config without automatic memory fields keeps writeback off and defaults language to zh", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-config-no-automatic-defaults-"));
  await writeFile(join(root, "config.toml"), [
    "[memorax]",
    'user_id = "file-user"',
    'api_key = "secret"',
  ].join("\n"), "utf8");

  const status = await memoryConfigStatus({ MEMORAX_CODE_HOME: root });
  const options = await memoraxAddOptionsFromContext({}, {
    MEMORAX_CODE_HOME: root,
  });

  assert.equal(status.writeback.writebackEnabled, false);
  assert.equal(status.add.outputLanguage, "zh");
  assert.equal(options.ok, true);
  assert.deepEqual(options.options, {});
});

test("memorax add options accepts pre-summarized code mode", async () => {
  const options = await memoraxAddOptionsFromContext({
    contentType: "code",
    mode: "pre_summarized",
  }, {
    MEMORAX_CODE_MEMORAX_API_KEY: "secret",
  });

  assert.equal(options.ok, true);
  assert.equal(options.options.contentType, "code");
  assert.equal(options.options.mode, "pre_summarized");
});

test("memoryConfigStatus reports effective writeback and add settings", async () => {
  const status = await memoryConfigStatus({
    MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test/",
    MEMORAX_CODE_MEMORAX_API_KEY: "secret",
    MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
    MEMORAX_CODE_MEMORAX_TOP_K: "3",
    MEMORAX_CODE_MEMORAX_K_DENSE: "5",
    MEMORAX_CODE_MEMORAX_K_SPARSE: "2",
    MEMORAX_CODE_MEMORAX_TIMEOUT_MS: "9000",
    MEMORAX_CODE_MEMORAX_STARTUP_TIMEOUT_MS: "2000",
    MEMORAX_CODE_MEMORY_RETRIEVAL_ENABLED: "true",
    MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED: "true",
    MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_ENABLED: "false",
    MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_MAX_TURNS: "2",
    MEMORAX_CODE_MEMORY_WRITEBACK_CHUNK_MAX_CHARS: "1234",
    MEMORAX_CODE_MEMORY_WRITEBACK_CHUNK_OVERLAP_RATIO: "0.2",
    MEMORAX_CODE_MEMORY_CLI_ADD_ENABLED: "true",
    MEMORAX_CODE_MEMORY_CLI_SESSION_ID: "manual-session",
    MEMORAX_CODE_MEMORY_CLI_MAX_MEMORY_CHARS: "3000",
    MEMORAX_CODE_MEMORAX_ADD_CONTENT_TYPE: "code",
    MEMORAX_CODE_MEMORAX_ADD_MODE: "default",
    MEMORAX_CODE_MEMORY_OUTPUT_LANGUAGE: "en",
  });

  assert.equal(status.configured, true);
  assert.equal(status.baseUrl, "http://memorax.test");
  assert.equal(status.search.topK, 3);
  assert.equal(status.search.kDense, 5);
  assert.equal(status.search.kSparse, 2);
  assert.equal(status.search.timeoutMs, 9000);
  assert.equal(status.search.startupTimeoutMs, 2000);
  assert.equal(status.search.retrievalEnabled, true);
  assert.equal(status.writeback.globalEnabled, true);
  assert.equal(status.writeback.writebackEnabled, true);
  assert.equal(status.writeback.writebackBufferEnabled, false);
  assert.equal(status.writeback.writebackBuffer.maxTurns, 2);
  assert.equal(status.writeback.writebackChunk.maxChars, 1234);
  assert.equal(status.writeback.writebackChunk.overlapRatio, 0.2);
  assert.equal(status.add.contentType, "code");
  assert.equal(status.add.mode, "default");
  assert.equal(status.add.outputLanguage, "en");
  assert.equal(status.cli.addEnabled, true);
  assert.equal(status.cli.sessionId, "manual-session");
  assert.equal(status.cli.maxMemoryChars, 3000);
});

test("MemoraX config resolves a file language and permits an environment override", () => {
  const fileConfig = {
    memorax: { api_key: "secret", user_id: "user-1" },
    memory: { add: { output_language: "en" } },
  };

  const fromFile = memoraxConfigFromEnv({}, fileConfig);
  assert.equal(fromFile.ok, true);
  assert.equal(fromFile.config.memoryOutputLanguage, "en");

  const fromEnv = memoraxConfigFromEnv({
    MEMORAX_CODE_MEMORY_OUTPUT_LANGUAGE: "zh",
  }, fileConfig);
  assert.equal(fromEnv.ok, true);
  assert.equal(fromEnv.config.memoryOutputLanguage, "zh");
});

test("MemoraX config rejects unsupported memory output languages", () => {
  const fromFile = memoraxConfigFromEnv({}, {
    memorax: { api_key: "secret", user_id: "user-1" },
    memory: { add: { output_language: "fr" } },
  });
  assert.equal(fromFile.ok, false);
  assert.match(fromFile.error, /memory output language must be zh or en/i);

  const fromEnv = memoraxConfigFromEnv({
    MEMORAX_CODE_MEMORAX_API_KEY: "secret",
    MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
    MEMORAX_CODE_MEMORY_OUTPUT_LANGUAGE: "fr",
  });
  assert.equal(fromEnv.ok, false);
  assert.match(fromEnv.error, /memory output language must be zh or en/i);
});

test("writeback helper config preserves positive integer fallback semantics", () => {
  assert.deepEqual(memoryWritebackBufferConfig({
    MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_MAX_TURNS: "0",
    MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_MAX_AGE_MS: "abc",
    MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_MAX_CHARS: "70",
  }), {
    maxTurns: 8,
    maxAgeMs: 600000,
    maxChars: 70,
  });
  assert.equal(startupRetrieveTimeoutMs({ MEMORAX_CODE_MEMORAX_STARTUP_TIMEOUT_MS: "20000" }, 9000), 9000);
  assert.equal(startupRetrieveTimeoutMs({ MEMORAX_CODE_MEMORAX_STARTUP_TIMEOUT_MS: "50" }, 9000), 100);
});

test("writeback helper config treats -1 buffer interval as automatic add disabled", async () => {
  const env = {
    MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test/",
    MEMORAX_CODE_MEMORAX_API_KEY: "secret",
    MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
    MEMORAX_CODE_MEMORAX_WRITEBACK_ENABLED: "true",
    MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED: "true",
    MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_MAX_TURNS: "-1",
  };

  assert.equal(memoryWritebackEnabled(env), false);
  assert.equal(memoryWritebackBufferConfig(env).maxTurns, -1);
  const status = await memoryConfigStatus(env);
  assert.equal(status.writeback.writebackEnabled, false);
  assert.equal(status.writeback.writebackBuffer.maxTurns, -1);
});
