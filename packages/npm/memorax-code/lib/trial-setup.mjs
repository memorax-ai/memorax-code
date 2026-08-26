import { createTrialProvisionClient } from "./trial-provision-client.mjs";
import { ensureTrialCredentialReady } from "./trial-provision-flow.mjs";

export async function ensureTrialSetupCredential(options = {}) {
  const env = options.env ?? process.env;
  const credentialApis = options.credentialApis ?? await loadCredentialApis();
  const credentialPort = trialCredentialPort(options, credentialApis, env);
  const recordPort = options.recordPort ?? {
    createInitial: credentialApis.createInitialTrialCredentialRecord,
  };
  const client = options.client ?? createTrialProvisionClient({
    ...options.provisionClientOptions,
    env,
  });
  return await ensureTrialCredentialReady({
    ...options.flowOptions,
    credentialPort,
    recordPort,
    client,
  });
}

export async function loadReadyTrialSetupCredential(options = {}) {
  const env = options.env ?? process.env;
  const credentialApis = options.credentialApis ?? await loadCredentialApis();
  const record = await trialCredentialPort(options, credentialApis, env).load();
  if (record?.state !== "ready") return undefined;
  return Object.freeze({
    status: "ready",
    provisioned: false,
    markId: record.mark_id,
    accountId: record.account_id,
    projectId: record.project_id,
    apiKey: record.api_key,
  });
}

function trialCredentialPort(options, credentialApis, env) {
  return options.credentialPort
    ?? credentialApis.createTrialCredentialStorePort({
      ...options.credentialStoreOptions,
      memoraxCodeHome: options.memoraxCodeHome,
      env,
    });
}

async function loadCredentialApis() {
  const [recordApi, storeApi] = await Promise.all([
    import("./memorax-code-adapter-common/src/credentials/trial-credential-record.mjs"),
    import("./memorax-code-adapter-common/src/credentials/trial-credential-store.mjs"),
  ]);
  return { ...recordApi, ...storeApi };
}
