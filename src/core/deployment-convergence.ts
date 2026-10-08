// src/core/deployment-convergence.ts
// Phase 256: deterministic convergence for asynchronous deployment observations.
//
// Composes existing primitives - no new tables, no new schema, no duplicate
// reconciler, no duplicate lifecycle authority:
//
//   isObservationNewer                      (ordering)
//   transactionAsync                        (atomicity)
//   transitionIncidentStatusIfCurrentAsync  (concurrency-safe CAS)
//   appendIncidentTimelineAsync             (idempotent evidence)
//
// The observation -> decision -> intent -> execution -> verification
// distinction is preserved: this module only persists an observation and
// transitions lifecycle state. It never executes recovery, acquires leases,
// mutates recovery_attempt, or claims verification.
//
// Semantics:
//   * Stale observation      -> no state change, REJECTED, timeline event
//   * Duplicate observation  -> idempotent (timeline hash dedup)
//   * Newer DRIFTED          -> CAS transition, timeline event
//   * Newer VERIFIED         -> no state change (resolution is applyResolutionIfVerified's job)
//   * Deployment identity mismatch -> REJECTED, no transition

import type { AsyncIncidentStore, SecurityIncident, IncidentLifecycleStatus } from "./async-incident-store";
import { isObservationNewer } from "./incident-lifecycle";

export interface ConvergentObservationInput {
  store: AsyncIncidentStore;
  incidentId: string;
  /** Authoritative deployment ID observed. Must match the incident's current binding. */
  deploymentId: string;
  /** ISO timestamp of the observation (used for ordering). */
  observedAt: string;
  /** Drift classification label(s), recorded in evidence. */
  classification: string;
  /**
   * Lifecycle target when the observation is newer and authoritative.
   * Caller decides via the existing lifecycle vocabulary. When omitted,
   * the observation only updates `last_observation_at` (no status change).
   */
  nextStatus?: IncidentLifecycleStatus;
  /** Worker/actor identity for the timeline event. */
  workerId: string;
  /** Optional test override for deterministic timestamps in the timeline. */
  now?: number;
}

export type ConvergentObservationOutcome =
  | "APPLIED"           // newer observation, state transitioned
  | "OBSERVED"          // newer observation, no status change requested
  | "STALE_REJECTED"    // older or equal timestamp
  | "DUPLICATE"         // identical event hash already present
  | "IDENTITY_MISMATCH" // deploymentId does not match the incident's binding
  | "NOT_FOUND";        // incident missing

export interface ConvergentObservationResult {
  outcome: ConvergentObservationOutcome;
  reason: string;
  lifecycleBefore: IncidentLifecycleStatus | null;
  lifecycleAfter: IncidentLifecycleStatus | null;
}

/**
 * Apply one asynchronous deployment observation with deterministic convergence.
 * Idempotent, ordering-aware, and atomic where a status change is requested.
 */
export async function applyConvergentObservationAsync(
  input: ConvergentObservationInput,
): Promise<ConvergentObservationResult> {
  const nowIso = new Date(input.now ?? Date.now()).toISOString();

  // 1. Load the current authoritative incident.
  const incident = await input.store.getIncidentAsync(input.incidentId);
  if (!incident) {
    return {
      outcome: "NOT_FOUND",
      reason: "incident not found: " + input.incidentId,
      lifecycleBefore: null,
      lifecycleAfter: null,
    };
  }
  const lifecycleBefore = incident.status;

  // 2. Deployment identity binding check. A late observation for a different
  //    deployment must not affect this incident's state.
  if (incident.deployment_id && incident.deployment_id !== input.deploymentId) {
    await input.store.appendIncidentTimelineAsync(incident.id, {
      type: "CONVERGENCE_IDENTITY_MISMATCH",
      at: input.observedAt,
      payload: {
        expected_deployment_id: incident.deployment_id,
        observed_deployment_id: input.deploymentId,
        classification: input.classification,
        worker_id: input.workerId,
      },
    }).catch(() => undefined);
    return {
      outcome: "IDENTITY_MISMATCH",
      reason: "observation deployment_id does not match incident binding",
      lifecycleBefore,
      lifecycleAfter: lifecycleBefore,
    };
  }

  // 3. Terminal protection: CLOSED incidents do not silently reopen here.
  //    Phase 255 routes drift on CLOSED via timeline evidence only.
  if (incident.status === "CLOSED") {
    await input.store.appendIncidentTimelineAsync(incident.id, {
      type: "CONVERGENCE_CLOSED_OBSERVATION",
      at: input.observedAt,
      payload: {
        classification: input.classification,
        observed_at: input.observedAt,
        worker_id: input.workerId,
      },
    }).catch(() => undefined);
    return {
      outcome: "STALE_REJECTED",
      reason: "incident is CLOSED; observation recorded as evidence only",
      lifecycleBefore,
      lifecycleAfter: lifecycleBefore,
    };
  }

  // 4. Ordering: reject non-newer observations. Uses the existing comparison.
  const isNewer = isObservationNewer(input.observedAt, incident.last_observation_at);
  if (!isNewer) {
    const ev = await input.store.appendIncidentTimelineAsync(incident.id, {
      type: "CONVERGENCE_STALE_OBSERVATION",
      at: input.observedAt,
      payload: {
        stored_last_observation_at: incident.last_observation_at ?? null,
        incoming_observed_at: input.observedAt,
        classification: input.classification,
        worker_id: input.workerId,
      },
    }).catch(() => ({ inserted: false, seq: null }));
    // If the same stale event hash already exists, the outcome is DUPLICATE.
    if (!ev.inserted) {
      return {
        outcome: "DUPLICATE",
        reason: "identical observation already recorded",
        lifecycleBefore,
        lifecycleAfter: lifecycleBefore,
      };
    }
    return {
      outcome: "STALE_REJECTED",
      reason: "observation is not newer than last_observation_at",
      lifecycleBefore,
      lifecycleAfter: lifecycleBefore,
    };
  }

  // 5. Newer observation. If no status change requested, only advance the
  //    observation timestamp - never fabricate a lifecycle transition.
  if (!input.nextStatus || input.nextStatus === lifecycleBefore) {
    const okRec = await input.store.recordObservationAsync(incident.id, input.observedAt);
    await input.store.appendIncidentTimelineAsync(incident.id, {
      type: "CONVERGENCE_OBSERVATION_RECORDED",
      at: input.observedAt,
      payload: {
        classification: input.classification,
        observed_at: input.observedAt,
        worker_id: input.workerId,
      },
    }).catch(() => undefined);
    return {
      outcome: okRec ? "OBSERVED" : "STALE_REJECTED",
      reason: okRec
        ? "observation timestamp advanced; no status change requested"
        : "recordObservationAsync refused (concurrent newer writer)",
      lifecycleBefore,
      lifecycleAfter: lifecycleBefore,
    };
  }

  // 6. Newer observation with a status change. Compose atomically where possible.
  //    The CAS transition is the concurrency fence: two workers racing the same
  //    observation produce one transition and one duplicate-observed event.
  const transitioned = await input.store.transitionIncidentStatusIfCurrentAsync(
    incident.id,
    lifecycleBefore,
    input.nextStatus,
    { last_observation_at: input.observedAt },
  );

  if (!transitioned) {
    // Another worker won the race, or the status changed underfoot.
    const after = await input.store.getIncidentAsync(incident.id);
    return {
      outcome: "STALE_REJECTED",
      reason: "concurrent transition won the CAS; observation not applied",
      lifecycleBefore,
      lifecycleAfter: after?.status ?? lifecycleBefore,
    };
  }

  const ev = await input.store.appendIncidentTimelineAsync(incident.id, {
    type: "CONVERGENCE_TRANSITIONED",
    at: input.observedAt,
    payload: {
      classification: input.classification,
      observed_at: input.observedAt,
      from: lifecycleBefore,
      to: input.nextStatus,
      worker_id: input.workerId,
    },
  }).catch(() => ({ inserted: false, seq: null }));

  const refreshed = await input.store.getIncidentAsync(incident.id);
  return {
    outcome: ev.inserted ? "APPLIED" : "DUPLICATE",
    reason: ev.inserted
      ? "newer observation applied; status " + lifecycleBefore + " -> " + input.nextStatus
      : "transition applied but timeline event already existed",
    lifecycleBefore,
    lifecycleAfter: refreshed?.status ?? input.nextStatus,
  };
}

// -----------------------------------------------------------------------------
// Recovery intent supersession
// -----------------------------------------------------------------------------

export interface SupersedeIntentInput {
  store: AsyncIncidentStore;
  incidentId: string;
  /** The recovery_intent_key that should no longer be considered valid. */
  supersededIntentKey: string;
  /** Reason for supersession, recorded in evidence. */
  reason: string;
  workerId: string;
  now?: number;
}

export interface SupersedeIntentResult {
  superseded: boolean;
  reason: string;
  lifecycleAfter: IncidentLifecycleStatus | null;
}

/**
 * Clear an incident's recovery intent binding when a newer authoritative
 * observation has invalidated it. The CAS is guarded on the intent key:
 * if the incident no longer carries the superseded key (already reconciled
 * or replaced), this is a no-op. Only transitions RECOVERY_REQUESTED back
 * to REQUIRE_REVIEW; never executes any recovery.
 */
export async function supersedeRecoveryIntentAsync(
  input: SupersedeIntentInput,
): Promise<SupersedeIntentResult> {
  const nowIso = new Date(input.now ?? Date.now()).toISOString();
  const incident = await input.store.getIncidentAsync(input.incidentId);
  if (!incident) {
    return { superseded: false, reason: "incident not found", lifecycleAfter: null };
  }

  if (incident.recovery_intent_key !== input.supersededIntentKey) {
    return {
      superseded: false,
      reason: "incident no longer carries the superseded intent key",
      lifecycleAfter: incident.status,
    };
  }

  // Clear the key and, if we were RECOVERY_REQUESTED, move to REQUIRE_REVIEW
  // using the CAS primitive so concurrent callers cannot both transition.
  const fromStatus = incident.status;
  const toStatus: IncidentLifecycleStatus =
    fromStatus === "RECOVERY_REQUESTED" ? "REQUIRE_REVIEW" : fromStatus;

  let transitioned = false;
  if (toStatus !== fromStatus) {
    transitioned = await input.store.transitionIncidentStatusIfCurrentAsync(
      incident.id,
      fromStatus,
      toStatus,
      { recovery_intent_key: null as any },
    );
  } else {
    transitioned = await input.store.updateIncidentAsync(incident.id, {
      recovery_intent_key: null as any,
    });
  }

  if (!transitioned) {
    const after = await input.store.getIncidentAsync(incident.id);
    return {
      superseded: false,
      reason: "CAS refused; intent key changed concurrently or status moved",
      lifecycleAfter: after?.status ?? fromStatus,
    };
  }

  await input.store.appendIncidentTimelineAsync(incident.id, {
    type: "CONVERGENCE_INTENT_SUPERSEDED",
    at: nowIso,
    payload: {
      superseded_intent_key: input.supersededIntentKey,
      reason: input.reason,
      from: fromStatus,
      to: toStatus,
      worker_id: input.workerId,
    },
  }).catch(() => undefined);

  const refreshed = await input.store.getIncidentAsync(incident.id);
  return {
    superseded: true,
    reason: input.reason,
    lifecycleAfter: refreshed?.status ?? toStatus,
  };
}

// -----------------------------------------------------------------------------
// Deployment identity binding assertion
// -----------------------------------------------------------------------------

export interface BindingAssertion {
  ok: boolean;
  reason: string;
}

/**
 * Assert that a proposed recovery action targets the incident's current
 * deployment binding. Fails closed when the incident's deployment_id differs
 * from the proposed target - this is the guard against recovery intent drift
 * onto a replacement deployment.
 */
export function assertDeploymentBinding(
  incident: SecurityIncident,
  proposedDeploymentId: string,
): BindingAssertion {
  if (!incident.deployment_id) {
    return { ok: false, reason: "incident has no authoritative deployment_id" };
  }
  if (incident.deployment_id !== proposedDeploymentId) {
    return {
      ok: false,
      reason:
        "proposed deployment_id does not match incident binding: " +
        "incident=" + incident.deployment_id + " proposed=" + proposedDeploymentId,
    };
  }
  return { ok: true, reason: "deployment identity binding holds" };
}