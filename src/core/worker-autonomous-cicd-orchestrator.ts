import { createPipelineDefinition, validatePipelineDefinition, PipelineDefinition } from './worker-pipeline-definition';
import { createPipelineExecution, transitionPipelineExecution, PipelineExecution } from './worker-pipeline-execution';
import { createStageExecution, transitionStageExecution, StageExecution } from './worker-stage-execution';
import { classifyChange } from './worker-change-detection';
import { createArtifact, verifyArtifactIntegrity } from './worker-artifact';
import { createReleaseCandidate, transitionReleaseCandidate, ReleaseCandidate } from './worker-release-candidate';
import { classifyReleaseRisk } from './worker-release-risk';
import { executeCommand, CommandResult } from './worker-command-executor';
import { createProductionAuditEvent } from './worker-production-audit';
import { createProductionEvidence } from './worker-production-evidence';
import { addProductionLineageNode, ProductionLineage } from './worker-production-lineage';

export interface CICDRequest {
  tenantId: string;
  correlationId: string;
  pipelineDef: Omit<Parameters<typeof createPipelineDefinition>[0], 'correlationId'>;
  repository: string;
  revision: string;
  actor: string;
  trigger: string;
  changedFiles: string[];
  riskInput: Parameters<typeof classifyReleaseRisk>[0];
  governanceDecision: 'ALLOW' | 'DENY' | 'REQUIRE_APPROVAL';
  safetyDecision: 'ALLOW' | 'DENY';
  approvalRequired: boolean;
  approvalGranted: boolean;
  artifactExpectedFingerprint: string;
  deploymentTargetHealthy: boolean;
  idempotencyKey?: string;
}

export async function orchestrateCICD(request: CICDRequest) {
  const auditEvents: ReturnType<typeof createProductionAuditEvent>[] = [];
  const evidence: ReturnType<typeof createProductionEvidence>[] = [];

  // 1. Pipeline definition
  const pipeline = createPipelineDefinition({ ...request.pipelineDef, correlationId: request.correlationId });
  const validation = validatePipelineDefinition(pipeline);
  if (!validation.valid) {
    auditEvents.push(createProductionAuditEvent({ tenantId: request.tenantId, correlationId: request.correlationId, environmentId: 'CI', eventType: 'PIPELINE_VALIDATION_FAILED', reason: validation.reasons.join(', '), decision: 'INVALID' }));
    return { status: 'INVALID', reason: validation.reasons.join(', '), pipeline, auditEvents, evidence };
  }

  // 2. Change classification
  const changeCategory = classifyChange(request.changedFiles);

  // 3. Pipeline execution
  let execution = createPipelineExecution({
    pipelineId: pipeline.pipelineId,
    pipelineVersion: pipeline.version,
    repository: request.repository,
    revision: request.revision,
    actor: request.actor,
    trigger: request.trigger,
    correlationId: request.correlationId,
  });

  execution = transitionPipelineExecution(execution, 'RUNNING');

  // 4. Stage execution (simulate success for required stages; real executor would be injected)
  const stages: StageExecution[] = [];
  for (const stageName of pipeline.stages) {
    let stage = createStageExecution({
      executionId: execution.executionId,
      stageName,
      executor: 'deterministic-test',
      inputFingerprint: `${execution.executionId}:${stageName}`,
      artifactReferences: [],

    });
    stage = transitionStageExecution(stage, 'RUNNING');
    stage = transitionStageExecution(stage, 'SUCCEEDED');
    stages.push(stage);
  }

  // 5. Command execution (not actually connected; returns failure)
  const cmdResult: CommandResult = await executeCommand({ command: 'test', args: [], timeoutMs: 1000 });
  if (!cmdResult.success) {
    execution = transitionPipelineExecution(execution, 'FAILED');
    auditEvents.push(createProductionAuditEvent({ tenantId: request.tenantId, correlationId: request.correlationId, environmentId: 'CI', eventType: 'PIPELINE_FAILED', reason: 'command executor unavailable', decision: 'FAILED' }));
    return { status: 'FAILED', reason: 'command executor unavailable', pipeline, execution, stages, cmdResult, auditEvents, evidence };
  }

  // 6. Artifact creation
  const artifact = createArtifact({
    pipelineExecutionId: execution.executionId,
    sourceRevision: request.revision,
    buildFingerprint: `${request.revision}:build`,
    type: 'application',
    size: 100,
    metadata: {},
    correlationId: request.correlationId,
  });

  const artifactValid = verifyArtifactIntegrity(artifact, request.artifactExpectedFingerprint);
  if (!artifactValid) {
    execution = transitionPipelineExecution(execution, 'FAILED');
    return { status: 'FAILED', reason: 'artifact integrity verification failed', pipeline, execution, stages, artifact, auditEvents, evidence };
  }

  // 7. Risk classification
  const risk = classifyReleaseRisk(request.riskInput);

  // 8. Release candidate
  let rc = createReleaseCandidate({
    artifactId: artifact.artifactId,
    sourceRevision: request.revision,
    pipelineExecutionId: execution.executionId,
    version: 'v1.0.0',
    riskLevel: risk,
    approvalState: request.approvalGranted ? 'APPROVED' : 'PENDING',
    safetyState: request.safetyDecision,
    governanceState: request.governanceDecision === 'ALLOW' ? 'ALLOW' : 'DENY',
    correlationId: request.correlationId,
  });

  // 9. Governance/Safety gates
  if (request.governanceDecision === 'DENY' || request.safetyDecision === 'DENY') {
    rc = transitionReleaseCandidate(rc, 'BLOCKED');
    return { status: 'BLOCKED', reason: 'governance/safety denial', pipeline, execution, stages, artifact, rc, risk, auditEvents, evidence };
  }

  if (request.approvalRequired && !request.approvalGranted) {
    rc = transitionReleaseCandidate(rc, 'BLOCKED');
    return { status: 'BLOCKED', reason: 'approval required', pipeline, execution, stages, artifact, rc, risk, auditEvents, evidence };
  }

  // 10. Promotion
  rc = transitionReleaseCandidate(rc, 'VALIDATED');
  rc = transitionReleaseCandidate(rc, 'APPROVED');
  rc = transitionReleaseCandidate(rc, 'PROMOTING');

  if (!request.deploymentTargetHealthy) {
    rc = transitionReleaseCandidate(rc, 'FAILED');
    return { status: 'FAILED', reason: 'deployment target unhealthy', pipeline, execution, stages, artifact, rc, risk, auditEvents, evidence };
  }

  rc = transitionReleaseCandidate(rc, 'PROMOTED');
  execution = transitionPipelineExecution(execution, 'SUCCEEDED');

  // 11. Evidence and lineage
  evidence.push(createProductionEvidence({ tenantId: request.tenantId, correlationId: request.correlationId, operationId: execution.executionId, evidenceType: 'PIPELINE_SUCCESS', data: { risk, changeCategory } }));
  const lineage: ProductionLineage = { environmentId: 'CI', nodes: [] };
  addProductionLineageNode(lineage, { version: 1, requestId: request.correlationId, releaseId: rc.releaseCandidateId, executionId: execution.executionId, environmentId: 'CI', timestamp: new Date().toISOString() });

  // 12. Audit
  auditEvents.push(createProductionAuditEvent({ tenantId: request.tenantId, correlationId: request.correlationId, environmentId: 'CI', eventType: 'PIPELINE_SUCCEEDED', reason: 'pipeline completed', decision: 'SUCCEEDED' }));

  return { status: 'COMPLETED', pipeline, execution, stages, artifact, rc, risk, changeCategory, cmdResult, auditEvents, evidence, lineage };
}
