import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_BACKEND_URL,
  DEFAULT_TIMEOUT_MS,
  backendConnectionPath,
  backendTokenPath,
  backendUrlFromHostPort,
  normalizeHttpUrl,
  resolveBackendConnection,
} from "../src/config.mjs";

function tempHome() {
  return mkdtempSync(join(tmpdir(), "memorax-dsh-config-"));
}

function writeAuthority(home, record) {
  mkdirSync(join(home, "runtime", "backend"), { recursive: true });
  writeFileSync(backendConnectionPath(home), JSON.stringify(record), "utf8");
}

function writeToken(home, record) {
  mkdirSync(join(home, "runtime", "backend"), { recursive: true });
  writeFileSync(backendTokenPath(home), JSON.stringify(record), "utf8");
}

test.afterEach?.(() => {});

test("resolveBackendConnection defaults to the loopback Backend", () => {
  const home = tempHome();
  try {
    const connection = resolveBackendConnection({}, { MEMORAX_CODE_HOME: home });
    assert.equal(connection.backendUrl, DEFAULT_BACKEND_URL);
    assert.equal(connection.urlSource, "default");
    assert.equal(connection.token, undefined);
    assert.equal(connection.tokenSource, "none");
    assert.equal(connection.timeoutMs, DEFAULT_TIMEOUT_MS);
    assert.equal(connection.injectRetrieval, false);
    assert.equal(connection.debug, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("resolveBackendConnection prefers config over environment", () => {
  const home = tempHome();
  try {
    const connection = resolveBackendConnection(
      { backendUrl: "http://127.0.0.1:9999", backendToken: "config-token", timeoutMs: 1234, injectRetrieval: true },
      {
        MEMORAX_CODE_HOME: home,
        MEMORAX_CODE_BACKEND_URL: "http://env.test",
        MEMORAX_CODE_BACKEND_TOKEN: "env-token",
      },
    );
    assert.equal(connection.backendUrl, "http://127.0.0.1:9999");
    assert.equal(connection.urlSource, "config");
    assert.equal(connection.token, "config-token");
    assert.equal(connection.tokenSource, "environment");
    assert.equal(connection.timeoutMs, 1234);
    assert.equal(connection.injectRetrieval, true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("resolveBackendConnection reads the environment overrides", () => {
  const home = tempHome();
  try {
    const connection = resolveBackendConnection({}, {
      MEMORAX_CODE_HOME: home,
      MEMORAX_CODE_BACKEND_URL: "http://127.0.0.1:8788",
      MEMORAX_CODE_BACKEND_TOKEN: "env-token",
      MEMORAX_CODE_DSH_HOOK_TIMEOUT_MS: "3210",
      MEMORAX_CODE_DSH_RETRIEVAL_INJECT: "1",
      MEMORAX_CODE_DSH_HOOK_DEBUG: "true",
    });
    assert.equal(connection.backendUrl, "http://127.0.0.1:8788");
    assert.equal(connection.urlSource, "environment");
    assert.equal(connection.token, "env-token");
    assert.equal(connection.timeoutMs, 3210);
    assert.equal(connection.injectRetrieval, true);
    assert.equal(connection.debug, true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("resolveBackendConnection builds a URL from host and port environment", () => {
  const home = tempHome();
  try {
    const connection = resolveBackendConnection({}, {
      MEMORAX_CODE_HOME: home,
      MEMORAX_CODE_BACKEND_HOST: "127.0.0.1",
      MEMORAX_CODE_BACKEND_PORT: "9000",
    });
    assert.equal(connection.backendUrl, "http://127.0.0.1:9000");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("environment overrides the bundle defaults for adapter toggles", () => {
  const home = tempHome();
  try {
    const connection = resolveBackendConnection(
      { timeoutMs: 5000, injectRetrieval: false, debug: false },
      {
        MEMORAX_CODE_HOME: home,
        MEMORAX_CODE_DSH_HOOK_TIMEOUT_MS: "9000",
        MEMORAX_CODE_DSH_RETRIEVAL_INJECT: "true",
        MEMORAX_CODE_DSH_HOOK_DEBUG: "1",
      },
    );
    assert.equal(connection.timeoutMs, 9000);
    assert.equal(connection.injectRetrieval, true);
    assert.equal(connection.debug, true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
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

test("resolveBackendConnection reports invalid explicitly configured URLs", () => {
  const home = tempHome();
  try {
    const warnings = [];
    resolveBackendConnection(
      { backendUrl: "127.0.0.1:8787" },
      { MEMORAX_CODE_HOME: home },
      { onInvalidBackendUrl: (value, source) => warnings.push({ value, source }) },
    );
    assert.deepEqual(warnings, [{ value: "127.0.0.1:8787", source: "config backendUrl" }]);

    const envWarnings = [];
    const connection = resolveBackendConnection(
      {},
      { MEMORAX_CODE_HOME: home, MEMORAX_CODE_BACKEND_URL: "localhost:8787" },
      { onInvalidBackendUrl: (value, source) => envWarnings.push({ value, source }) },
    );
    assert.deepEqual(envWarnings, [{ value: "localhost:8787", source: "MEMORAX_CODE_BACKEND_URL" }]);
    assert.equal(connection.backendUrl, DEFAULT_BACKEND_URL);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("resolveBackendConnection does not warn for valid or absent URLs", () => {
  const home = tempHome();
  try {
    const warnings = [];
    resolveBackendConnection(
      { backendUrl: "http://127.0.0.1:9000" },
      {
        MEMORAX_CODE_HOME: home,
        MEMORAX_CODE_BACKEND_URL: "http://env.test",
      },
      { onInvalidBackendUrl: (value) => warnings.push(value) },
    );
    resolveBackendConnection({}, { MEMORAX_CODE_HOME: home }, {
      onInvalidBackendUrl: (value) => warnings.push(value),
    });
    assert.deepEqual(warnings, []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("resolveBackendConnection resolves the managed authority record", () => {
  const home = tempHome();
  try {
    writeAuthority(home, { version: 1, url: "http://127.0.0.1:9001", tokenPath: backendTokenPath(home) });
    writeToken(home, { version: 1, token: "managed-token", createdAt: "2026-01-01T00:00:00.000Z" });
    const connection = resolveBackendConnection({}, { MEMORAX_CODE_HOME: home });
    assert.equal(connection.backendUrl, "http://127.0.0.1:9001");
    assert.equal(connection.urlSource, "authority");
    assert.equal(connection.token, "managed-token");
    assert.equal(connection.tokenSource, "authority-file");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("an explicit URL wins over the authority record and never receives its token", () => {
  const home = tempHome();
  try {
    writeAuthority(home, { version: 1, url: "http://127.0.0.1:9001", tokenPath: backendTokenPath(home) });
    writeToken(home, { version: 1, token: "managed-token", createdAt: "2026-01-01T00:00:00.000Z" });
    const connection = resolveBackendConnection(
      {},
      { MEMORAX_CODE_HOME: home, MEMORAX_CODE_BACKEND_URL: "http://127.0.0.1:9999" },
    );
    assert.equal(connection.backendUrl, "http://127.0.0.1:9999");
    assert.equal(connection.urlSource, "environment");
    // The persisted managed token must not be sent to a user-supplied URL.
    assert.equal(connection.token, undefined);
    assert.equal(connection.tokenSource, "none");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("an invalid authority record warns and falls back instead of throwing", () => {
  const home = tempHome();
  try {
    for (const record of [
      { version: 2, url: "http://127.0.0.1:9001" },
      { version: 1, url: "http://127.0.0.1:9001", extra: "field" },
      { version: 1, url: "ftp://127.0.0.1:9001" },
      { version: 1, url: "http://user:pass@127.0.0.1:9001" },
      { version: 1, url: "http://127.0.0.1:9001/path" },
      { version: 1, url: "http://127.0.0.1:9001", tokenPath: "/elsewhere/token.json" },
    ]) {
      writeAuthority(home, record);
      const issues = [];
      const connection = resolveBackendConnection({}, { MEMORAX_CODE_HOME: home }, {
        onAuthorityIssue: (reason) => issues.push(reason),
      });
      assert.equal(issues.length, 1, `expected one issue for ${JSON.stringify(record)}`);
      assert.equal(connection.backendUrl, DEFAULT_BACKEND_URL);
      assert.equal(connection.urlSource, "default");
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("an invalid token record warns, yields no token, and keeps the authority URL", () => {
  const home = tempHome();
  try {
    writeAuthority(home, { version: 1, url: "http://127.0.0.1:9001", tokenPath: backendTokenPath(home) });
    for (const record of [
      { version: 2, token: "t", createdAt: "2026-01-01T00:00:00.000Z" },
      { version: 1, token: "t", createdAt: "2026-01-01T00:00:00.000Z", extra: true },
      { version: 1, token: "", createdAt: "2026-01-01T00:00:00.000Z" },
      { version: 1, token: "t", createdAt: "not-a-date" },
    ]) {
      writeToken(home, record);
      const issues = [];
      const connection = resolveBackendConnection({}, { MEMORAX_CODE_HOME: home }, {
        onAuthorityIssue: (reason) => issues.push(reason),
      });
      assert.equal(connection.backendUrl, "http://127.0.0.1:9001");
      assert.equal(connection.token, undefined);
      assert.equal(connection.tokenSource, "none");
      assert.equal(issues.length, 1, `expected one issue for ${JSON.stringify(record)}`);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("an invalid rotatedAt rejects the token record like the canonical reader", () => {
  const home = tempHome();
  try {
    writeAuthority(home, { version: 1, url: "http://127.0.0.1:9001", tokenPath: backendTokenPath(home) });

    // Codex round 8, config.mjs:180 — a present-but-invalid rotatedAt must
    // reject the whole record. Accepting it here would make this mirror trust
    // a token file adapter-common's readBackendTokenRecord refuses.
    writeToken(home, { version: 1, token: "t", createdAt: "2026-01-01T00:00:00.000Z", rotatedAt: "not-a-date" });
    const issues = [];
    const rejected = resolveBackendConnection({}, { MEMORAX_CODE_HOME: home }, {
      onAuthorityIssue: (reason) => issues.push(reason),
    });
    assert.equal(rejected.backendUrl, "http://127.0.0.1:9001");
    assert.equal(rejected.token, undefined);
    assert.equal(rejected.tokenSource, "none");
    assert.equal(issues.length, 1);
    assert.match(issues[0], /rotatedAt/);

    // A well-formed rotatedAt (token rotation happened) keeps the record valid.
    writeToken(home, {
      version: 1,
      token: "rotated",
      createdAt: "2026-01-01T00:00:00.000Z",
      rotatedAt: "2026-02-01T00:00:00.000Z",
    });
    const rotated = resolveBackendConnection({}, { MEMORAX_CODE_HOME: home }, {
      onAuthorityIssue: (reason) => issues.push(reason),
    });
    assert.equal(rotated.backendUrl, "http://127.0.0.1:9001");
    assert.equal(rotated.token, "rotated");
    assert.equal(rotated.tokenSource, "authority-file");
    assert.equal(issues.length, 1, "a valid rotatedAt must not report an issue");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("an environment token overrides the authority token", () => {
  const home = tempHome();
  try {
    writeAuthority(home, { version: 1, url: "http://127.0.0.1:9001", tokenPath: backendTokenPath(home) });
    writeToken(home, { version: 1, token: "managed-token", createdAt: "2026-01-01T00:00:00.000Z" });
    const connection = resolveBackendConnection(
      {},
      { MEMORAX_CODE_HOME: home, MEMORAX_CODE_BACKEND_TOKEN: "env-token" },
    );
    assert.equal(connection.token, "env-token");
    assert.equal(connection.tokenSource, "environment");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("cordis bundle patch timeoutMs matches the adapter default", () => {
  const patchUrl = new URL("../cordis.patch.yml", import.meta.url);
  const patch = readFileSync(patchUrl, "utf8");
  const match = /^\s*timeoutMs:\s*(\d+)\s*$/m.exec(patch);
  assert.ok(match, "cordis.patch.yml must declare a timeoutMs config default");
  assert.equal(Number(match[1]), DEFAULT_TIMEOUT_MS);
});

test("the persisted token follows a configured URL that equals the authority URL", () => {
  const home = tempHome();
  try {
    // Canonical adapter-common semantics: the managed token is attached when
    // the SELECTED url equals the authority url, regardless of which source
    // (config/env/authority) produced it. Gating on the source would drop the
    // token and 401 every request for a user who configured the identical URL.
    writeAuthority(home, { version: 1, url: "http://127.0.0.1:9001", tokenPath: backendTokenPath(home) });
    writeToken(home, { version: 1, token: "managed-token", createdAt: "2026-01-01T00:00:00.000Z" });

    const connection = resolveBackendConnection({ backendUrl: "http://127.0.0.1:9001" }, {
      MEMORAX_CODE_HOME: home,
    });
    assert.equal(connection.backendUrl, "http://127.0.0.1:9001");
    assert.equal(connection.urlSource, "config");
    assert.equal(connection.token, "managed-token");
    assert.equal(connection.tokenSource, "authority-file");

    // A configured URL that is NOT the authority URL still gets no token.
    const other = resolveBackendConnection({ backendUrl: "http://127.0.0.1:9999" }, {
      MEMORAX_CODE_HOME: home,
    });
    assert.equal(other.token, undefined);
    assert.equal(other.tokenSource, "none");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
