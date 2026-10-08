// src/core/recovery-handoff-convergence.ts
// Phase 257: durable recovery handoff integrity boundary.
//
// Validates identity, lifecycle, and authorization bindings before delegating
// to the existing requestDriftRecoveryIntent / ReleaseDeploymentIntentService
// pipeline. It does NOT create a second recovery engine, execution path,
// lease system, incident store, or recovery-intent table.

import type { AsyncIncidentStore, SecurityIncident } from "./async-incident-store";
import type { DeploymentHistoryService } from "./deployment-history";
import type { ReleaseDeploymentIntentService, ReleaseIntentInput } from "./release-deployment-intent";
import type { ReleaseDeploymentIntent } from "./execution-store";
import type { Incident } from "./observability-types";
import {
  requestDriftRecoveryIntent,
  type DriftRecoveryProviderContext,
} from "./production-incident-response";
import type { RecoveryAuthorization } from "./recovery-policy-engine";
import { assertDeploymentBinding } from "./deployment-convergence";

export type RecoveryHandoffOutcome =
  | "ACCEPTED"
  | "RECONCILED"
  | "REJECTED"
  | "BLOCKED"
  | "NOT_EXECUTED";

export interface RecoveryHandoffInput {
  incidentStore: AsyncIncidentStore;
  history: DeploymentHistoryService;
  intentService?: ReleaseDeploymentIntentService;
  incidentId: string;
  deploymentId: string;
  expected: {
    release_id: string;
    artifact_id: string;
    artifact_digest: string;
    environment: string;
  };
  providerContext?: DriftRecoveryProviderContext;
  authorization?: RecoveryAuthorization;
  workerId: string;
  now?: number;
}

export interface RecoveryHandoffResult {
  outcome: RecoveryHandoffOutcome;
  reason: string;
  intentKey: string | null;
  lifecycleAfter: string;
  intent?: ReleaseDeploymentIntent;
}

function toIncidentShape(s: SecurityIncident): Incident {
  return {
    id: s.id,
    tenant_id: s.tenant_id,
    environment: s.environment,
    service: s.service,
    severity: s.severity,
    title: s.title,
    description: s.description,
    trigger_alert_id: s.trigger_alert_id,
    status: (s.status as unknown) as Incident["status"],
    created_at: s.created_at,
    updated_at: s.updated_at,
  };
}

function rejected(reason: string, status: string): RecoveryHandoffResult {
  return { outcome: "REJECTED", reason, intentKey: null, lifecycleAfter: status };
}
function blocked(reason: string, status: string): RecoveryHandoffResult {
  return { outcome: "BLOCKED", reason, intentKey: null, lifecycleAfter: status };
}

function intentKeyForRollback(
  input: RecoveryHandoffInput,
  pc: DriftRecoveryProviderContext,
  svc: ReleaseDeploymentIntentService,
): string {
  const intentInput: ReleaseIntentInput = {
    intentKind: "ROLLBACK",
    rollbackTargetReleaseId: null,
    rollbackJobId: null,
    releaseId: input.expected.release_id,
    executionId: pc.executionId,
    attemptId: pc.attemptId,
    artifactId: input.expected.artifact_id,
    artifactDigest: input.expected.artifact_digest,
    commitSha: pc.commitSha,
    environment: input.expected.environment,
    projectId: pc.projectId ?? null,
    imageRepository: pc.imageRepository,
    imageTag: pc.imageTag,
    imageId: pc.imageId,
    imageDigest: pc.imageDigest,
    containerName: pc.containerName,
    containerPort: pc.containerPort,
  };
  return svc.computeKey(intentInput);
}

export async function convergeRecoveryHandoffAsync(
  input: RecoveryHandoffInput,
): Promise<RecoveryHandoffResult> {
  const nowIso = new Date(input.now ?? Date.now()).toISOString();

  // 1. Incident must exist.
  const incident = await input.incidentStore.getIncidentAsync(input.incidentId);
  if (!incident) {
    return rejected("incident not found: " + input.incidentId, "UNKNOWN");
  }
  const lifecycleBefore = incident.status;

  // 2. Deployment identity binding (Phase 256 primitive).
  const binding = assertDeploymentBinding(incident, input.deploymentId);
  if (!binding.ok) {
    await input.incidentStore.appendIncidentTimelineAsync(incident.id, {
      type: "RECOVERY_HANDOFF_REJECTED",
      at: nowIso,
      payload: { reason: binding.reason, deployment_id: input.deploymentId, worker_id: input.workerId },
    }).catch(() => undefined);
    return rejected(binding.reason, lifecycleBefore);
  }

  // 3. Full identity tuple cross-check.
  if (
    incident.release_id !== input.expected.release_id ||
    incident.artifact_id !== input.expected.artifact_id ||
    incident.artifact_digest !== input.expected.artifact_digest ||
    incident.environment !== input.expected.environment
  ) {
    const reason =
      "identity tuple mismatch: incident=" +
      [incident.release_id, incident.artifact_id, incident.artifact_digest, incident.environment].join("/") +
      " expected=" +
      [input.expected.release_id, input.expected.artifact_id, input.expected.artifact_digest, input.expected.environment].join("/");
    await input.incidentStore.appendIncidentTimelineAsync(incident.id, {
      type: "RECOVERY_HANDOFF_REJECTED",
      at: nowIso,
      payload: { reason, worker_id: input.workerId },
    }).catch(() => undefined);
    return rejected(reason, lifecycleBefore);
  }

  // 4. CLOSED incidents never accept a new handoff.
  if (lifecycleBefore === "CLOSED") {
    await input.incidentStore.appendIncidentTimelineAsync(incident.id, {
      type: "RECOVERY_HANDOFF_REJECTED",
      at: nowIso,
      payload: { reason: "incident is CLOSED; recovery handoff not eligible", worker_id: input.workerId },
    }).catch(() => undefined);
    return rejected("incident is CLOSED", lifecycleBefore);
  }

  // 5. Dependency checks (before we compute any intent key).
  if (!input.intentService) {
    return {
      outcome: "NOT_EXECUTED",
      reason: "no ReleaseDeploymentIntentService supplied; recovery handoff not attempted",
      intentKey: null,
      lifecycleAfter: lifecycleBefore,
    };
  }
  if (!input.providerContext) {
    await input.incidentStore.appendIncidentTimelineAsync(incident.id, {
      type: "RECOVERY_HANDOFF_BLOCKED",
      at: nowIso,
      payload: {
        reason: "no provider context; ReleaseIntentInput requires image/container identity",
        worker_id: input.workerId,
      },
    }).catch(() => undefined);
    return blocked("no provider context available for recovery intent", lifecycleBefore);
  }
  if (
    !input.authorization ||
    !input.authorization.authorizedBy ||
    input.authorization.authorizedBy.length === 0
  ) {
    await input.incidentStore.appendIncidentTimelineAsync(incident.id, {
      type: "RECOVERY_HANDOFF_BLOCKED",
      at: nowIso,
      payload: { reason: "no explicit RecoveryAuthorization supplied", worker_id: input.workerId },
    }).catch(() => undefined);
    return blocked("no explicit RecoveryAuthorization supplied", lifecycleBefore);
  }

  // 6. Supersession guard, using the intent service's own key computation.
  //    If the incident is correlated to a *different* intent key, this
  //    handoff refers to a superseded obligation.
  const requestedIntentKey = intentKeyForRollback(input, input.providerContext, input.intentService);
  if (
    incident.recovery_intent_key != null &&
    incident.recovery_intent_key.length > 0 &&
    incident.recovery_intent_key !== requestedIntentKey
  ) {
    const reason =
      "incident correlated to a different intent key: correlated=" +
      incident.recovery_intent_key + " requested=" + requestedIntentKey;
    await input.incidentStore.appendIncidentTimelineAsync(incident.id, {
      type: "RECOVERY_HANDOFF_REJECTED",
      at: nowIso,
      payload: { reason, worker_id: input.workerId },
    }).catch(() => undefined);
    return rejected(reason, lifecycleBefore);
  }

  // 7. Delegate to the existing Phase 250 entry point (same call Phase 253
  //    uses). Durable idempotency and concurrency are provided by
  //    ReleaseDeploymentIntentService.getOrCreate via deterministic key.
  const result = await requestDriftRecoveryIntent({
    intentService: input.intentService,
    incident: toIncidentShape(incident),
    identity: {
      deployment_id: input.deploymentId,
      release_id: input.expected.release_id,
      artifact_id: input.expected.artifact_id,
      artifact_digest: input.expected.artifact_digest,
      environment: input.expected.environment,
    },
    providerContext: input.providerContext,
  });

  if (result.status === "BLOCKED") {
    await input.incidentStore.appendIncidentTimelineAsync(incident.id, {
      type: "RECOVERY_HANDOFF_BLOCKED",
      at: nowIso,
      payload: { reason: result.reason, worker_id: input.workerId },
    }).catch(() => undefined);
    return blocked(result.reason, lifecycleBefore);
  }

  const intentKey = result.intentKey;
  if (!intentKey) {
    return rejected("intent service returned no intentKey", lifecycleBefore);
  }

  // 8. Correlate the incident if this is a new correlation.
  const already = incident.recovery_intent_key === intentKey;
  if (!already) {
    await input.incidentStore.updateIncidentAsync(incident.id, {
      recovery_intent_key: intentKey,
      status: "RECOVERY_REQUESTED",
    });
    await input.incidentStore.appendIncidentTimelineAsync(incident.id, {
      type: "RECOVERY_HANDOFF_ACCEPTED",
      at: nowIso,
      payload: {
        intent_key: intentKey,
        intent_result_status: result.status,
        deployment_id: input.deploymentId,
        authorization_by: input.authorization.authorizedBy,
        worker_id: input.workerId,
      },
    });
  }

  const refreshed = (await input.incidentStore.getIncidentAsync(incident.id)) ?? incident;
  const outcome: RecoveryHandoffOutcome =
    result.status === "CREATED" && !already ? "ACCEPTED" : "RECONCILED";
  return {
    outcome,
    reason: result.reason,
    intentKey,
    lifecycleAfter: refreshed.status,
    intent: result.intent,
  };
}