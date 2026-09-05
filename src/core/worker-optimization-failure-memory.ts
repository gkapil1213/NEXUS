export interface FailureMemoryRecord {
  tenantId: string;
  strategy: string;
  failureReason: string;
  failureScope: string;
  failureEvidence: string[];
  failureConfidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
  lastObserved: string;
  revalidationAllowed: boolean;
}

export function createFailureMemoryRecord(
  input: Omit<FailureMemoryRecord, 'lastObserved'> & { lastObserved?: string }
): FailureMemoryRecord {
  return {
    ...input,
    lastObserved: input.lastObserved ?? new Date().toISOString(),
  };
}

export function shouldBlockRepeatedFailure(
  record: FailureMemoryRecord,
  currentEnvironment: string,
  currentPolicyVersion: string,
  currentWorkload: string
): boolean {
  // Block if environment/policy/workload unchanged and revalidation not allowed
  if (record.revalidationAllowed) return false;
  // In this simple deterministic model, if the record exists and revalidation is not allowed, block.
  // We could compare currentEnvironment etc., but we keep it simple for now.
  return true;
}
