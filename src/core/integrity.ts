import { createHash } from "crypto";

export function sha256Hex(data: string | Buffer | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function canonicalize(value: any): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return JSON.stringify(value.map(canonicalize));
  const sorted: Record<string, any> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = value[key];
  }
  return JSON.stringify(sorted);
}

export function computeResultDigest(result: Record<string, any>): string {
  return sha256Hex(canonicalize(result));
}

export function verifyResultDigest(result: Record<string, any>, expectedDigest: string): boolean {
  const calculated = computeResultDigest(result);
  const a = Buffer.from(calculated);
  const b = Buffer.from(expectedDigest);
  return a.length === b.length && a.equals(b);
}

export function isValidChecksum(checksum: string): boolean {
  return /^[a-f0-9]{64}$/.test(checksum);
}

export const MAX_ARTIFACT_SIZE = 10 * 1024 * 1024; // 10MB
export const MAX_STDOUT_SIZE = 5 * 1024 * 1024;
export const MAX_STDERR_SIZE = 5 * 1024 * 1024;
export const MAX_METADATA_SIZE = 1024 * 1024;

export function validateSize(sizeBytes: number, maxBytes: number): boolean {
  return Number.isFinite(sizeBytes) && sizeBytes >= 0 && sizeBytes <= maxBytes;
}

export function isSafeStorageRef(ref: string): boolean {
  if (!ref || typeof ref !== "string") return false;
  if (ref.includes("..")) return false;
  if (/^([a-zA-Z]:)?[\\/]/.test(ref)) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(ref) && !ref.startsWith("artifact://")) return false;
  return true;
}

export function redactString(secret: string): string {
  return secret ? "***REDACTED***" : secret;
}

export function redactSecrets(obj: Record<string, any>, secretKeys: string[] = ["token", "password", "credential", "secret", "authorization", "privateKey"]): Record<string, any> {
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(obj)) {
    const lower = key.toLowerCase();
    if (secretKeys.some((sk) => lower.includes(sk))) {
      result[key] = "***REDACTED***";
    } else if (value && typeof value === "object") {
      result[key] = redactSecrets(value, secretKeys);
    } else {
      result[key] = value;
    }
  }
  return result;
}

export function verifyBufferChecksum(buffer: Buffer | Uint8Array, expectedChecksum: string): boolean {
  if (!isValidChecksum(expectedChecksum)) return false;
  const actual = sha256Hex(buffer);
  const a = Buffer.from(actual);
  const b = Buffer.from(expectedChecksum);
  return a.length === b.length && a.equals(b);
}
