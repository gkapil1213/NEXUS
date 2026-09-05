import { randomUUID } from 'crypto';

export interface RecoveryPlan {
  planId: string;
  service: string;
  environment: string;
  strategy: 'BACKUP' | 'RESTORE' | 'FAILOVER' | 'FAILBACK' | 'DRILL';
  rpoSeconds: number;
  rtoSeconds: number;
  backupRequirements: string[];
  restoreStrategy: string;
  failoverStrategy: string;
  failbackStrategy: string;
  dependencies: string[];
  requiredApprovals: number;
  safetyRequirements: string[];
  verificationRequirements: string[];
  fingerprint: string;
  createdAt: string;
  idempotencyKey: string;
}

export function createRecoveryPlan(
  input: Omit<RecoveryPlan, 'planId' | 'createdAt' | 'fingerprint' | 'idempotencyKey'> & { idempotencyKey?: string }
): RecoveryPlan {
  const fingerprint = `${input.service}:${input.environment}:${input.strategy}:${input.rpoSeconds}:${input.rtoSeconds}`;
  const idempotencyKey = input.idempotencyKey ?? fingerprint;
  return { planId: randomUUID(), ...input, fingerprint, createdAt: new Date().toISOString(), idempotencyKey };
}

export function validateRecoveryPlan(plan: RecoveryPlan): { valid: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!plan.service || !plan.environment) reasons.push('missing service/environment');
  if (plan.rpoSeconds < 0 || plan.rtoSeconds < 0) reasons.push('invalid RPO/RTO');
  if (plan.strategy === 'FAILOVER' && !plan.failoverStrategy) reasons.push('missing failover strategy');
  return { valid: reasons.length === 0, reasons };
}

export type WorkerRecoveryPlan = RecoveryPlan;
