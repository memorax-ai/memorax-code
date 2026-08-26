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
const MARK_ID = `mk_${"a".repeat(64)}`;

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

test("anonymous quota reminders include the matching local Mark ID without raw counts", async () => {
  let current;
  const transitionState = async (initial, operation) => {
    current ??= initial;
    current = operation(current) ?? current;
    return current;
  };
  const options = {
    env: {},
    transitionState,
    loadTrialCredential: async () => ({
      state: "ready",
      api_key: API_KEY,
      mark_id: MARK_ID,
    }),
  };
  const writeNotice = await claimQuotaNotice(
    accountConfig("zh"),
    { featureCode: "memory_write", remaining: 1, limit: 100 },
    options,
  );
  const searchNotice = await claimQuotaNotice(
    accountConfig("zh"),
    { featureCode: "memory_search", remaining: 10, limit: 100 },
    options,
  );

  assert.match(writeNotice, /^额度提醒：您的 MemoraX Code 记忆写入额度剩余不超过 10%。/);
  assert.match(searchNotice, /^额度提醒：您的 MemoraX Code 记忆搜索额度剩余不超过 10%。/);
  for (const notice of [writeNotice, searchNotice]) {
    assert.match(notice, /游客模式有效期为 90 天。/);
    assert.match(notice, /请访问 https:\/\/platform\.memorax\.net\/ 查看额度、注册或管理账户。/);
    assert.match(notice, new RegExp(MARK_ID));
    assert.doesNotMatch(notice, /memorax-code account --show-mark-id/);
    assert.match(notice, /请妥善保管。/);
    assert.doesNotMatch(notice, /10\/100|试用额度/);
  }
});

test("anonymous quota reminders do not expose a Mark ID from another connection", async () => {
  const otherMarkId = `mk_${"b".repeat(64)}`;
  const notice = await claimQuotaNotice(
    accountConfig("zh"),
    { featureCode: "memory_write", remaining: 10, limit: 100 },
    {
      env: {},
      transitionState: async (initial, operation) => operation(initial) ?? initial,
      loadTrialCredential: async () => ({
        state: "ready",
        api_key: `sk_${"X".repeat(43)}`,
        mark_id: otherMarkId,
      }),
    },
  );

  assert.match(notice, /游客模式有效期为 90 天。/);
  assert.match(notice, /memorax-code account --show-mark-id/);
  assert.doesNotMatch(notice, new RegExp(otherMarkId));
});

test("anonymous quota reminders bound a stalled Mark ID lookup and fall back", async () => {
  const diagnostics = [];
  const startedAt = Date.now();
  const notice = await claimQuotaNotice(
    accountConfig("zh"),
    { featureCode: "memory_search", remaining: 10, limit: 100 },
    {
      env: {},
      timeoutMs: 25,
      transitionState: async (initial, operation) => operation(initial) ?? initial,
      diagnosticLogger: (event) => diagnostics.push(event),
      loadTrialCredential: async ({ runtime }) => {
        assert.ok(runtime.timeoutMs > 0 && runtime.timeoutMs <= 25);
        return await new Promise(() => {});
      },
    },
  );

  assert.ok(Date.now() - startedAt < 1_000);
  assert.match(notice, /memorax-code account --show-mark-id/);
  assert.deepEqual(diagnostics, ["memorax_quota_notice.mark_id_load_failed"]);
});

test("registered-account quota reminders omit anonymous claim guidance", async () => {
  let credentialLoads = 0;
  const options = {
    env: {},
    transitionState: async (initial, operation) => operation(initial) ?? initial,
    loadTrialCredential: async () => {
      credentialLoads += 1;
      return null;
    },
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
  assert.doesNotMatch(zhNotice, /注册|匿名身份|Mark ID|show-mark-id|聊天中分享|90 天|90 days/i);
  assert.match(enNotice, /to view your quota or manage your account\./);
  assert.doesNotMatch(enNotice, /register|anonymous identity|Mark ID|show-mark-id|share it in chat|90 天|90 days/i);
  assert.equal(credentialLoads, 0);
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
    baseUrl: "https://platform.memorax.net",
    apiKey: API_KEY,
    memoryOutputLanguage,
  };
}
