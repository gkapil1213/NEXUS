// src/core/incident-lifecycle.ts
// Phase 251: durable shared-production incident lifecycle boundary.
//
// Wraps the Phase 250 pure decision functions
// (classifyDeploymentDrift / buildProductionIncidentFromDrift /
// evaluateRemediationAuthorization / evaluateIncidentResolution /
// computeIncidentFingerprint) with the Phase 251 PostgreSQL-backed
// AsyncIncidentStore.
//
// Does NOT replace ReleaseRecoveryService / RecoveryPolicyEngine /
// ReleaseRecoveryExecutor. Does NOT construct a database connection
// internally. All authoritative state lives in security_incidents /
// security_incident_timeline. The Phase 250 random ProductionIncident id is
// never used as the durable identity; the deterministic fingerprint is.

import type {
  AsyncIncidentStore,
  SecurityIncident,
  IncidentLifecycleStatus,
} from "./async-incident-store";
import type { DriftClassification } from "./production-incident-response";
import type {
  DeploymentIntegrityResult,
  DeploymentObservation,
} from "./post-deployment-integrity";
import {
  computeIncidentFingerprint,
  evaluateRemediationAuthorization,
  type IncidentResolutionEvaluation,
} from "./production-incident-response";
import type {
  RecoveryAction,
  RecoveryAuthorization,
  RecoveryDecision,
  RecoveryPolicyEngine,
} from "./recovery-policy-engine";
import type { ProductionIncident } from "./worker-production-incident";

const DEFAULT_TENANT = "default";
const DEFAULT_SERVICE = "deployment-integrity";

export interface DriftIncidentIdentity {
  deployment_id: string;
  release_id: string;
  artifact_id: string;
  artifact_digest: string;
  environment: string;
}

export interface OpenOrReconcileDriftIncidentInput {
  store: AsyncIncidentStore;
  identity: DriftIncidentIdentity;
  classifications: DriftClassification[];
  severity: string;
  observedAt: string;
  title: string;
  description: string;
  tenantId?: string;
  service?: string;
}

export interface OpenOrReconcileDriftIncidentResult {
  incident: SecurityIncident;
  fingerprint: string;
  created: boolean;
  newerObservation: boolean;
  timelineInserted: boolean;
}

export function deterministicDriftIncidentId(fingerprint: string): string {
  return "incident-drift-" + fingerprint.slice(0, 24);
}

export function isObservationNewer(
  incoming: string,
  stored: string | null | undefined,
): boolean {
  const inc = Date.parse(incoming);
  if (Number.isNaN(inc)) return false;
  if (stored == null || stored === "") return true;
  const st = Date.parse(stored);
  if (Number.isNaN(st)) return true;
  return inc > st;
}

export async function openOrReconcileDriftIncident(
  input: OpenOrReconcileDriftIncidentInput,
): Promise<OpenOrReconcileDriftIncidentResult> {
  const { store, identity, classifications } = input;
  const fingerprint = computeIncidentFingerprint({ ...identity, classifications });
  const id = deterministicDriftIncidentId(fingerprint);
  const observedAt = input.observedAt;

  const existing = await store.getIncidentByFingerprintAsync(fingerprint);
  if (existing) {
    const newer = isObservationNewer(observedAt, existing.last_observation_at);
    if (newer) {
      await store.updateIncidentAsync(existing.id, {
        last_observation_at: observedAt,
      });
    }
    const ev = await store.appendIncidentTimelineAsync(existing.id, {
      type: newer ? "OBSERVATION_RECONCILED" : "OBSERVATION_STALE_IGNORED",
      at: observedAt,
      payload: {
        fingerprint,
        observedAt,
        classifications,
        previous_observation_at: existing.last_observation_at ?? null,
      },
    });
    const refreshed = (await store.getIncidentAsync(existing.id)) ?? existing;
    return {
      incident: refreshed,
      fingerprint,
      created: false,
      newerObservation: newer,
      timelineInserted: ev.inserted,
    };
  }

  let createdRow: SecurityIncident;
  try {
    createdRow = await store.createIncidentAsync({
      id,
      tenant_id: input.tenantId ?? DEFAULT_TENANT,
      environment: identity.environment,
      service: input.service ?? DEFAULT_SERVICE,
      severity: input.severity,
      title: input.title,
      description: input.description,
      status: "OPEN",
      deployment_id: identity.deployment_id,
      release_id: identity.release_id,
      artifact_id: identity.artifact_id,
      artifact_digest: identity.artifact_digest,
      drift_classification: classifications.join(","),
      incident_fingerprint: fingerprint,
      created_at: observedAt,
      updated_at: observedAt,
    });
  } catch (e) {
    const raced = await store.getIncidentByFingerprintAsync(fingerprint);
    if (!raced) throw e;
    const newer = isObservationNewer(observedAt, raced.last_observation_at);
    const ev = await store.appendIncidentTimelineAsync(raced.id, {
      type: "CONCURRENT_CREATE_RECONCILED",
      at: observedAt,
      payload: { fingerprint, observedAt },
    });
    return {
      incident: raced,
      fingerprint,
      created: false,
      newerObservation: newer,
      timelineInserted: ev.inserted,
    };
  }

  await store.updateIncidentAsync(id, { last_observation_at: observedAt });
  const ev = await store.appendIncidentTimelineAsync(id, {
    type: "INCIDENT_CREATED",
    at: observedAt,
    payload: { fingerprint, classifications },
  });
  const finalRow = (await store.getIncidentAsync(id)) ?? createdRow;
  return {
    incident: finalRow,
    fingerprint,
    created: true,
    newerObservation: true,
    timelineInserted: ev.inserted,
  };
}

export interface RequestRecoveryInput {
  store: AsyncIncidentStore;
  incident: SecurityIncident;
  phase250Incident: ProductionIncident;
  policyEngine: RecoveryPolicyEngine;
  authorization?: RecoveryAuthorization;
  environment?: string;
  attemptNumber?: number;
  workerId: string;
  now?: number;
}

export interface RequestRecoveryResult {
  incident: SecurityIncident;
  decision: RecoveryDecision;
  action: RecoveryAction;
  remediationAvailable: boolean;
  reason: string;
  persistedStatus: IncidentLifecycleStatus;
}

export async function requestRecoveryFromIncident(
  input: RequestRecoveryInput,
): Promise<RequestRecoveryResult> {
  const { store, incident, phase250Incident, policyEngine } = input;
  const environment = input.environment ?? incident.environment;
  const attemptNumber = input.attemptNumber ?? 1;

  const auth = evaluateRemediationAuthorization(
    phase250Incident,
    policyEngine,
    input.authorization,
    environment,
    attemptNumber,
  );

  const persistedStatus: IncidentLifecycleStatus =
    auth.decision === "AUTOMATIC"
      ? "RECOVERY_AUTHORIZED"
      : auth.decision === "HUMAN_APPROVAL_REQUIRED"
        ? "REQUIRE_REVIEW"
        : "BLOCKED";

  await store.updateIncidentAsync(incident.id, { status: persistedStatus });

  const nowIso = new Date(input.now ?? Date.now()).toISOString();
  await store.appendIncidentTimelineAsync(incident.id, {
    type: "RECOVERY_AUTHORIZATION_EVALUATED",
    at: nowIso,
    payload: {
      decision: auth.decision,
      action_type: auth.action.type,
      reason: auth.reason,
      remediation_available: auth.remediationAvailable,
      attempt_number: attemptNumber,
      worker_id: input.workerId,
    },
  });

  const refreshed = (await store.getIncidentAsync(incident.id)) ?? incident;
  return {
    incident: refreshed,
    decision: auth.decision,
    action: auth.action,
    remediationAvailable: auth.remediationAvailable,
    reason: auth.reason,
    persistedStatus,
  };
}

export interface ApplyResolutionInput {
  store: AsyncIncidentStore;
  incident: SecurityIncident;
  resolution: IncidentResolutionEvaluation;
  workerId: string;
  now?: number;
}

export interface ApplyResolutionResult {
  incident: SecurityIncident;
  updated: boolean;
  reason: string;
}

export async function applyResolutionIfVerified(
  input: ApplyResolutionInput,
): Promise<ApplyResolutionResult> {
  const { store, incident, resolution } = input;

  if (incident.status === "CLOSED" || incident.status === "RESOLVED") {
    return { incident, updated: false, reason: "incident already terminal" };
  }

  const nowIso = new Date(input.now ?? Date.now()).toISOString();

  if (resolution.state !== "RESOLVED_ALLOWED") {
    await store.appendIncidentTimelineAsync(incident.id, {
      type: "RESOLUTION_EVALUATED_NOT_ALLOWED",
      at: nowIso,
      payload: {
        state: resolution.state,
        integrity_state: resolution.fresh_integrity_state,
        reasons: resolution.reasons,
        observation_timestamp: resolution.observation_timestamp,
        worker_id: input.workerId,
      },
    });
    return { incident, updated: false, reason: "resolution not allowed: " + resolution.state };
  }

  const evidence = JSON.stringify({
    reasons: resolution.reasons,
    observation_timestamp: resolution.observation_timestamp,
    worker_id: input.workerId,
    at: nowIso,
  });

  await store.updateIncidentAsync(incident.id, {
    status: "RESOLVED",
    verification_state: "VERIFIED",
    resolution_evidence: evidence,
    resolved_at: nowIso,
    last_observation_at: resolution.observation_timestamp,
  });

  await store.appendIncidentTimelineAsync(incident.id, {
    type: "INCIDENT_RESOLVED",
    at: nowIso,
    payload: {
      state: resolution.state,
      observation_timestamp: resolution.observation_timestamp,
      worker_id: input.workerId,
    },
  });

  const refreshed = (await store.getIncidentAsync(incident.id)) ?? incident;
  return { incident: refreshed, updated: true, reason: "resolved from fresh VERIFIED observation" };
}

export interface CloseIncidentInput {
  store: AsyncIncidentStore;
  incident: SecurityIncident;
  workerId: string;
  now?: number;
}

export interface CloseIncidentResult {
  incident: SecurityIncident;
  closed: boolean;
  reason: string;
}

export async function closeIncidentIfResolved(
  input: CloseIncidentInput,
): Promise<CloseIncidentResult> {
  const { store, incident } = input;
  if (incident.status === "CLOSED") {
    return { incident, closed: false, reason: "already closed" };
  }
  const resolvedOk = incident.status === "RESOLVED" || incident.status === "RECOVERED";
  const verifiedOk = (incident.verification_state ?? "").toUpperCase() === "VERIFIED";
  if (!resolvedOk || !verifiedOk) {
    return { incident, closed: false, reason: "closure prerequisites not satisfied" };
  }
  const nowIso = new Date(input.now ?? Date.now()).toISOString();
  await store.updateIncidentAsync(incident.id, {
    status: "CLOSED",
    closed_at: nowIso,
  });
  await store.appendIncidentTimelineAsync(incident.id, {
    type: "INCIDENT_CLOSED",
    at: nowIso,
    payload: { worker_id: input.workerId },
  });
  const refreshed = (await store.getIncidentAsync(incident.id)) ?? incident;
  return { incident: refreshed, closed: true, reason: "closed after verified resolution" };
}

// -----------------------------------------------------------------------------
// Phase 255: post-resolution drift requires review via the existing lifecycle.
// -----------------------------------------------------------------------------
//
// A previously RESOLVED incident whose deployment is now authoritatively
// DRIFTED must not remain silently RESOLVED. This is the smallest authoritative
// lifecycle transition for that case: RESOLVED -> REQUIRE_REVIEW, guarded by
// the current status (concurrency-safe via the store's conditional UPDATE) and
// requiring DRIFTED evidence from the existing Phase 249 evaluator.
//
// It does NOT:
//   - create a recovery intent (that is the existing handoff's job)
//   - acquire leases, execute recovery, or mutate recovery_attempt
//   - fabricate an observation, identity, or VERIFIED state
//
// On success it appends a deterministic timeline event. Repeating the call on
// an already-transitioned incident is a no-op (guard fails).

export interface RequestReviewAfterResolvedDriftInput {
  store: AsyncIncidentStore;
  incident: SecurityIncident;
  integrity: DeploymentIntegrityResult;
  observation: DeploymentObservation;
  workerId: string;
  now?: number;
}

export interface RequestReviewAfterResolvedDriftResult {
  transitioned: boolean;
  reason: string;
  lifecycleAfter: IncidentLifecycleStatus;
}

export async function requestReviewAfterResolvedDrift(
  input: RequestReviewAfterResolvedDriftInput,
): Promise<RequestReviewAfterResolvedDriftResult> {
  const { store, incident, integrity, observation } = input;
  const nowIso = new Date(input.now ?? Date.now()).toISOString();

  if (incident.status !== "RESOLVED") {
    return {
      transitioned: false,
      reason: "incident is not RESOLVED (current=" + incident.status + ")",
      lifecycleAfter: incident.status,
    };
  }

  if (integrity.state !== "DRIFTED") {
    return {
      transitioned: false,
      reason: "integrity.state is not DRIFTED (got " + integrity.state + ")",
      lifecycleAfter: incident.status,
    };
  }

  const transitioned = await store.transitionIncidentStatusIfCurrentAsync(
    incident.id,
    "RESOLVED",
    "REQUIRE_REVIEW",
    { last_observation_at: observation.observed_at },
  );

  if (!transitioned) {
    // Another worker won the race, or the incident is no longer RESOLVED.
    const after = (await store.getIncidentAsync(incident.id)) ?? incident;
    return {
      transitioned: false,
      reason: "guarded transition refused (concurrent or already-transitioned)",
      lifecycleAfter: after.status,
    };
  }

  await store.appendIncidentTimelineAsync(incident.id, {
    type: "POST_RESOLUTION_DRIFT_REVIEW_REQUIRED",
    at: observation.observed_at,
    payload: {
      deployment_id: incident.deployment_id ?? null,
      release_id: incident.release_id ?? null,
      artifact_id: incident.artifact_id ?? null,
      artifact_digest: incident.artifact_digest ?? null,
      observation_timestamp: observation.observed_at,
      integrity_reasons: integrity.reasons.slice(0, 5),
      from: "RESOLVED",
      to: "REQUIRE_REVIEW",
      worker_id: input.workerId,
    },
  });

  return {
    transitioned: true,
    reason: "RESOLVED -> REQUIRE_REVIEW because authoritative drift was observed",
    lifecycleAfter: "REQUIRE_REVIEW",
  };
}