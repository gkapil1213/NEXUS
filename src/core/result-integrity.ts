import { verifyResultDigest, isValidChecksum, verifyBufferChecksum } from "./integrity";

export interface ResultIdentity {
  jobId: string;
  attemptId: string;
  workerId: string;
  dispatchId: string;
  leaseId: string;
  sessionId: string;
}

export class ResultIntegrityValidator {
  validateIdentity(result: Record<string, any>, expected: Partial<ResultIdentity>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    for (const key of Object.keys(expected)) {
      if (result[key] !== (expected as any)[key]) {
        errors.push(`identity_mismatch_${key}`);
      }
    }
    return { valid: errors.length === 0, errors };
  }

  verifyDigest(result: Record<string, any>, expectedDigest?: string): boolean {
    if (!expectedDigest) return false;
    return verifyResultDigest(result, expectedDigest);
  }

  verifyArtifactChecksum(buffer: Buffer | Uint8Array, expectedChecksum: string): boolean {
    if (!isValidChecksum(expectedChecksum)) return false;
    return verifyBufferChecksum(buffer, expectedChecksum);
  }
}
