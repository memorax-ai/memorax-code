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
  assert.match(concurrent.find(Boolean), /memory write quota has approximately 10% remaining/i);
  assert.equal(await claimQuotaNotice(config, quota("memory_write", 999), options), undefined);
  assert.match(await claimQuotaNotice(config, quota("memory_write", 0), options), /quota has been used up/i);

  assert.match(await claimQuotaNotice(config, quota("memory_search", 1_000), options), /memory search quota/i);
  assert.equal(await claimQuotaNotice(config, quota("memory_write", 10_000), options), undefined);
  assert.match(await claimQuotaNotice(config, quota("memory_write", 1_000), options), /approximately 10% remaining/i);
});

test("anonymous quota reminders include localized claim guidance without raw counts", async () => {
  let current;
  const transitionState = async (initial, operation) => {
    current ??= initial;
    current = operation(current) ?? current;
    return current;
  };
  const options = { env: {}, transitionState };
  const writeNotice = await claimQuotaNotice(
    accountConfig("zh"),
    { featureCode: "memory_write", remaining: 10, limit: 100 },
    options,
  );
  const searchNotice = await claimQuotaNotice(
    accountConfig("zh"),
    { featureCode: "memory_search", remaining: 10, limit: 100 },
    options,
  );

  assert.match(writeNotice, /^额度提醒：您的 MemoraX Code 记忆写入额度剩余约 10%。/);
  assert.match(searchNotice, /^额度提醒：您的 MemoraX Code 记忆搜索额度剩余约 10%。/);
  for (const notice of [writeNotice, searchNotice]) {
    assert.match(notice, /请访问 https:\/\/platform\.memorax\.net\/ 查看额度、注册或管理账户。/);
    assert.match(notice, /尚未注册的匿名身份/);
    assert.match(notice, /memorax-code account --show-mark-id/);
    assert.match(notice, /不要在聊天中分享。/);
    assert.doesNotMatch(notice, /10\/100|试用额度/);
  }
});

test("registered-account quota reminders omit anonymous claim guidance", async () => {
  const options = {
    env: {},
    transitionState: async (initial, operation) => operation(initial) ?? initial,
  };
  const zhNotice = await claimQuotaNotice(
    accountConfig("zh"),
    { featureCode: "memory_search", remaining: 1_000, limit: 10_000 },
    options,
  );
  const enNotice = await claimQuotaNotice(
    accountConfig("en"),
    { featureCode: "memory_write", remaining: 1_000, limit: 10_000 },
    options,
  );

  assert.match(zhNotice, /请访问 https:\/\/platform\.memorax\.net\/ 查看额度或管理账户。/);
  assert.doesNotMatch(zhNotice, /注册|匿名身份|Mark ID|show-mark-id|聊天中分享/);
  assert.match(enNotice, /to view your quota or manage your account\./);
  assert.doesNotMatch(enNotice, /register|anonymous identity|Mark ID|show-mark-id|share it in chat/i);
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

test("pending write quota notices keep the lowest percentage snapshot and are claimed once", async () => {
  const claimed = [];
  const runtime = createPendingQuotaNoticeRuntime({
    claimQuotaNotice: async (_config, quota) => {
      claimed.push(quota);
      return `Quota notice: ${quota.remaining} remaining.`;
    },
  });
  try {
    runtime.queue({ featureCode: "memory_write", remaining: 20, limit: 100 });
    runtime.queue({ featureCode: "memory_search", remaining: 1, limit: 100 });
    runtime.queue({ featureCode: "memory_write", remaining: 1_000, limit: 10_000 });

    assert.equal(await runtime.claim(accountConfig()), "Quota notice: 1000 remaining.");
    assert.equal(await runtime.claim(accountConfig()), undefined);
    assert.deepEqual(claimed, [{
      featureCode: "memory_write",
      remaining: 1_000,
      limit: 10_000,
    }]);
  } finally {
    runtime.close();
  }
});

function accountConfig(memoryOutputLanguage = "en") {
  return {
    baseUrl: "https://platform.memorax.net",
    apiKey: API_KEY,
    memoryOutputLanguage,
  };
}
