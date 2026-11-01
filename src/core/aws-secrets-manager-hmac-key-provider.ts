// EnvelopeHmacKeyProvider backed by AWS Secrets Manager.
//
// The HMAC signing key is stored in a single Secrets Manager secret as JSON:
//   {
//     "current": { "kid": "prod-2026-11", "key_hex": "<64 hex>" },
//     "retired": [
//       { "kid": "prod-2026-09", "key_hex": "<64 hex>" }
//     ]
//   }
//
// The secret is fetched once at construction (load) via
// `aws secretsmanager get-secret-value`. Material is held in memory for the
// process lifetime. No hot reload: rotation requires a kernel restart.
//
// All failure modes are startup-time and fail closed:
//   aws_cli_not_found
//   aws_secrets_manager_fetch_failed
//   invalid_aws_secret_payload
//   (plus the same kid / hex validation errors as EnvHmacKeyProvider)

import { runAws, RunAwsFn } from "./aws-cli";
import {
  EnvelopeHmacKey,
  EnvelopeHmacKeyProvider,
} from "./envelope-hmac-key-provider";

const HMAC_KEY_BYTES = 32;
const HEX_64 = /^[0-9a-fA-F]{64}$/;
const VALID_KID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function validateKid(kid: unknown, source: string): string {
  if (typeof kid !== "string" || !VALID_KID.test(kid)) {
    throw new Error(
      `invalid_envelope_hmac_kid: ${source} must be 1-128 safe ASCII characters`,
    );
  }
  return kid;
}

function decodeHexKey(hex: unknown, source: string): Buffer {
  if (typeof hex !== "string" || !HEX_64.test(hex)) {
    throw new Error(
      `invalid_envelope_hmac_key: ${source} must be 64 hex characters (32 bytes)`,
    );
  }
  const buf = Buffer.from(hex, "hex");
  if (buf.length !== HMAC_KEY_BYTES) {
    throw new Error(
      `invalid_envelope_hmac_key: ${source} decoded to ${buf.length} bytes, expected ${HMAC_KEY_BYTES}`,
    );
  }
  return buf;
}

function copyKey(key: EnvelopeHmacKey): EnvelopeHmacKey {
  return { kid: key.kid, key: Buffer.from(key.key) };
}

export interface AwsSecretsManagerHmacKeyProviderOptions {
  secretId: string;
  region: string;
  runAwsOverride?: RunAwsFn;
}

interface SecretPayload {
  current: { kid: string; key_hex: string };
  retired?: Array<{ kid: string; key_hex: string }>;
}

export class AwsSecretsManagerHmacKeyProvider
  implements EnvelopeHmacKeyProvider
{
  private readonly current: EnvelopeHmacKey;
  private readonly retired: ReadonlyArray<EnvelopeHmacKey>;

  private constructor(
    current: EnvelopeHmacKey,
    retired: ReadonlyArray<EnvelopeHmacKey>,
  ) {
    this.current = current;
    this.retired = retired;
  }

  static async load(
    opts: AwsSecretsManagerHmacKeyProviderOptions,
  ): Promise<AwsSecretsManagerHmacKeyProvider> {
    const runner = opts.runAwsOverride ?? runAws;

    const res = await runner([
      "secretsmanager",
      "get-secret-value",
      "--secret-id",
      opts.secretId,
      "--region",
      opts.region,
      "--query",
      "SecretString",
      "--output",
      "text",
    ]);

    if (res.exitCode !== 0) {
      // Distinguish "spawn failed" (ENOENT from child_process) from
      // "CLI ran but rejected the request". The former means aws isn't on
      // PATH; the latter means the CLI executed but the request failed
      // (e.g., ResourceNotFoundException from a wrong ARN).
      const isSpawnError = res.stdout === "" && /^Error: spawn aws/i.test(res.stderr.trim());
      if (isSpawnError) {
        throw new Error(
          `aws_cli_not_found: aws must be on PATH to fetch ${opts.secretId}`,
        );
      }
      throw new Error(
        `aws_secrets_manager_fetch_failed: ${res.stderr.trim() || `exit ${res.exitCode}`}`,
      );
    }

    const secretString = res.stdout;
    if (!secretString || secretString.trim() === "") {
      throw new Error(
        `invalid_aws_secret_payload: SecretString is empty for ${opts.secretId}`,
      );
    }

    let payload: unknown;
    try {
      payload = JSON.parse(secretString);
    } catch {
      throw new Error(
        `invalid_aws_secret_payload: SecretString is not valid JSON for ${opts.secretId}`,
      );
    }

    if (!payload || typeof payload !== "object") {
      throw new Error(
        `invalid_aws_secret_payload: SecretString must be a JSON object for ${opts.secretId}`,
      );
    }

    const p = payload as SecretPayload;
    if (
      !p.current ||
      typeof p.current !== "object" ||
      typeof (p.current as { kid?: unknown }).kid !== "string" ||
      typeof (p.current as { key_hex?: unknown }).key_hex !== "string"
    ) {
      throw new Error(
        `invalid_aws_secret_payload: current must have string kid and key_hex for ${opts.secretId}`,
      );
    }

    const currentKid = validateKid(
      p.current.kid,
      "current.kid (AWS secret)",
    );
    const current: EnvelopeHmacKey = {
      kid: currentKid,
      key: decodeHexKey(p.current.key_hex, "current.key_hex (AWS secret)"),
    };

    const retired: EnvelopeHmacKey[] = [];
    const seenKids = new Set<string>([currentKid]);
    if (p.retired !== undefined) {
      if (!Array.isArray(p.retired)) {
        throw new Error(
          `invalid_aws_secret_payload: retired must be an array for ${opts.secretId}`,
        );
      }
      for (let i = 0; i < p.retired.length; i++) {
        const entry = p.retired[i];
        if (
          !entry ||
          typeof entry !== "object" ||
          typeof (entry as { kid?: unknown }).kid !== "string" ||
          typeof (entry as { key_hex?: unknown }).key_hex !== "string"
        ) {
          throw new Error(
            `invalid_aws_secret_payload: retired[${i}] must have string kid and key_hex for ${opts.secretId}`,
          );
        }
        const kid = validateKid(
          (entry as { kid: string }).kid,
          `retired[${i}].kid`,
        );
        if (seenKids.has(kid)) {
          throw new Error(
            `invalid_aws_secret_payload: retired[${i}].kid duplicates ${kid} for ${opts.secretId}`,
          );
        }
        seenKids.add(kid);
        retired.push({
          kid,
          key: decodeHexKey(
            (entry as { key_hex: string }).key_hex,
            `retired[${i}].key_hex`,
          ),
        });
      }
    }

    return new AwsSecretsManagerHmacKeyProvider(current, retired);
  }

  currentKey(): EnvelopeHmacKey {
    return copyKey(this.current);
  }

  verifiableKeys(): ReadonlyArray<EnvelopeHmacKey> {
    return [this.current, ...this.retired].map(copyKey);
  }

  keyForKid(kid: string): EnvelopeHmacKey | undefined {
    if (kid === this.current.kid) return copyKey(this.current);
    const found = this.retired.find((k) => k.kid === kid);
    return found ? copyKey(found) : undefined;
  }
}