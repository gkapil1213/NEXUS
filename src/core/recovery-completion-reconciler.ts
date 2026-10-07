// src/core/recovery-completion-reconciler.ts
// Phase 254: production recovery completion + post-recovery integrity closure.
//
// The existing ReleaseRecoveryExecutor transitions a durable intent to
// KNOWN_GOOD on successful recovery (release-recovery-executor.ts:322,
// :596) but does NOT re-observe the deployment or resolve the correlated
// incident. Phase 254 closes that loop.
//
//   KNOWN_GOOD intent
//     -> correlated incident by recovery_intent_key
//     -> authoritative DeploymentRecord
//     -> fresh DeploymentObservation (existing observer)
//     -> evaluateDeploymentIntegrity()   (Phase 249, unchanged)
//     -> evaluateIncidentResolution()    (Phase 250, unchanged)
//     -> applyResolutionIfVerified()     (Phase 251, unchanged)
//     -> durable RESOLVED or remain unresolved
//
// Boundaries (hard):
//   - NEVER executes recovery, acquires leases, mutates recovery_attempt,
//     or calls Docker directly.
//   - NEVER fabricates an observation, identity, or VERIFIED state.
//   - Idempotent: a resolved or closed incident is skipped; timeline dedup
//     is inherited from appendIncidentTimelineAsync's event-hash.
//   - If the fresh observation is not VERIFIED, or evaluateIncidentResolution
//     refuses, the incident stays unresolved and a truthful timeline event
//     is appended.

import type { AsyncIncidentStore, SecurityIncident } from "./async-incident-store";
import type { DeploymentHistoryService } from "./deployment-history";
import type { DeploymentObservation, ExpectedDeploymentIdentity } from "./post-deployment-integrity";
import type { ReleaseDeploymentIntentService } from "./release-deployment-intent";
import type { ReleaseDeploymentIntent } from "./execution-store";
import type { Incident } from "./observability-types";
import {
  evaluateIncidentResolution,
  type IncidentResolutionEvaluation,
} from "./production-incident-response";
import { applyResolutionIfVerified } from "./incident-lifecycle";

export interface RecoveryCompletionObserver {
  observe(deploymentId: string): Promise<DeploymentObservation>;
}

export interface RecoveryCompletionEventSink {
  emit(event: { type: string; source: string; payload?: unknown }): Promise<unknown>;
}

export interface RecoveryCompletionReconcilerDeps {
  incidentStore: AsyncIncidentStore;
  history: DeploymentHistoryService;
  observer: RecoveryCompletionObserver;
  intents: ReleaseDeploymentIntentService;
  svc: { events: RecoveryCompletionEventSink };
  workerId: string;
  /** Safety valve: cap intents processed per call. Defaults to 50. */
  maxIntentsPerRun?: number;
}

export interface RecoveryCompletionReport {
  scanned: number;
  resolved: number;
  remainedUnresolved: number;
  skippedNoIncident: number;
  skippedNoIdentity: number;
  staleObservation: number;
  nonVerified: number;
  errors: string[];
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

export class RecoveryCompletionReconciler {
  constructor(private readonly deps: RecoveryCompletionReconcilerDeps) {}

  async reconcileCompleted(now: number = Date.now()): Promise<RecoveryCompletionReport> {
    const report: RecoveryCompletionReport = {
      scanned: 0,
      resolved: 0,
      remainedUnresolved: 0,
      skippedNoIncident: 0,
      skippedNoIdentity: 0,
      staleObservation: 0,
      nonVerified: 0,
      errors: [],
    };

    let intents: ReleaseDeploymentIntent[];
    try {
      intents = await this.listKnownGood();
    } catch (e) {
      report.errors.push("listKnownGood: " + (e instanceof Error ? e.message : String(e)));
      return report;
    }

    const cap = this.deps.maxIntentsPerRun ?? 50;
    const bounded = intents.slice(0, cap);

    for (const intent of bounded) {
      report.scanned++;

      // Only ROLLBACK intents correspond to Phase 253 recovery handoffs.
      if ((intent.intentKind ?? "DEPLOY") !== "ROLLBACK") continue;

      const incident = await this.deps.incidentStore
        .getIncidentByRecoveryIntentKeyAsync(intent.intentKey)
        .catch((e) => {
          report.errors.push("lookup(" + intent.intentKey + "): " + (e instanceof Error ? e.message : String(e)));
          return undefined;
        });
      if (!incident) { report.skippedNoIncident++; continue; }

      // Idempotent: already resolved/closed means a previous pass succeeded.
      if (incident.status === "RESOLVED" || incident.status === "CLOSED") continue;

      const expected = this.identityFromIncident(incident);
      if (!expected) { report.skippedNoIdentity++; continue; }

      let observation: DeploymentObservation;
      try {
        const deploymentId = intent.deploymentId ?? incident.deployment_id ?? "";
        observation = await this.deps.observer.observe(deploymentId);
      } catch (e) {
        report.errors.push("observe: " + (e instanceof Error ? e.message : String(e)));
        continue;
      }

      const originalTs = incident.last_observation_at ?? incident.created_at;
      const evaluation: IncidentResolutionEvaluation = evaluateIncidentResolution({
        incident: toIncidentShape(incident),
        expected,
        freshObservation: observation,
        originalObservationTimestamp: originalTs,
        now,
      });

      if (evaluation.state === "STALE_OBSERVATION") { report.staleObservation++; }
      else if (evaluation.state !== "RESOLVED_ALLOWED") { report.nonVerified++; }

      try {
        const applied = await applyResolutionIfVerified({
          store: this.deps.incidentStore,
          incident,
          resolution: evaluation,
          workerId: this.deps.workerId,
          now,
        });

        if (applied.updated) {
          report.resolved++;
          await this.deps.svc.events.emit({
            type: "recovery.completion.resolved",
            source: "RecoveryCompletionReconciler",
            payload: {
              intent_key: intent.intentKey,
              incident_id: incident.id,
              deployment_id: intent.deploymentId ?? incident.deployment_id ?? null,
              evaluation_state: evaluation.state,
              worker_id: this.deps.workerId,
            },
          }).catch(() => undefined);
        } else {
          report.remainedUnresolved++;
          await this.deps.svc.events.emit({
            type: "recovery.completion.unresolved",
            source: "RecoveryCompletionReconciler",
            payload: {
              intent_key: intent.intentKey,
              incident_id: incident.id,
              evaluation_state: evaluation.state,
              reasons: evaluation.reasons.slice(0, 5),
              worker_id: this.deps.workerId,
            },
          }).catch(() => undefined);
        }
      } catch (e) {
        report.errors.push("apply(" + intent.intentKey + "): " + (e instanceof Error ? e.message : String(e)));
      }
    }

    return report;
  }

  private identityFromIncident(incident: SecurityIncident): ExpectedDeploymentIdentity | null {
    const dep = incident.deployment_id;
    const rel = incident.release_id;
    const art = incident.artifact_id;
    const dig = incident.artifact_digest;
    if (!dep || !rel || !art || !dig) return null;
    return {
      deployment_id: dep,
      release_id: rel,
      artifact_id: art,
      artifact_digest: dig,
      environment: incident.environment,
    };
  }

  private async listKnownGood(): Promise<ReleaseDeploymentIntent[]> {
    if (this.deps.intents.hasAsyncBackend()) {
      return await this.deps.intents.listByStatusAsync("KNOWN_GOOD" as never);
    }
    return this.deps.intents.listByStatus("KNOWN_GOOD" as never);
  }
}