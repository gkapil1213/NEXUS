import { randomUUID } from 'crypto';

export type ExperimentMode = 'OBSERVE_ONLY' | 'SHADOW' | 'CANARY' | 'LIMITED' | 'PROGRESSIVE' | 'FULL';
export type ExperimentStatus = 'CREATED' | 'RUNNING' | 'HELD' | 'COMPLETED' | 'ABORTED' | 'EXPIRED';

export interface OptimizationExperiment {
  experimentId: string;
  hypothesisId: string;
  tenantId: string;
  mode: ExperimentMode;
  controlGroup?: string;
  treatmentGroup: string;
  allocationPercent: number;
  startTime: string;
  maximumDurationHours: number;
  minimumSampleSize: number;
  maximumBlastRadius: number;
  abortThresholds: Record<string, number>;
  successThresholds: Record<string, number>;
  status: ExperimentStatus;
  correlationId: string;
  idempotencyKey: string;
  createdAt: string;
}

export function createOptimizationExperiment(
  input: Omit<OptimizationExperiment, 'experimentId' | 'createdAt' | 'status' | 'idempotencyKey'> & { idempotencyKey?: string }
): OptimizationExperiment {
  const idempotencyKey = input.idempotencyKey ?? `${input.hypothesisId}:${input.mode}:${input.allocationPercent}`;
  return {
    experimentId: randomUUID(),
    ...input,
    status: 'CREATED',
    createdAt: new Date().toISOString(),
    idempotencyKey,
  };
}
