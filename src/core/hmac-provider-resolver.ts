// Phase 292B / Phase 293: HMAC key provider selection gate.
//
// Extracted verbatim from kernel.ts so the gate can be unit-tested without
// booting the full kernel. Behavior-preserving: same error codes, same
// fail-closed semantics, same env var handling.
//
// No default key. No fallback. Unknown modes throw. Missing config throws.
// Every branch returns a provider or throws.

import { EnvHmacKeyProvider, EnvelopeHmacKeyProvider } from "./envelope-hmac-key-provider";
import {
  AwsSecretsManagerHmacKeyProvider,
  AwsSecretsManagerHmacKeyProviderOptions,
} from "./aws-secrets-manager-hmac-key-provider";

export interface HmacProviderLoaders {
  awsSecretsManager?: (
    opts: AwsSecretsManagerHmacKeyProviderOptions,
  ) => Promise<AwsSecretsManagerHmacKeyProvider>;
}

export async function resolveHmacProvider(
  env: NodeJS.ProcessEnv,
  loaders: HmacProviderLoaders = {},
): Promise<EnvelopeHmacKeyProvider> {
  const mode = env.NEXUS_ENVELOPE_HMAC_PROVIDER;

  if (mode === "env") {
    return new EnvHmacKeyProvider(env);
  }

  if (mode === "aws-secrets-manager") {
    const secretId = env.NEXUS_ENVELOPE_HMAC_AWS_SECRET_ID;
    const region =
      env.NEXUS_ENVELOPE_HMAC_AWS_REGION ?? env.AWS_REGION;

    if (!secretId) {
      throw new Error(
        "missing_envelope_hmac_aws_secret_id: NEXUS_ENVELOPE_HMAC_AWS_SECRET_ID must be set when NEXUS_ENVELOPE_HMAC_PROVIDER=aws-secrets-manager"
      );
    }
    if (!region) {
      throw new Error(
        "missing_envelope_hmac_aws_region: NEXUS_ENVELOPE_HMAC_AWS_REGION or AWS_REGION must be set when NEXUS_ENVELOPE_HMAC_PROVIDER=aws-secrets-manager"
      );
    }

    const loader =
      loaders.awsSecretsManager ?? AwsSecretsManagerHmacKeyProvider.load;
    return loader({ secretId, region });
  }

  throw new Error(
    "envelope_hmac_provider_not_configured: NEXUS_ENVELOPE_HMAC_PROVIDER must be 'env' or 'aws-secrets-manager'"
  );
}
