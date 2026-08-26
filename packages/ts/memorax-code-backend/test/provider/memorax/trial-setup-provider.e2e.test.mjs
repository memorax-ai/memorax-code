import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ensureTrialSetupCredential,
  loadReadyTrialSetupCredential,
} from "../../../../../npm/memorax-code/lib/trial-setup.mjs";
import {
  createInitialTrialCredentialRecord,
} from "../../../../memorax-code-adapter-common/src/credentials/trial-credential-record.mjs";
import {
  createTrialCredentialStorePort,
  loadTrialCredentialRecord,
} from "../../../../memorax-code-adapter-common/src/credentials/trial-credential-store.mjs";
import { invokeMemoraxMemoryProvider } from "../../../dist/provider/memorax/adapter.js";

const MEMORY_ID = "memory-user";
const REPOSITORY_SLUG = "repo-scope";
const ACCOUNT_ID = "900100000000000001";
const PROJECT_ID = "900100000000000002";
const API_KEY = `sk_${"E".repeat(43)}`;

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
          assert.equal(path, "/account/api/v1/trial/provision");
          assert.equal(body.mark_version, 1);
          assert.equal(body.app_salt, "memorax-plugin-v1");
          assert.equal(typeof body.machine_id, "string");
          assert.equal(Object.hasOwn(body, "client_api_key"), false);
          assert.equal(Object.hasOwn(body, "pow_challenge"), false);
          assert.equal(Object.hasOwn(body, "recover_api_key"), false);
          const machineIdHash = createHash("sha256")
            .update(body.machine_id.trim().toLowerCase(), "utf8")
            .digest("hex");
          const expectedMark = `mk_${createHash("sha256")
            .update([
              body.app_salt,
              machineIdHash,
              body.hostname,
              body.platform,
              body.arch,
              body.mac_hash,
            ].join(""), "utf8")
            .digest("hex")}`;
          assert.equal(body.mark_id, expectedMark);
          return jsonResponse({
            success: true,
            data: {
              account_id: ACCOUNT_ID,
              project_id: PROJECT_ID,
              mark_id: body.mark_id,
              api_key: API_KEY,
              key_prefix: API_KEY.slice(0, 10),
              created: true,
            },
            error: null,
            page: null,
          });
        },
      },
    });

    assert.equal(setupResult.status, "ready");
    assert.equal(setupResult.accountId, ACCOUNT_ID);
    assert.equal(setupResult.projectId, PROJECT_ID);
    assert.equal(setupResult.apiKey, API_KEY);
    assert.deepEqual(provisionPaths, ["/account/api/v1/trial/provision"]);

    const credential = await loadTrialCredentialRecord({
      memoraxCodeHome,
      env,
      backend: secureBackend,
    });
    assert.equal(credential.state, "ready");
    assert.equal(credential.account_id, ACCOUNT_ID);
    assert.equal(credential.project_id, PROJECT_ID);

    const restored = await loadReadyTrialSetupCredential({
      memoraxCodeHome,
      env,
      credentialApis: { createTrialCredentialStorePort },
      credentialStoreOptions: { backend: secureBackend },
    });
    assert.equal(restored.apiKey, API_KEY);
    assert.equal(restored.accountId, ACCOUNT_ID);

    const configPath = join(memoraxCodeHome, "config.toml");
    await writeFile(configPath, [
      "[memorax]",
      'endpoint = "https://platform.memorax.net"',
      `api_key = "${setupResult.apiKey}"`,
      `user_id = "${MEMORY_ID}"`,
      "",
      "[memory.add]",
      'output_language = "en"',
      "",
    ].join("\n"), "utf8");
    const configText = await readFile(configPath, "utf8");
    assert.match(configText, /\bapi_key\b/);
    assert.equal(configText.includes(credential.api_key), true);
    assert.doesNotMatch(configText, /\b(?:account_id|project_id|mark_id)\b/);
    for (const privateValue of [
      credential.account_id,
      credential.project_id,
      credential.mark_id,
    ]) {
      assert.equal(configText.includes(privateValue), false);
    }

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
        repositoryScope: testRepositoryScope(),
        fetchImpl: async (url, init) => {
          memoryRequests.push({
            url: String(url),
            authorization: init?.headers?.Authorization,
            body: JSON.parse(String(init?.body)),
          });
          return jsonResponse({
            success: true,
            data: {
              task_id: "trial-add-task",
              status: "accepted",
            },
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
