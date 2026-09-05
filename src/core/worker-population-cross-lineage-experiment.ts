export interface CrossLineageExperimentRecord {
  experimentId: string;
  populationId: string;
  populationVersion: number;
  parentLineageIds: string[];
  participatingLineageIds: string[];
  sharedTraits: string[];
  successfulTraits: string[];
  failedTraits: string[];
  transferableEvidence: string[];
  incompatibleTraits: string[];
  createdAt: string;
  correlationId: string;
  idempotencyKey: string;
}

export function createCrossLineageExperimentRecord(
  input: Omit<CrossLineageExperimentRecord, 'createdAt' | 'idempotencyKey'> & { idempotencyKey?: string }
): CrossLineageExperimentRecord {
  const idempotencyKey = input.idempotencyKey ?? `${input.populationId}:${input.populationVersion}:${input.experimentId}`;
  return { ...input, createdAt: new Date().toISOString(), idempotencyKey };
}
