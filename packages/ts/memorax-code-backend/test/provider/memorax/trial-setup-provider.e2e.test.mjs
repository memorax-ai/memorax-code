import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ensureTrialSetupCredential } from "../../../../../npm/memorax-code/lib/trial-setup.mjs";
import {
  completeTrialCredentialProvisioning,
  createInitialTrialCredentialRecord,
} from "../../../../memorax-code-adapter-common/src/credentials/trial-credential-record.mjs";
import {
  createTrialCredentialStorePort,
  loadTrialCredentialRecord,
} from "../../../../memorax-code-adapter-common/src/credentials/trial-credential-store.mjs";
import { invokeMemoraxMemoryProvider } from "../../../dist/provider/memorax/adapter.js";
import { createMemoraxConfigResolver } from "../../../dist/provider/memorax/config.js";

const MEMORY_ID = "memory-user";
const REPOSITORY_SLUG = "repo-scope";
const ACCOUNT_ID = "900100000000000001";
const PROJECT_ID = "900100000000000002";

test("trial setup credentials authorize repository-scoped MemoraX writeback", async () => {
  const memoraxCodeHome = await mkdtemp(join(tmpdir(), "memorax-code-trial-e2e-"));
  const secureBackend = memoryCredentialBackend();
  const env = { MEMORAX_CODE_HOME: memoraxCodeHome };
  const provisionPaths = [];

  try {
    const setupResult = await ensureTrialSetupCredential({
      memoraxCodeHome,
      env,
      credentialApis: {
        completeTrialCredentialProvisioning,
        createInitialTrialCredentialRecord,
        createTrialCredentialStorePort,
      },
      credentialStoreOptions: { backend: secureBackend },
      provisionClientOptions: {
        serviceBaseUrl: "https://account.test",
        fetchImpl: async (url, init) => {
          const path = new URL(url).pathname;
          const body = JSON.parse(String(init?.body));
          provisionPaths.push(path);
          if (path.endsWith("/pow-challenge")) {
            return jsonResponse({
              pow_challenge: "v1.dHJpYWw.Y2hhbGxlbmdl",
              difficulty_bits: 0,
              algorithm: "sha256",
              expires_at: "2099-01-01T00:00:00.000Z",
            });
          }
          assert.equal(body.pow_nonce, "0");
          return jsonResponse({
            user_id: ACCOUNT_ID,
            project_id: PROJECT_ID,
            plugin_mark: body.plugin_mark,
            api_key: body.client_api_key,
            key_prefix: body.client_api_key.slice(0, 10),
            created: true,
            api_key_recovered: false,
            warn_remaining_threshold: 5000,
            warn_remaining_step: 1000,
            register_url: "https://platform.memorax.net/register",
          });
        },
      },
    });

    assert.equal(setupResult.status, "ready");
    assert.equal(setupResult.accountId, ACCOUNT_ID);
    assert.equal(setupResult.projectId, PROJECT_ID);
    assert.deepEqual(provisionPaths, [
      "/account/api/v1/trial/pow-challenge",
      "/account/api/v1/trial/provision",
    ]);

    const credential = await loadTrialCredentialRecord({
      memoraxCodeHome,
      env,
      backend: secureBackend,
    });
    assert.equal(credential.state, "ready");
    assert.equal(credential.account_id, ACCOUNT_ID);
    assert.equal(credential.project_id, PROJECT_ID);

    const configPath = join(memoraxCodeHome, "config.toml");
    await writeFile(configPath, [
      "[memorax]",
      'endpoint = "https://platform.memorax.net"',
      `user_id = "${MEMORY_ID}"`,
      "",
      "[memory.add]",
      'output_language = "en"',
      "",
    ].join("\n"), "utf8");
    const configText = await readFile(configPath, "utf8");
    assert.doesNotMatch(configText, /\b(?:api_key|account_id|project_id|plugin_mark)\b/);
    for (const privateValue of [
      credential.api_key,
      credential.account_id,
      credential.project_id,
      credential.plugin_mark,
    ]) {
      assert.equal(configText.includes(privateValue), false);
    }

    const resolveConfig = createMemoraxConfigResolver({
      loadTrialCredential: (options) => loadTrialCredentialRecord({
        ...options,
        backend: secureBackend,
      }),
    });
    const memoryRequests = [];
    const result = await invokeMemoraxMemoryProvider(
      { sessionId: "trial-session", prompt: "remember this" },
      {
        provider_id: "memory.memorax",
        operation: "writeback",
        context: {
          idempotencyKey: "trial-session:turn-1",
          messages: [{ role: "user", content: "Remember this trial preference." }],
        },
      },
      {
        env,
        configResolver: resolveConfig,
        repositoryScope: testRepositoryScope(),
        fetchImpl: async (url, init) => {
          memoryRequests.push({
            url: String(url),
            authorization: init?.headers?.Authorization,
            body: JSON.parse(String(init?.body)),
          });
          return jsonResponse({
            success: true,
            data: { task_id: "trial-add-task", status: "accepted" },
          });
        },
      },
    );

    assert.equal(result.ok, true);
    assert.equal(memoryRequests.length, 1);
    assert.equal(memoryRequests[0].url, "https://platform.memorax.net/v1/memories/add");
    assert.equal(memoryRequests[0].authorization, `Token ${credential.api_key}`);
    assert.equal(memoryRequests[0].body.user_id, `${MEMORY_ID}@${REPOSITORY_SLUG}`);
    assert.equal(memoryRequests[0].body.memory_output_language, "en");
    assert.notEqual(memoryRequests[0].body.user_id, `${ACCOUNT_ID}@${REPOSITORY_SLUG}`);
  } finally {
    await rm(memoraxCodeHome, { recursive: true, force: true });
  }
});

function memoryCredentialBackend() {
  let serialized = null;
  return {
    async load() {
      return serialized;
    },
    async save(value) {
      serialized = value;
    },
    async delete() {
      const deleted = serialized !== null;
      serialized = null;
      return deleted;
    },
  };
}

function testRepositoryScope() {
  return {
    schemaVersion: "workspace-memory-scope.v1",
    baseUserId: MEMORY_ID,
    effectiveUserId: `${MEMORY_ID}@${REPOSITORY_SLUG}`,
    repositoryKey: `test-${REPOSITORY_SLUG}`,
    repositorySlug: REPOSITORY_SLUG,
    repositoryName: REPOSITORY_SLUG,
    identitySource: "origin-remote",
    scopeKind: "git-repository",
    boundWorkspaceRoot: "/test/repository",
  };
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
