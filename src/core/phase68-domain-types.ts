export type ExecutionState =
  | 'CREATED'
  | 'CONTEXT_RESOLVED'
  | 'PLANNED'
  | 'AUTHORIZED'
  | 'RISK_ASSESSED'
  | 'DECIDED'
  | 'APPROVAL_REQUIRED'
  | 'APPROVED'
  | 'EXECUTING'
  | 'VALIDATING'
  | 'EVIDENCE_CAPTURED'
  | 'RELEASE_READY'
  | 'RELEASE_BLOCKED'
  | 'DEPLOYING'
  | 'DEPLOYED'
  | 'VERIFYING'
  | 'HEALTHY'
  | 'DEGRADED'
  | 'RECOVERING'
  | 'ROLLED_BACK'
  | 'COMPLETED'
  | 'FAILED'
  | 'ESCALATED'
  | 'CANCELLED';

export type FinalOutcome =
  | 'SUCCESS'
  | 'PARTIAL_SUCCESS'
  | 'FAILED'
  | 'ROLLED_BACK'
  | 'ROLLBACK_FAILED'
  | 'BLOCKED'
  | 'ESCALATED';

export interface Phase68Execution {
  id: string;
  executionId: string;
  requestId?: string;
  correlationId?: string;
  parentExecutionId?: string;
  environmentId?: string;
  releaseId?: string;
  deploymentId?: string;
  policyDecisionId?: string;
  evidenceId?: string;
  state: ExecutionState;
  finalOutcome?: FinalOutcome;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface Phase68Request {
  executionId?: string;
  requestId?: string;
  correlationId?: string;
  environmentId?: string;
  releaseId?: string;
  deploymentId?: string;
  policyDecisionId?: string;
  requestedAction?: string;
  context?: Record<string, unknown>;
  policyInputs?: Record<string, unknown>;
  riskInputs?: Record<string, unknown>;
  idempotencyKey?: string;
}

export type Phase68Result = {
  executionId: string;
  state: ExecutionState;
  finalOutcome?: FinalOutcome;
  errors: string[];
};
