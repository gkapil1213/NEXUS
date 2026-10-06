// src/core/drift-recovery-handoff.ts
// Phase 253: recovery handoff integrity.
//
// After the drift observer creates/reconciles a durable incident for a
// DRIFTED deployment, the incident must be handed to the existing recovery
// owner (ReleaseDeploymentIntentService -> ReleaseRecoveryExecutor). This
// module implements that handoff.
//
// Boundaries (hard):
//   - NEVER executes recovery.
//   - NEVER acquires / renews / takes over a recovery lease.
//   - NEVER increments recovery_attempt.
//   - NEVER calls Docker, the deployment orchestrator, or any provider.
//   - NEVER invents identity. Every field is validated against the
//     authoritative persisted DeploymentRecord via the Phase 251 bridge
//     (buildProductionRecoveryContext).
//   - If the bridge returns BLOCKED, the handoff reports REJECTED and does
//     not fabricate a recovery intent.
//
// Idempotency:
//   - requestDriftRecoveryIntent -> ReleaseDeploymentIntentService.getOrCreateAsync
//     is already deterministic on ReleaseIntentInput (CREATED once, RECONCILED
//     thereafter for identical inputs).
//   - The incident is correlated by recovery_intent_key. If the incident
//     already carries the same key, the update is a no-op; a timeline event
//     is only emitted on first correlation.

import type { AsyncIncidentStore, SecurityIncident } from "./async-incident-store";
import type { DeploymentHistoryService } from "./deployment-history";
import type { ReleaseDeploymentIntentService } from "./release-deployment-intent";
import {
  buildProductionRecoveryContext,
  type RecoveryIdentityExpectation,
} from "./production-recovery-bridge";
import { requestDriftRecoveryIntent } from "./production-incident-response";
import type { Incident } from "./observability-types";

export type DriftRecoveryHandoffStatus =
  | "ACCEPTED"      // intent CREATED or RECONCILED; incident correlated
  | "REJECTED"      // bridge/identity validation refused; no intent created
  | "NOT_EXECUTED"; // no intent service supplied; nothing attempted

export interface DriftRecoveryHandoffInput {
  incidentStore: AsyncIncidentStore;
  history: DeploymentHistoryService;
  intentService?: ReleaseDeploymentIntentService;
  incident: SecurityIncident;
  deploymentId: string;
  expected: RecoveryIdentityExpectation;
  workerId: string;
  /** Test-only override for deterministic timestamps. */
  now?: number;
}

export interface DriftRecoveryHandoffResult {
  status: DriftRecoveryHandoffStatus;
  intentKey: string | null;
  reason: string;
  /** The durable incident after correlation (unchanged on REJECTED/NOT_EXECUTED). */
  incident: SecurityIncident;
  /** True when the incident row was updated by this call. */
  updated: boolean;
}

function toIncidentShape(s: SecurityIncident): Incident {
  // requestDriftRecoveryIntent only needs the identity fields of an Incident.
  // The lifecycle status is not used by that function; we cast to the base
  // Incident status union for type compatibility.
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

export async function handoffDriftIncidentToRecovery(
  input: DriftRecoveryHandoffInput,
): Promise<DriftRecoveryHandoffResult> {
  const { incidentStore, history, intentService, incident, deploymentId, expected } = input;
  const nowIso = new Date(input.now ?? Date.now()).toISOString();

  // 1. No intent service => NOT_EXECUTED, honest, no fabricated intent.
  if (!intentService) {
    return {
      status: "NOT_EXECUTED",
      intentKey: null,
      reason: "no ReleaseDeploymentIntentService provided; recovery handoff not attempted",
      incident,
      updated: false,
    };
  }

  // 2. Validate identity against the authoritative persisted deployment
  //    record. The Phase 251 bridge returns BLOCKED with a precise reason
  //    for missing or contradictory fields.
  const built = await buildProductionRecoveryContext({
    history,
    deploymentId,
    expected,
  });

  if (built.status !== "OK") {
    await incidentStore.appendIncidentTimelineAsync(incident.id, {
      type: "RECOVERY_HANDOFF_REJECTED",
      at: nowIso,
      payload: {
        reason: built.reason,
        deployment_id: deploymentId,
        worker_id: input.workerId,
      },
    });
    return {
      status: "REJECTED",
      intentKey: null,
      reason: built.reason,
      incident,
      updated: false,
    };
  }

  // 3. Idempotent intent creation via the existing Phase 250 primitive.
  //    requestDriftRecoveryIntent delegates to ReleaseDeploymentIntentService
  //    whose getOrCreateAsync is deterministic on ReleaseIntentInput.
  const result = await requestDriftRecoveryIntent({
    intentService,
    incident: toIncidentShape(incident),
    identity: {
      deployment_id: deploymentId,
      release_id: expected.release_id,
      artifact_id: expected.artifact_id,
      artifact_digest: expected.artifact_digest,
      environment: expected.environment,
    },
    providerContext: built.context,
  });

  if (result.status !== "CREATED" && result.status !== "RECONCILED") {
    await incidentStore.appendIncidentTimelineAsync(incident.id, {
      type: "RECOVERY_HANDOFF_REJECTED",
      at: nowIso,
      payload: {
        reason: result.reason,
        intent_result_status: result.status,
        deployment_id: deploymentId,
        worker_id: input.workerId,
      },
    });
    return {
      status: "REJECTED",
      intentKey: null,
      reason: result.reason,
      incident,
      updated: false,
    };
  }

  const intentKey = result.intentKey;
  if (typeof intentKey !== "string" || intentKey.length === 0) {
    // Defensive: requestDriftRecoveryIntent returned success without a key.
    // Treat as REJECTED rather than correlating a null key.
    return {
      status: "REJECTED",
      intentKey: null,
      reason: "intent service returned success without an intentKey",
      incident,
      updated: false,
    };
  }

  // 4. Correlate on the durable incident. Idempotent: if the incident
  //    already carries the same key, do not rewrite the row and do not
  //    duplicate the timeline event.
  const alreadyCorrelated = incident.recovery_intent_key === intentKey;

  if (!alreadyCorrelated) {
    await incidentStore.updateIncidentAsync(incident.id, {
      recovery_intent_key: intentKey,
      status: "RECOVERY_REQUESTED",
    });
    await incidentStore.appendIncidentTimelineAsync(incident.id, {
      type: "RECOVERY_HANDOFF_ACCEPTED",
      at: nowIso,
      payload: {
        intent_key: intentKey,
        intent_result_status: result.status, // CREATED | RECONCILED
        deployment_id: deploymentId,
        worker_id: input.workerId,
      },
    });
  }

  const refreshed = (await incidentStore.getIncidentAsync(incident.id)) ?? incident;
  return {
    status: "ACCEPTED",
    intentKey,
    reason: result.reason,
    incident: refreshed,
    updated: !alreadyCorrelated,
  };
}