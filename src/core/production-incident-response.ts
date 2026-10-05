// src/core/production-incident-response.ts
// Phase 250: Production incident response decision layer.
// Consumes Phase 249 DeploymentIntegrityResult. Pure, deterministic, no provider.

import { ProductionIncident, createProductionIncident } from "./worker-production-incident";
import { RecoveryPolicyEngine, RecoveryDecision, RecoveryAction, RecoveryAuthorization } from "./recovery-policy-engine";
import type { DeploymentIntegrityState } from "./post-deployment-integrity";
import { evaluateDeploymentIntegrity } from "./post-deployment-integrity";
import { DeploymentIntegrityResult, DeploymentObservation, ExpectedDeploymentIdentity } from "./post-deployment-integrity";
import { ObservabilityService } from "./observability-service";
import { Incident } from "./observability-types";
import {
  ReleaseDeploymentIntentService,
  ReleaseIntentInput,
} from "./release-deployment-intent";
import type { ReleaseDeploymentIntent } from "./execution-store";
import { sha256Hex } from "./integrity";

export type DriftClassification =
  | "DIGEST_MISMATCH"
  | "ARTIFACT_IDENTITY_MISMATCH"
  | "RELEASE_IDENTITY_MISMATCH"
  | "UNKNOWN_DEPLOYED_STATE"
  | "PROVIDER_UNAVAILABLE"
  | "OBSERVATION_ERROR"
  | "NOT_EXECUTED";

export interface RemediationAuthorization {
  decision: RecoveryDecision;
  action: RecoveryAction;
  remediationAvailable: boolean;
  reason: string;
}

export interface DeploymentDriftResponse {
  incident: ProductionIncident;
  classifications: DriftClassification[];
  authorization: RemediationAuthorization;
}

export function classifyDeploymentDrift(
  integrity: DeploymentIntegrityResult,
  expected: ExpectedDeploymentIdentity,
  observation: DeploymentObservation,
): DriftClassification[] {
  const out: DriftClassification[] = [];
  if (!observation.available) { out.push("PROVIDER_UNAVAILABLE"); return out; }
  if (observation.status === "ERROR") { out.push("OBSERVATION_ERROR"); return out; }
  if (observation.status === "NOT_EXECUTED") { out.push("NOT_EXECUTED"); return out; }
  if (
    observation.observed_digest == null ||
    observation.observed_release_id == null ||
    observation.observed_artifact_id == null
  ) { out.push("UNKNOWN_DEPLOYED_STATE"); return out; }
  if (observation.observed_release_id !== expected.release_id) out.push("RELEASE_IDENTITY_MISMATCH");
  if (observation.observed_artifact_id !== expected.artifact_id) out.push("ARTIFACT_IDENTITY_MISMATCH");
  if (observation.observed_digest !== expected.artifact_digest) out.push("DIGEST_MISMATCH");
  return out;
}

function severityFor(c: DriftClassification[]): ProductionIncident["severity"] {
  if (c.includes("DIGEST_MISMATCH")) return "CRITICAL";
  if (c.includes("ARTIFACT_IDENTITY_MISMATCH") || c.includes("RELEASE_IDENTITY_MISMATCH")) return "HIGH";
  if (c.includes("UNKNOWN_DEPLOYED_STATE") || c.includes("OBSERVATION_ERROR")) return "MEDIUM";
  return "LOW";
}

export function buildProductionIncidentFromDrift(
  integrity: DeploymentIntegrityResult,
  expected: ExpectedDeploymentIdentity,
  classifications: DriftClassification[],
): ProductionIncident {
  const correlationId = ["drift", expected.deployment_id, expected.release_id, expected.artifact_id, expected.artifact_digest].join(":");
  const evidence = [
    "expected_digest=" + String(integrity.expected_digest),
    "observed_digest=" + String(integrity.observed_digest),
    ...classifications,
    ...integrity.reasons,
  ];
  return createProductionIncident({
    environmentId: expected.environment ?? "unknown",
    releaseId: expected.release_id,
    service: "deployment-integrity",
    severity: severityFor(classifications),
    evidence,
    correlationId,
  });
}

export function evaluateRemediationAuthorization(
  incident: ProductionIncident,
  policyEngine: RecoveryPolicyEngine,
  authorization?: RecoveryAuthorization,
  environment: string = "production",
  attemptNumber: number = 1,
): RemediationAuthorization {
  const action: RecoveryAction = {
    id: "act-" + incident.incidentId,
    type: "rollback",
    service: incident.service,
    environment,
    description: "Rollback deployment " + incident.environmentId + " to approved release " + (incident.releaseId ?? "<unknown>"),
  };
  const decision = policyEngine.evaluate(action, environment, attemptNumber, authorization);
  let reason: string;
  switch (decision) {
    case "HUMAN_APPROVAL_REQUIRED":
      reason = authorization ? "attempt budget exhausted" : "policy requires human approval";
      break;
    case "DENIED": reason = "policy denied"; break;
    case "BLOCKED": reason = "policy blocked"; break;
    case "AUTOMATIC": reason = "policy permits but no authorized remediation provider is configured"; break;
    default: reason = "unknown";
  }
  return { decision, action, remediationAvailable: false, reason };
}

export function processDeploymentDrift(
  integrity: DeploymentIntegrityResult,
  expected: ExpectedDeploymentIdentity,
  observation: DeploymentObservation,
  policyEngine: RecoveryPolicyEngine = new RecoveryPolicyEngine(),
  authorization?: RecoveryAuthorization,
): DeploymentDriftResponse | null {
  if (integrity.state === "VERIFIED") return null;
  const classifications = classifyDeploymentDrift(integrity, expected, observation);
  const incident = buildProductionIncidentFromDrift(integrity, expected, classifications);
  const auth = evaluateRemediationAuthorization(incident, policyEngine, authorization);
  return { incident, classifications, authorization: auth };
}

// -----------------------------------------------------------------------------
// Phase 250 - canonical incident persistence via ObservabilityService
// -----------------------------------------------------------------------------

/**
 * Deterministic fingerprint over immutable drift identity + classification set.
 * Same deployment + release + artifact + digest + environment + classifications
 * always produces the same fingerprint, so repeated observations reconcile to
 * the same canonical incident instead of creating duplicates.
 */
export function computeIncidentFingerprint(input: {
  deployment_id: string;
  release_id: string;
  artifact_id: string;
  artifact_digest: string;
  environment: string;
  classifications: DriftClassification[];
}): string {
  const sorted = [...input.classifications].sort().join(",");
  const raw = [
    input.deployment_id,
    input.release_id,
    input.artifact_id,
    input.artifact_digest,
    input.environment,
    sorted,
  ].join("|");
  return sha256Hex(raw);
}

/**
 * Open or reconcile the canonical Incident for a deployment-drift observation.
 * Uses ObservabilityService - the existing canonical incident persistence
 * boundary. Idempotent: same fingerprint => same incident id, no duplicate.
 *
 * The underlying engine is NexusEngine (Node: SQLite-backed). This function
 * does NOT claim PostgreSQL persistence.
 */
export async function openOrReconcileDriftIncident(
  observability: ObservabilityService,
  identity: {
    deployment_id: string;
    release_id: string;
    artifact_id: string;
    artifact_digest: string;
    environment: string;
  },
  classifications: DriftClassification[],
  severity: string,
  tenantId: string = "default",
): Promise<{ incident: Incident; created: boolean }> {
  const fingerprint = computeIncidentFingerprint({ ...identity, classifications });
  const incidentId = "incident-drift-" + fingerprint.slice(0, 24);

  const existing = await observability.getIncident(incidentId);
  if (existing) {
    return { incident: existing, created: false };
  }

  const now = new Date().toISOString();
  const incident: Incident = {
    id: incidentId,
    tenant_id: tenantId,
    environment: identity.environment,
    service: "deployment-integrity",
    severity,
    title: "Deployment drift: " + classifications.join(", "),
    description:
      "Deployment " + identity.deployment_id +
      " drift vs approved release " + identity.release_id +
      " artifact " + identity.artifact_id +
      " digest " + identity.artifact_digest,
    status: "OPEN",
    created_at: now,
    updated_at: now,
  };

  await observability.createIncident(incident);
  await observability.appendIncidentTimeline(incidentId, {
    type: "OPEN",
    timestamp: now,
    details: "classifications=" + classifications.join(","),
  });

  return { incident, created: true };
}

// -----------------------------------------------------------------------------
// Phase 250 - A19: durable ReleaseRecovery intent creation for drift recovery
// -----------------------------------------------------------------------------
//
// Honest boundary:
//   - Uses the existing ReleaseDeploymentIntentService.
//   - ReleaseIntentInput requires provider-context (image/container identity)
//     that Phase 249 drift classification does not see. When absent, returns
//     BLOCKED - no fabricated docker identity.
//   - On success, the intent is durable and the existing ReleaseRecoveryExecutor
//     (kernel supervisor loop) picks it up. This module never invokes Docker
//     or the deployment provider directly.

export interface DriftRecoveryProviderContext {
  executionId: string;
  attemptId: string;
  commitSha: string;
  imageRepository: string;
  imageTag: string;
  imageId: string | null;
  imageDigest: string;
  containerName: string;
  containerPort: number;
  projectId?: string | null;
}

export interface DriftRecoveryIntentResult {
  status: "CREATED" | "RECONCILED" | "BLOCKED" | "NOT_EXECUTED";
  intentKey: string | null;
  reason: string;
  intent?: ReleaseDeploymentIntent;
}

export async function requestDriftRecoveryIntent(input: {
  intentService: ReleaseDeploymentIntentService;
  incident: Incident;
  identity: {
    deployment_id: string;
    release_id: string;
    artifact_id: string;
    artifact_digest: string;
    environment: string;
  };
  providerContext?: DriftRecoveryProviderContext;
}): Promise<DriftRecoveryIntentResult> {
  if (!input.providerContext) {
    return {
      status: "BLOCKED",
      intentKey: null,
      reason:
        "no provider context available; ReleaseIntentInput requires image/container " +
        "identity not present in the drift observation",
    };
  }

  const pc = input.providerContext;
  const intentInput: ReleaseIntentInput = {
    intentKind: "ROLLBACK",
    releaseId: input.identity.release_id,
    executionId: pc.executionId,
    attemptId: pc.attemptId,
    artifactId: input.identity.artifact_id,
    artifactDigest: input.identity.artifact_digest,
    commitSha: pc.commitSha,
    environment: input.identity.environment,
    projectId: pc.projectId ?? null,
    imageRepository: pc.imageRepository,
    imageTag: pc.imageTag,
    imageId: pc.imageId,
    imageDigest: pc.imageDigest,
    containerName: pc.containerName,
    containerPort: pc.containerPort,
  };

  try {
    const { intent, created } = await input.intentService.getOrCreate(intentInput);
    return {
      status: created ? "CREATED" : "RECONCILED",
      intentKey: intent.intentKey,
      reason: created
        ? "recovery intent created via existing ReleaseDeploymentIntentService"
        : "recovery intent already existed for this identity",
      intent,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      status: "BLOCKED",
      intentKey: null,
      reason: "intent creation failed: " + msg,
    };
  }
}


// -----------------------------------------------------------------------------
// Phase 250 - A21: incident resolution requires a fresh VERIFIED observation
// -----------------------------------------------------------------------------
//
// Rule: only a genuinely newer observation that evaluates to VERIFIED may
// resolve an incident. Stale observations cannot resolve; DRIFTED/UNKNOWN/
// BLOCKED/NOT_EXECUTED fresh observations cannot resolve.

export interface IncidentResolutionEvaluation {
  state: "RESOLVED_ALLOWED" | "STILL_DRIFTED" | "STILL_UNKNOWN" | "BLOCKED" | "NOT_EXECUTED" | "STALE_OBSERVATION";
  fresh_integrity_state: DeploymentIntegrityState | null;
  reasons: string[];
  observation_timestamp: string;
}

export function evaluateIncidentResolution(input: {
  incident: Incident;
  expected: ExpectedDeploymentIdentity;
  freshObservation: DeploymentObservation;
  originalObservationTimestamp: string;
  now?: number;
}): IncidentResolutionEvaluation {
  const now = input.now ?? Date.now();
  const freshTs = Date.parse(input.freshObservation.observed_at);
  const origTs = Date.parse(input.originalObservationTimestamp);

  if (Number.isNaN(freshTs)) {
    return {
      state: "STALE_OBSERVATION",
      fresh_integrity_state: null,
      reasons: ["fresh observation has no valid observed_at timestamp"],
      observation_timestamp: input.freshObservation.observed_at,
    };
  }

  // Strict freshness: fresh observation must be strictly newer than the
  // observation that created the incident.
  if (!Number.isNaN(origTs) && freshTs <= origTs) {
    return {
      state: "STALE_OBSERVATION",
      fresh_integrity_state: null,
      reasons: [
        "fresh observation (" + input.freshObservation.observed_at + ") is not newer than " +
        "the original drift observation (" + input.originalObservationTimestamp + ")",
      ],
      observation_timestamp: input.freshObservation.observed_at,
    };
  }

  // Delegate to Phase 249 evaluation with the fresh observation.
  const integrity = evaluateDeploymentIntegrity(input.expected, input.freshObservation);

  switch (integrity.state) {
    case "VERIFIED":
      return {
        state: "RESOLVED_ALLOWED",
        fresh_integrity_state: "VERIFIED",
        reasons: ["fresh observation verified"],
        observation_timestamp: input.freshObservation.observed_at,
      };
    case "DRIFTED":
      return {
        state: "STILL_DRIFTED",
        fresh_integrity_state: "DRIFTED",
        reasons: integrity.reasons,
        observation_timestamp: input.freshObservation.observed_at,
      };
    case "UNKNOWN":
      return {
        state: "STILL_UNKNOWN",
        fresh_integrity_state: "UNKNOWN",
        reasons: integrity.reasons,
        observation_timestamp: input.freshObservation.observed_at,
      };
    case "BLOCKED":
      return {
        state: "BLOCKED",
        fresh_integrity_state: "BLOCKED",
        reasons: integrity.reasons,
        observation_timestamp: input.freshObservation.observed_at,
      };
    case "NOT_EXECUTED":
      return {
        state: "NOT_EXECUTED",
        fresh_integrity_state: "NOT_EXECUTED",
        reasons: integrity.reasons,
        observation_timestamp: input.freshObservation.observed_at,
      };
    default:
      return {
        state: "STILL_UNKNOWN",
        fresh_integrity_state: null,
        reasons: ["unknown integrity state from Phase 249"],
        observation_timestamp: input.freshObservation.observed_at,
      };
  }
}