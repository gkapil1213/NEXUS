import { GovernancePolicy } from './worker-phase32-policy';
import { PolicyCondition, evaluateCondition } from './worker-phase32-policy-condition';

export type EvaluationResult = 'ALLOW' | 'DENY' | 'REQUIRE_APPROVAL' | 'REQUIRE_EXCEPTION' | 'BLOCK' | 'UNKNOWN';

export interface PolicyEvaluation {
  decision: EvaluationResult;
  reason: string;
  policyIds: string[];
  policyVersions: number[];
  controlIds: string[];
  risk: string;
  approvalRequired: boolean;
  exceptionRequired: boolean;
  matchedConditions: string[];
  failedConditions: string[];
  timestamp: string;
  fingerprint: string;
  idempotencyKey: string;
}

export function evaluatePolicy(policy: GovernancePolicy, condition: PolicyCondition, context: Record<string, unknown>): PolicyEvaluation {
  const match = evaluateCondition(condition, context);
  if (policy.status !== 'ACTIVE') return { decision: 'UNKNOWN', reason: `policy ${policy.status}`, policyIds: [policy.policyId], policyVersions: [policy.version], controlIds: [], risk: 'UNKNOWN', approvalRequired: false, exceptionRequired: false, matchedConditions: [], failedConditions: [], timestamp: new Date().toISOString(), fingerprint: `${policy.policyId}:${policy.version}`, idempotencyKey: `${policy.policyId}:${policy.version}` };
  if (!match) return { decision: 'DENY', reason: 'condition not met', policyIds: [policy.policyId], policyVersions: [policy.version], controlIds: policy.controlMappings, risk: 'HIGH', approvalRequired: false, exceptionRequired: false, matchedConditions: [], failedConditions: ['condition'], timestamp: new Date().toISOString(), fingerprint: `${policy.policyId}:${policy.version}`, idempotencyKey: `${policy.policyId}:${policy.version}` };
  return { decision: policy.approvalRequired ? 'REQUIRE_APPROVAL' : 'ALLOW', reason: 'policy satisfied', policyIds: [policy.policyId], policyVersions: [policy.version], controlIds: policy.controlMappings, risk: 'LOW', approvalRequired: policy.approvalRequired, exceptionRequired: false, matchedConditions: ['condition'], failedConditions: [], timestamp: new Date().toISOString(), fingerprint: `${policy.policyId}:${policy.version}`, idempotencyKey: `${policy.policyId}:${policy.version}` };
}
