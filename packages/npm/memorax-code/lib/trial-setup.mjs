import { createTrialProvisionClient } from "./trial-provision-client.mjs";
import { ensureTrialCredentialReady } from "./trial-provision-flow.mjs";

export async function ensureTrialSetupCredential(options = {}) {
  const env = options.env ?? process.env;
  const credentialApis = options.credentialApis ?? await loadCredentialApis();
  const credentialPort = options.credentialPort
    ?? credentialApis.createTrialCredentialStorePort({
      ...options.credentialStoreOptions,
      memoraxCodeHome: options.memoraxCodeHome,
      env,
    });
  const recordPort = options.recordPort ?? {
    createInitial: credentialApis.createInitialTrialCredentialRecord,
    complete: credentialApis.completeTrialCredentialProvisioning,
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

async function loadCredentialApis() {
  const [recordApi, storeApi] = await Promise.all([
    import("./memorax-code-adapter-common/src/credentials/trial-credential-record.mjs"),
    import("./memorax-code-adapter-common/src/credentials/trial-credential-store.mjs"),
  ]);
  return { ...recordApi, ...storeApi };
}
