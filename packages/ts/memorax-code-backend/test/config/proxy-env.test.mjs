import assert from "node:assert/strict";
import { test } from "node:test";
import { withLoopbackProxyBypass } from "../../dist/config/proxy-env.js";

test("withLoopbackProxyBypass preserves existing bypasses and adds exact loopback hosts", () => {
  const env = withLoopbackProxyBypass({
    NO_PROXY: "10.0.0.0/8,example.internal",
    no_proxy: "127.0.0.0/8",
    HTTPS_PROXY: "http://127.0.0.1:10808",
  }, "http://127.0.0.1:8787/v1");
  const entries = env.NO_PROXY?.split(",") ?? [];
  assert.equal(env.no_proxy, env.NO_PROXY);
  assert.equal(entries.includes("10.0.0.0/8"), true);
  assert.equal(entries.includes("example.internal"), true);
  assert.equal(entries.includes("127.0.0.0/8"), true);
  assert.equal(entries.includes("127.0.0.1"), true);
  assert.equal(entries.includes("localhost"), true);
  assert.equal(entries.includes("::1"), true);
});
