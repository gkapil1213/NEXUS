import { evaluateEffectiveness } from './worker-policy-effectiveness';
import { detectDrift } from './worker-policy-drift-detector';
import { randomUUID } from 'crypto';

export type LearningConfidence = 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
export type LearningRisk = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'UNKNOWN';

export interface LearningProposal {
  proposalId: string;
  tenantId: string;
  policyId: string;
  sourceVersion: string;
  proposedVersion: string;
  reason: string;
  evidenceIds: string[];
  confidence: LearningConfidence;
  risk: LearningRisk;
  expectedImpact: string;
  rollbackPlan: string;
  idempotencyKey: string;
  createdAt: string;
}

export interface LearningInput {
  tenantId: string;
  policyId: string;
  currentVersion: string;
  evidence: { correlationId: string }[];
  effectiveness: ReturnType<typeof evaluateEffectiveness>;
  drift: ReturnType<typeof detectDrift>;
  telemetryFresh?: boolean;   // optional, defaults to true
  sampleSize: number;
}

/**
 * Deterministically generate a policy learning proposal.
 * The proposal is NEVER activated here; it must go through governance.
 */
export function generatePolicyLearningProposal(input: LearningInput): LearningProposal | null {
  // If telemetryFresh is not provided, assume fresh (true).
  const isFresh = input.telemetryFresh !== false;

  // No proposal if the policy is healthy and no significant drift.
  if (input.effectiveness === 'EFFECTIVE' && (input.drift === 'NO_DRIFT' || input.drift === 'LOW_DRIFT')) {
    return null;
  }

  // If insufficient data, unknown, or stale telemetry, defer.
  if (input.effectiveness === 'INSUFFICIENT_DATA' || input.drift === 'INSUFFICIENT_DATA' || input.drift === 'UNKNOWN' || !isFresh) {
    return null;
  }

  // Determine reason.
  const reason = `Policy ${input.policyId} shows ${input.effectiveness} effectiveness and ${input.drift} drift.`;

  // Calculate confidence based on sample size and drift state.
  let confidence: LearningConfidence = 'UNKNOWN';
  if (input.sampleSize >= 100 && (input.drift === 'HIGH_DRIFT' || input.drift === 'CRITICAL_DRIFT')) {
    confidence = 'HIGH';
  } else if (input.sampleSize >= 30) {
    confidence = 'MEDIUM';
  } else {
    confidence = 'LOW';
  }

  // Calculate risk (simplified deterministic mapping).
  let risk: LearningRisk = 'UNKNOWN';
  if (input.drift === 'CRITICAL_DRIFT') risk = 'HIGH';
  else if (input.drift === 'HIGH_DRIFT') risk = 'MEDIUM';
  else if (input.drift === 'MODERATE_DRIFT') risk = 'LOW';
  else risk = 'UNKNOWN';

  // Generate version increment.
  const nextVersion = incrementVersion(input.currentVersion);

  // Build idempotency key (deterministic from inputs).
  const idempotencyKey = `${input.tenantId}:${input.policyId}:${input.currentVersion}:${reason}`;

  return {
    proposalId: randomUUID(),
    tenantId: input.tenantId,
    policyId: input.policyId,
    sourceVersion: input.currentVersion,
    proposedVersion: nextVersion,
    reason,
    evidenceIds: input.evidence.map(e => e.correlationId),
    confidence,
    risk,
    expectedImpact: 'Improve policy performance by adjusting parameters based on learned evidence.',
    rollbackPlan: `Rollback to version ${input.currentVersion} if verification fails.`,
    idempotencyKey,
    createdAt: new Date().toISOString(),
  };
}

function incrementVersion(version: string): string {
  const match = version.match(/v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) return version + '-1';
  const major = parseInt(match[1] || '0', 10);
  const minor = parseInt(match[2] || '0', 10);
  const patch = parseInt(match[3] || '0', 10);
  return `v${major}.${minor}.${patch + 1}`;
}