import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  claimQuotaNotice,
  createPendingQuotaNoticeRuntime,
} from "../../dist/memory/quota-notice.js";

const API_KEY = `sk_${"Q".repeat(43)}`;

test("quota notices persist percentage levels for every MemoraX connection", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-quota-notice-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const options = { env: { MEMORAX_CODE_HOME: home } };
  const config = accountConfig();
  const quota = (featureCode, remaining) => ({ featureCode, remaining, limit: 10_000 });

  assert.equal(await claimQuotaNotice(config, quota("memory_write", 2_000), options), undefined);
  const concurrent = await Promise.all([
    claimQuotaNotice(config, quota("memory_write", 1_000), options),
    claimQuotaNotice(config, quota("memory_write", 1_000), options),
  ]);
  assert.equal(concurrent.filter(Boolean).length, 1);
  assert.match(concurrent.find(Boolean), /memory write quota has 10% or less remaining/i);
  assert.equal(await claimQuotaNotice(config, quota("memory_write", 999), options), undefined);
  assert.match(await claimQuotaNotice(config, quota("memory_write", 0), options), /quota has been used up/i);

  assert.match(await claimQuotaNotice(config, quota("memory_search", 1_000), options), /memory search quota/i);
  assert.equal(await claimQuotaNotice(config, quota("memory_write", 10_000), options), undefined);
  assert.match(await claimQuotaNotice(config, quota("memory_write", 1_000), options), /10% or less remaining/i);
});

test("preview quota reminders link to the account website without guest guidance at any quota limit", async () => {
  for (const limit of [100, 10_000]) {
    const options = {
      env: {},
      transitionState: async (initial, operation) => operation(initial) ?? initial,
    };
    const zhNotice = await claimQuotaNotice(
      accountConfig("zh"),
      { featureCode: "memory_search", remaining: limit / 10, limit },
      options,
    );
    const enNotice = await claimQuotaNotice(
      accountConfig("en"),
      { featureCode: "memory_write", remaining: 0, limit },
      options,
    );
    assert.match(zhNotice, /记忆搜索额度剩余不超过 10%/);
    assert.ok(zhNotice.includes("请访问 http://preview.memorax.net/ 查看额度或管理账户。"));
    assert.match(enNotice, /memory write quota has been used up/);
    assert.ok(enNotice.includes("Visit http://preview.memorax.net/ to view your quota or manage your account."));
    for (const notice of [zhNotice, enNotice]) {
      assert.doesNotMatch(notice, /游客|匿名|Mark ID|show-mark-id|90 天|90 days|guest|anonymous|platform\.memorax\.net/i);
    }
  }
});

test("quota notices fail open when local reminder state is unavailable", async () => {
  const diagnostics = [];
  assert.equal(await claimQuotaNotice(
    accountConfig(),
    { featureCode: "memory_search", remaining: 1, limit: 100 },
    {
      env: {},
      diagnosticLogger: (event) => diagnostics.push(event),
      transitionState: async () => { throw new Error("store unavailable"); },
    },
  ), undefined);
  assert.deepEqual(diagnostics, ["memorax_quota_notice.update_failed"]);
});

test("pending write quota notices keep the lowest snapshot for the originating connection", async () => {
  const claimed = [];
  const runtime = createPendingQuotaNoticeRuntime({
    claimQuotaNotice: async (_config, quota) => {
      claimed.push(quota);
      return `Quota notice: ${quota.remaining} remaining.`;
    },
  });
  try {
    const config = accountConfig();
    runtime.queue(config, { featureCode: "memory_write", remaining: 20, limit: 100 });
    runtime.queue(config, { featureCode: "memory_search", remaining: 1, limit: 100 });
    runtime.queue(config, { featureCode: "memory_write", remaining: 1_000, limit: 10_000 });

    assert.equal(await runtime.claim(config), "Quota notice: 1000 remaining.");
    assert.equal(await runtime.claim(config), undefined);
    assert.deepEqual(claimed, [{
      featureCode: "memory_write",
      remaining: 1_000,
      limit: 10_000,
    }]);

    runtime.queue(config, { featureCode: "memory_write", remaining: 10, limit: 100 });
    assert.equal(await runtime.claim({ ...config, apiKey: `sk_${"X".repeat(43)}` }), undefined);
    assert.equal(claimed.length, 1);
  } finally {
    runtime.close();
  }
});

function accountConfig(memoryOutputLanguage = "en") {
  return {
    baseUrl: "http://preview.memorax.net",
    apiKey: API_KEY,
    memoryOutputLanguage,
  };
}
