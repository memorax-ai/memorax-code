import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_BACKEND_URL,
  DEFAULT_TIMEOUT_MS,
  backendUrlFromHostPort,
  normalizeHttpUrl,
  resolveBackendConnection,
} from "../src/config.mjs";

test("resolveBackendConnection defaults to the loopback Backend", () => {
  const connection = resolveBackendConnection({}, {});
  assert.equal(connection.backendUrl, DEFAULT_BACKEND_URL);
  assert.equal(connection.token, undefined);
  assert.equal(connection.timeoutMs, DEFAULT_TIMEOUT_MS);
  assert.equal(connection.injectRetrieval, false);
  assert.equal(connection.debug, false);
});

test("resolveBackendConnection prefers config over environment", () => {
  const connection = resolveBackendConnection(
    { backendUrl: "http://127.0.0.1:9999", backendToken: "config-token", timeoutMs: 1234, injectRetrieval: true },
    { MEMORAX_CODE_BACKEND_URL: "http://env.test", MEMORAX_CODE_BACKEND_TOKEN: "env-token" },
  );
  assert.equal(connection.backendUrl, "http://127.0.0.1:9999");
  assert.equal(connection.token, "config-token");
  assert.equal(connection.timeoutMs, 1234);
  assert.equal(connection.injectRetrieval, true);
});

test("resolveBackendConnection reads the environment overrides", () => {
  const connection = resolveBackendConnection({}, {
    MEMORAX_CODE_BACKEND_URL: "http://127.0.0.1:8788",
    MEMORAX_CODE_BACKEND_TOKEN: "env-token",
    MEMORAX_CODE_DSH_HOOK_TIMEOUT_MS: "3210",
    MEMORAX_CODE_DSH_RETRIEVAL_INJECT: "1",
    MEMORAX_CODE_DSH_HOOK_DEBUG: "true",
  });
  assert.equal(connection.backendUrl, "http://127.0.0.1:8788");
  assert.equal(connection.token, "env-token");
  assert.equal(connection.timeoutMs, 3210);
  assert.equal(connection.injectRetrieval, true);
  assert.equal(connection.debug, true);
});

test("resolveBackendConnection builds a URL from host and port environment", () => {
  const connection = resolveBackendConnection({}, {
    MEMORAX_CODE_BACKEND_HOST: "127.0.0.1",
    MEMORAX_CODE_BACKEND_PORT: "9000",
  });
  assert.equal(connection.backendUrl, "http://127.0.0.1:9000");
});

test("environment overrides the bundle defaults for adapter toggles", () => {
  const connection = resolveBackendConnection(
    { timeoutMs: 5000, injectRetrieval: false, debug: false },
    {
      MEMORAX_CODE_DSH_HOOK_TIMEOUT_MS: "9000",
      MEMORAX_CODE_DSH_RETRIEVAL_INJECT: "true",
      MEMORAX_CODE_DSH_HOOK_DEBUG: "1",
    },
  );
  assert.equal(connection.timeoutMs, 9000);
  assert.equal(connection.injectRetrieval, true);
  assert.equal(connection.debug, true);
});

test("normalizeHttpUrl rejects non-http URLs and trims trailing slashes", () => {
  assert.equal(normalizeHttpUrl("http://127.0.0.1:8787/"), "http://127.0.0.1:8787");
  assert.equal(normalizeHttpUrl("file:///tmp/x"), undefined);
  assert.equal(normalizeHttpUrl("not-a-url"), undefined);
  assert.equal(normalizeHttpUrl(""), undefined);
});

test("backendUrlFromHostPort returns undefined without host or port", () => {
  assert.equal(backendUrlFromHostPort({}), undefined);
});
