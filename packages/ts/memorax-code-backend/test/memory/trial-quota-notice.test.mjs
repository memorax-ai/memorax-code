import assert from "node:assert/strict";
import test from "node:test";
import {
  completeTrialCredentialProvisioning,
  createInitialTrialCredentialRecord,
} from "../../../memorax-code-adapter-common/src/credentials/trial-credential-record.mjs";
import {
  claimTrialQuotaNotice,
  createPendingTrialQuotaNoticeRuntime,
} from "../../dist/memory/trial-quota-notice.js";

const API_KEY = `sk_${"Q".repeat(43)}`;
const MARK_ID = `mk_${"a".repeat(64)}`;

test("trial quota notices claim lower levels once and reset after replenishment", async () => {
  let current = readyRecord();
  const transitionCredential = async (operation) => {
    const next = operation(current);
    if (next !== undefined) current = next;
    return current;
  };
  const claim = (remaining) => claimTrialQuotaNotice(
    trialConfig(),
    { featureCode: "memory_write", remaining, limit: 10_000 },
    { env: {}, transitionCredential },
  );

  const first = await claim(9_999);
  assert.match(first, /^Warning: MemoraX Code memory write quota is running low: 9999 of 10000 remaining/i);
  assert.match(first, /https:\/\/platform\.memorax\.net\//);
  assert.match(first, /memorax-code account --show-mark-id/);
  assert.match(first, /do not paste it into chat/i);
  assert.doesNotMatch(first, new RegExp(MARK_ID));
  assert.equal(current.last_warned_write_level, 9_999);
  assert.equal(await claim(9_999), undefined);
  assert.equal(current.last_warned_write_level, 9_999);
  assert.match(await claim(9_998), /9998 of 10000/);
  assert.equal(current.last_warned_write_level, 9_998);
  assert.equal(await claim(10_000), undefined);
  assert.equal(current.last_warned_write_level, null);
  assert.match(await claim(9_999), /9999 of 10000/);
});

test("write and search quota reminders are tracked independently", async () => {
  let current = readyRecord();
  const transitionCredential = async (operation) => {
    const next = operation(current);
    if (next !== undefined) current = next;
    return current;
  };
  const options = { env: {}, transitionCredential };
  assert.match(await claimTrialQuotaNotice(
    trialConfig(),
    { featureCode: "memory_write", remaining: 9_999, limit: 10_000 },
    options,
  ), /memory write quota/i);
  assert.match(await claimTrialQuotaNotice(
    trialConfig(),
    { featureCode: "memory_search", remaining: 9_999, limit: 10_000 },
    options,
  ), /memory search quota/i);
  assert.equal(current.last_warned_write_level, 9_999);
  assert.equal(current.last_warned_search_level, 9_999);
});

test("quota notices follow the configured memory output language", async () => {
  let current = readyRecord();
  const transitionCredential = async (operation) => {
    const next = operation(current);
    if (next !== undefined) current = next;
    return current;
  };
  const options = { env: {}, transitionCredential };
  const writeNotice = await claimTrialQuotaNotice(
    trialConfig("zh"),
    { featureCode: "memory_write", remaining: 9_999, limit: 10_000 },
    options,
  );
  const searchNotice = await claimTrialQuotaNotice(
    trialConfig("zh"),
    { featureCode: "memory_search", remaining: 9_999, limit: 10_000 },
    options,
  );

  assert.match(writeNotice, /^警告：MemoraX Code 记忆写入额度不足：剩余 9999\/10000 次。/);
  assert.match(searchNotice, /^警告：MemoraX Code 记忆搜索额度不足：剩余 9999\/10000 次。/);
  for (const notice of [writeNotice, searchNotice]) {
    assert.match(notice, /请访问 https:\/\/platform\.memorax\.net\/ 注册或管理账户。/);
    assert.match(notice, /请直接在本机终端运行 `memorax-code account --show-mark-id`/);
    assert.match(notice, /不要将其粘贴到聊天中。/);
    assert.doesNotMatch(notice, /quota is running low/i);
  }
});

test("quota exhaustion emits the final zero-level notice", async () => {
  let current = readyRecord();
  const notice = await claimTrialQuotaNotice(
    trialConfig(),
    { featureCode: "memory_search", remaining: 0, limit: 10_000 },
    {
      env: {},
      transitionCredential: async (operation) => {
        current = operation(current) ?? current;
        return current;
      },
    },
  );
  assert.match(notice, /0 of 10000 remaining/);
  assert.equal(current.last_warned_search_level, 0);
});

test("quota notices ignore non-trial credentials and fail open on store errors", async () => {
  let calls = 0;
  assert.equal(await claimTrialQuotaNotice(
    { ...trialConfig(), credentialSource: undefined },
    { featureCode: "memory_search", remaining: 1, limit: 10_000 },
    { transitionCredential: async () => { calls += 1; } },
  ), undefined);
  assert.equal(calls, 0);

  const diagnostics = [];
  assert.equal(await claimTrialQuotaNotice(
    trialConfig(),
    { featureCode: "memory_search", remaining: 1, limit: 10_000 },
    {
      env: {},
      diagnosticLogger: (event) => diagnostics.push(event),
      transitionCredential: async () => { throw new Error("store unavailable"); },
    },
  ), undefined);
  assert.deepEqual(diagnostics, ["memorax_quota_notice.update_failed"]);
});

test("pending write quota notices keep the lowest snapshot and are claimed once", async () => {
  const claimed = [];
  const runtime = createPendingTrialQuotaNoticeRuntime({
    claimQuotaNotice: async (_config, quota) => {
      claimed.push(quota);
      return `Quota notice: ${quota.remaining} remaining.`;
    },
  });
  try {
    runtime.queue({ featureCode: "memory_write", remaining: 9_999, limit: 10_000 });
    runtime.queue({ featureCode: "memory_write", remaining: 10_000, limit: 10_000 });
    runtime.queue({ featureCode: "memory_search", remaining: 1, limit: 10_000 });
    runtime.queue({ featureCode: "memory_write", remaining: 9_998, limit: 10_000 });

    assert.equal(await runtime.claim(trialConfig()), "Quota notice: 9998 remaining.");
    assert.equal(await runtime.claim(trialConfig()), undefined);
    assert.deepEqual(claimed, [{
      featureCode: "memory_write",
      remaining: 9_998,
      limit: 10_000,
    }]);
  } finally {
    runtime.close();
  }
});

function readyRecord() {
  return completeTrialCredentialProvisioning(createInitialTrialCredentialRecord({
    markId: MARK_ID,
    markVersion: 1,
    appSalt: "memorax-plugin-v1",
    machineId: "550e8400-e29b-41d4-a716-446655440000",
    hostname: "developer-laptop",
    platform: "linux",
    arch: "x86_64",
    macHash: "c".repeat(64),
  }), {
    apiKey: API_KEY,
    accountId: "1",
    projectId: "2",
  });
}

function trialConfig(memoryOutputLanguage = "en") {
  return {
    credentialSource: "trial",
    apiKey: API_KEY,
    memoryOutputLanguage,
  };
}
