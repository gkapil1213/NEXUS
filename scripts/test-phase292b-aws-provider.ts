// Phase 292B AWS Secrets Manager HMAC provider tests.
// All CLI calls are mocked via runAwsOverride — no AWS account required.

import { AwsSecretsManagerHmacKeyProvider } from "../src/core/aws-secrets-manager-hmac-key-provider";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) { passed++; console.log("  PASS: " + label); }
  else { failed++; console.log("  FAIL: " + label + (detail ? " -- " + detail : "")); }
}
function section(s: string): void { console.log("\n--- " + s + " ---"); }

function mockOk(payload: object) {
  return async () => ({ exitCode: 0, stdout: JSON.stringify(payload), stderr: "" });
}
function mockErr(exitCode: number, stderr: string) {
  return async () => ({ exitCode, stdout: "", stderr });
}
async function expectThrowAsync(label: string, fn: () => Promise<unknown>, expectedSubstr: string): Promise<void> {
  let threw = false, msg = "";
  try { await fn(); } catch (e: any) { threw = true; msg = String(e?.message ?? e); }
  check(label, threw && msg.includes(expectedSubstr), `got: ${msg}`);
}

async function main() {
  const keyHex = "ab".repeat(32);
  const validPayload = {
    current: { kid: "prod-2026-11", key_hex: keyHex },
    retired: [{ kid: "prod-2026-09", key_hex: "cd".repeat(32) }],
  };

  section("Happy path");
  const p = await AwsSecretsManagerHmacKeyProvider.load({
    secretId: "test",
    region: "us-east-1",
    runAwsOverride: mockOk(validPayload),
  });
  check("current kid", p.currentKey().kid === "prod-2026-11");
  check("current 32-byte key", p.currentKey().key.length === 32);
  check("keyForKid finds retired", p.keyForKid("prod-2026-09")?.kid === "prod-2026-09");
  check("keyForKid unknown -> undefined", p.keyForKid("nope") === undefined);
  check("verifiableKeys has 2", p.verifiableKeys().length === 2);

  section("Defensive copies");
  p.currentKey().key.fill(0);
  check("mutation does not affect provider", p.currentKey().key.toString("hex") === keyHex);

  section("CLI failures");
  await expectThrowAsync("CLI not found -> aws_cli_not_found", () =>
    AwsSecretsManagerHmacKeyProvider.load({
      secretId: "s", region: "us-east-1",
      runAwsOverride: mockErr(1, "spawn aws ENOENT"),
    }), "aws_cli_not_found");
  await expectThrowAsync("AccessDenied -> fetch_failed", () =>
    AwsSecretsManagerHmacKeyProvider.load({
      secretId: "s", region: "us-east-1",
      runAwsOverride: mockErr(254, "AccessDeniedException"),
    }), "aws_secrets_manager_fetch_failed");

  section("Payload validation");
  await expectThrowAsync("empty SecretString", () =>
    AwsSecretsManagerHmacKeyProvider.load({
      secretId: "s", region: "us-east-1",
      runAwsOverride: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    }), "SecretString is empty");
  await expectThrowAsync("invalid JSON", () =>
    AwsSecretsManagerHmacKeyProvider.load({
      secretId: "s", region: "us-east-1",
      runAwsOverride: async () => ({ exitCode: 0, stdout: "not json", stderr: "" }),
    }), "not valid JSON");
  await expectThrowAsync("missing current", () =>
    AwsSecretsManagerHmacKeyProvider.load({
      secretId: "s", region: "us-east-1",
      runAwsOverride: mockOk({}),
    }), "current must have");
  await expectThrowAsync("bad kid", () =>
    AwsSecretsManagerHmacKeyProvider.load({
      secretId: "s", region: "us-east-1",
      runAwsOverride: mockOk({ current: { kid: "bad/kid", key_hex: keyHex } }),
    }), "invalid_envelope_hmac_kid");
  await expectThrowAsync("bad key_hex", () =>
    AwsSecretsManagerHmacKeyProvider.load({
      secretId: "s", region: "us-east-1",
      runAwsOverride: mockOk({ current: { kid: "k1", key_hex: "not-hex" } }),
    }), "invalid_envelope_hmac_key");
  await expectThrowAsync("retired duplicates current", () =>
    AwsSecretsManagerHmacKeyProvider.load({
      secretId: "s", region: "us-east-1",
      runAwsOverride: mockOk({
        current: { kid: "k1", key_hex: keyHex },
        retired: [{ kid: "k1", key_hex: "cd".repeat(32) }],
      }),
    }), "duplicates");

  console.log(`\nPhase 292B AWS provider: ${failed === 0 ? "PASS" : "FAIL"}`);
  console.log(`Assertions: ${passed + failed}; passed: ${passed}; failures: ${failed}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => { console.error("Unexpected:", e); process.exitCode = 1; });