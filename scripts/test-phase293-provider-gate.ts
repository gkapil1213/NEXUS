// Phase 293b: HMAC provider resolver gate tests.
// Hermetic — no kernel boot, no AWS account, no process spawn.

import { resolveHmacProvider } from "../src/core/hmac-provider-resolver";
import { EnvHmacKeyProvider } from "../src/core/envelope-hmac-key-provider";
import { AwsSecretsManagerHmacKeyProvider } from "../src/core/aws-secrets-manager-hmac-key-provider";

let passed = 0;
let failed = 0;

function check(label: string, cond: boolean, detail?: string): void {
  if (cond) { passed++; console.log("PASS:", label); }
  else { failed++; console.log("FAIL:", label, detail ?? ""); }
}

async function expectThrows(label: string, fn: () => Promise<unknown>, substr: string): Promise<void> {
  try {
    await fn();
    check(label + " (should throw)", false, "did not throw");
  } catch (e: any) {
    const msg = String(e?.message ?? "");
    check(label, msg.includes(substr), `got: ${msg}`);
  }
}

async function main(): Promise<void> {
  console.log("Phase 293b HMAC resolver gate tests\n");

  // --- Fail-closed branches ---
  await expectThrows("unset NEXUS_ENVELOPE_HMAC_PROVIDER",
    () => resolveHmacProvider({}),
    "envelope_hmac_provider_not_configured");

  await expectThrows("unknown NEXUS_ENVELOPE_HMAC_PROVIDER",
    () => resolveHmacProvider({ NEXUS_ENVELOPE_HMAC_PROVIDER: "unknown-mode" }),
    "envelope_hmac_provider_not_configured");

  await expectThrows("env mode without KID",
    () => resolveHmacProvider({ NEXUS_ENVELOPE_HMAC_PROVIDER: "env" }),
    "missing_envelope_hmac_kid");

  await expectThrows("env mode without KEY_HEX",
    () => resolveHmacProvider({
      NEXUS_ENVELOPE_HMAC_PROVIDER: "env",
      NEXUS_ENVELOPE_HMAC_KID: "test-k1",
    }),
    "missing_envelope_hmac_key");

  await expectThrows("aws-secrets-manager without SECRET_ID",
    () => resolveHmacProvider({ NEXUS_ENVELOPE_HMAC_PROVIDER: "aws-secrets-manager" }),
    "missing_envelope_hmac_aws_secret_id");

  await expectThrows("aws-secrets-manager without region",
    () => resolveHmacProvider({
      NEXUS_ENVELOPE_HMAC_PROVIDER: "aws-secrets-manager",
      NEXUS_ENVELOPE_HMAC_AWS_SECRET_ID: "arn:test",
    }),
    "missing_envelope_hmac_aws_region");

  // --- Success branches ---
  const keyHex = "ab".repeat(32);

  const envProvider = await resolveHmacProvider({
    NEXUS_ENVELOPE_HMAC_PROVIDER: "env",
    NEXUS_ENVELOPE_HMAC_KID: "test-k1",
    NEXUS_ENVELOPE_HMAC_KEY_HEX: keyHex,
  });
  check("env mode returns EnvHmacKeyProvider",
    envProvider instanceof EnvHmacKeyProvider);
  check("env mode has correct kid",
    envProvider.currentKey().kid === "test-k1");
  check("env mode has 32-byte key",
    envProvider.currentKey().key.length === 32);

  // --- AWS branch with mocked loader ---
  let loaderCalledWith: { secretId: string; region: string } | null = null;
  const awsProvider = await resolveHmacProvider(
    {
      NEXUS_ENVELOPE_HMAC_PROVIDER: "aws-secrets-manager",
      NEXUS_ENVELOPE_HMAC_AWS_SECRET_ID: "arn:test-secret",
      AWS_REGION: "us-east-1",
    },
    {
      awsSecretsManager: async (opts) => {
        loaderCalledWith = opts;
        // Return a real AWS provider built via the mocked CLI
        return AwsSecretsManagerHmacKeyProvider.load({
          ...opts,
          runAwsOverride: async () => ({
            exitCode: 0,
            stdout: JSON.stringify({
              current: { kid: "aws-test-kid", key_hex: "cd".repeat(32) },
              retired: [],
            }),
            stderr: "",
          }),
        });
      },
    },
  );

  check("aws-secrets-manager returns AWS provider",
    awsProvider instanceof AwsSecretsManagerHmacKeyProvider);
  check("aws-secrets-manager has correct kid",
    awsProvider.currentKey().kid === "aws-test-kid");
  check("loader called with secretId + region",
    loaderCalledWith !== null &&
    (loaderCalledWith as any).secretId === "arn:test-secret" &&
    (loaderCalledWith as any).region === "us-east-1");

  // --- AWS loader failure propagates ---
  await expectThrows("AWS loader failure propagates",
    () => resolveHmacProvider(
      {
        NEXUS_ENVELOPE_HMAC_PROVIDER: "aws-secrets-manager",
        NEXUS_ENVELOPE_HMAC_AWS_SECRET_ID: "arn:test",
        AWS_REGION: "us-east-1",
      },
      {
        awsSecretsManager: async () => {
          throw new Error("aws_secrets_manager_fetch_failed: simulated");
        },
      },
    ),
    "aws_secrets_manager_fetch_failed");

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => { console.error("FATAL:", e); process.exitCode = 2; });
