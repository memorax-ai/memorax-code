import { createTrialProvisionClient } from "./trial-provision-client.mjs";
import {
  ensureTrialCredentialReady,
  TrialProvisionFlowError,
  trialProvisionFailureDetails,
} from "./trial-provision-flow.mjs";

export function trialSetupFailureDetails(error) {
  return trialProvisionFailureDetails(error);
}

export async function ensureTrialSetupCredential(options = {}) {
  const env = options.env ?? process.env;
  let credentialApis;
  let credentialPort;
  try {
    credentialApis = options.credentialApis ?? await loadCredentialApis();
    credentialPort = trialCredentialPort(options, credentialApis, env);
  } catch (error) {
    throw new TrialProvisionFlowError("credential_failure", { stage: "credential_load", error });
  }
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
  let record;
  try {
    const credentialApis = options.credentialApis ?? await loadCredentialApis();
    record = await trialCredentialPort(options, credentialApis, env).load();
  } catch (error) {
    throw new TrialProvisionFlowError("credential_failure", { stage: "credential_load", error });
  }
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
